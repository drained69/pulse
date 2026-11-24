import { getAddress, isAddress } from "viem";
import { consumeQuota, planFor, type UserRow } from "./billing.ts";
import type { Config } from "./config.ts";
import { type Db, tx } from "./db.ts";
import { looksLikeQieName, normalizeQieName, type NameResolver } from "./names.ts";
import type { EventPayload } from "./payload.ts";
import {
  CHANNEL_TYPES,
  HookIndex,
  TRIGGER_TYPES,
  channelSchemas,
  eventSignatures,
  parseEventSignature,
  triggerSchemas,
  type ChannelType,
  type HookRow,
  type Resolved,
  type TriggerType,
} from "./triggers.ts";
import { assertPublicUrl } from "./ssrf.ts";
import { errMsg, log, newId, nowSec, randomToken, toJson } from "./util.ts";

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type HookInput = {
  name: string;
  trigger: { type: TriggerType; config: Record<string, unknown> };
  channel: { type: ChannelType; config: Record<string, unknown> };
  active?: boolean;
};

export type PublicHook = {
  id: string;
  name: string;
  active: boolean;
  trigger: { type: TriggerType; config: Record<string, unknown>; resolved: Resolved };
  channel: { type: ChannelType; config: Record<string, unknown> };
  secret: string;
  fireCount: number;
  lastFiredAt: number | null;
  createdAt: number;
  stats?: { success: number; failed: number; pending: number };
};

export function toPublicHook(row: HookRow & { fire_count: number; last_fired_at: number | null; created_at: number }): PublicHook {
  return {
    id: row.id,
    name: row.name,
    active: Boolean(row.active),
    trigger: { type: row.trigger_type, config: JSON.parse(row.trigger_config), resolved: JSON.parse(row.resolved || "{}") },
    channel: { type: row.channel_type, config: JSON.parse(row.channel_config) },
    secret: row.secret,
    fireCount: row.fire_count,
    lastFiredAt: row.last_fired_at,
    createdAt: row.created_at,
  };
}

/** Hook CRUD, validation, `.qie` resolution, event fan-out and the in-memory index. */
export class HookService {
  private cfg: Config;
  private db: Db;
  private names: NameResolver;
  private index: HookIndex | null = null;
  onDeliveriesQueued: () => void = () => {};

  constructor(cfg: Config, db: Db, names: NameResolver) {
    this.cfg = cfg;
    this.db = db;
    this.names = names;
  }

  getIndex(): HookIndex {
    if (!this.index) {
      const rows = this.db.prepare("SELECT * FROM hooks WHERE active = 1").all() as HookRow[];
      this.index = HookIndex.build(rows);
      for (const e of this.index.errors) log.warn("hook skipped from index", e);
    }
    return this.index;
  }

  invalidate(): void {
    this.index = null;
  }

  private async resolveField(value: string | undefined, field: string): Promise<string | undefined> {
    if (!value) return undefined;
    if (isAddress(value)) return getAddress(value);
    if (!looksLikeQieName(value)) throw new HttpError(400, `${field}: must be an address or a name.qie`);
    const name = normalizeQieName(value);
    if (!name) throw new HttpError(400, `${field}: “${value}” is not a valid QIE ID`);
    let addr: string | null;
    try {
      addr = await this.names.resolve(name);
    } catch (e) {
      throw new HttpError(502, `Could not reach the QIE ID resolver: ${errMsg(e)}`);
    }
    if (!addr) throw new HttpError(400, `${field}: ${name} is not registered`);
    return addr;
  }

  async validate(input: HookInput, userId: string): Promise<{ trigger: Record<string, unknown>; resolved: Resolved; channel: Record<string, unknown> }> {
    if (!input || typeof input !== "object") throw new HttpError(400, "Body must be a JSON object");
    const name = String(input.name ?? "").trim();
    if (!name || name.length > 80) throw new HttpError(400, "name: 1–80 characters");
    if (!TRIGGER_TYPES.includes(input.trigger?.type)) throw new HttpError(400, `trigger.type must be one of ${TRIGGER_TYPES.join(", ")}`);
    if (!CHANNEL_TYPES.includes(input.channel?.type)) throw new HttpError(400, `channel.type must be one of ${CHANNEL_TYPES.join(", ")}`);

    const tParsed = triggerSchemas[input.trigger.type].safeParse(input.trigger.config ?? {});
    if (!tParsed.success) throw new HttpError(400, `trigger: ${tParsed.error.issues.map((i) => `${i.path.join(".") || "config"} ${i.message}`).join("; ")}`);
    const trigger = tParsed.data as Record<string, unknown>;

    const resolved: Resolved = {};
    if (input.trigger.type === "payment") resolved.recipient = await this.resolveField(trigger.recipient as string, "recipient");
    if (input.trigger.type === "token_transfer") {
      resolved.from = await this.resolveField(trigger.from as string | undefined, "from");
      resolved.to = await this.resolveField(trigger.to as string | undefined, "to");
    }
    if (input.trigger.type === "wallet" || input.trigger.type === "balance") {
      resolved.address = await this.resolveField(trigger.address as string, "address");
    }
    if (input.trigger.type === "name_watch") {
      const n = normalizeQieName(trigger.name as string);
      if (!n) throw new HttpError(400, "trigger.name: not a valid QIE ID");
      trigger.name = n;
    }
    if (input.trigger.type === "daily_digest") {
      const src = this.db.prepare("SELECT id, trigger_type FROM hooks WHERE id = ? AND user_id = ?").get(trigger.sourceHookId as string, userId) as
        | { id: string; trigger_type: string }
        | undefined;
      if (!src) throw new HttpError(400, "trigger.sourceHookId: choose one of your hooks");
      if (src.trigger_type === "daily_digest") throw new HttpError(400, "trigger.sourceHookId: a summary cannot summarise another summary");
    }
    if (input.trigger.type === "contract_event") {
      for (const sig of eventSignatures(trigger as { event?: string; events?: string[] })) {
        try {
          parseEventSignature(sig);
        } catch (e) {
          throw new HttpError(400, `trigger.event: “${sig.slice(0, 60)}” is not a valid Solidity event signature (${errMsg(e).split("\n")[0]})`);
        }
      }
    }

    const cParsed = channelSchemas[input.channel.type].safeParse(input.channel.config ?? {});
    if (!cParsed.success) throw new HttpError(400, `channel: ${cParsed.error.issues.map((i) => `${i.path.join(".") || "config"} ${i.message}`).join("; ")}`);
    const channel = cParsed.data as Record<string, unknown>;
    if (input.channel.type === "webhook") {
      try {
        await assertPublicUrl(channel.url as string, this.cfg.allowPrivateWebhooks);
      } catch (e) {
        throw new HttpError(400, `channel.url: ${errMsg(e)}`);
      }
    }
    if (input.channel.type === "telegram") {
      const ok = this.db.prepare("SELECT 1 FROM telegram_chats WHERE id = ? AND user_id = ?").get(channel.chatRef as string, userId);
      if (!ok) throw new HttpError(400, "channel.chatRef: link a Telegram chat first");
    }
    return { trigger, resolved, channel };
  }

  async create(user: UserRow, input: HookInput): Promise<PublicHook> {
    const plan = planFor(this.cfg, user);
    const count = (this.db.prepare("SELECT COUNT(*) AS n FROM hooks WHERE user_id = ?").get(user.id) as { n: number }).n;
    if (count >= plan.maxHooks) throw new HttpError(402, `Your ${plan.label} plan allows ${plan.maxHooks} hooks. Upgrade to Pro for more.`);
    const v = await this.validate(input, user.id);
    const id = newId("hk");
    const now = nowSec();
    tx(this.db, () => {
      const currentPlan = planFor(this.cfg, user);
      const currentCount = (this.db.prepare("SELECT COUNT(*) AS n FROM hooks WHERE user_id = ?").get(user.id) as { n: number }).n;
      if (currentCount >= currentPlan.maxHooks) throw new HttpError(402, `Your ${currentPlan.label} plan allows ${currentPlan.maxHooks} hooks. Upgrade to Pro for more.`);
      this.db
        .prepare(
          `INSERT INTO hooks (id, user_id, name, trigger_type, trigger_config, resolved, channel_type, channel_config, secret, active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          user.id,
          input.name.trim(),
          input.trigger.type,
          JSON.stringify(v.trigger),
          JSON.stringify(v.resolved),
          input.channel.type,
          JSON.stringify(v.channel),
          `whsec_${randomToken(24)}`,
          input.active === false ? 0 : 1,
          now,
          now,
        );
    });
    this.invalidate();
    return this.get(user.id, id);
  }

  async update(userId: string, id: string, input: Partial<HookInput>): Promise<PublicHook> {
    const current = this.get(userId, id);
    const merged: HookInput = {
      name: input.name ?? current.name,
      trigger: input.trigger ?? { type: current.trigger.type, config: current.trigger.config },
      channel: input.channel ?? { type: current.channel.type, config: current.channel.config },
      active: input.active ?? current.active,
    };
    const v = await this.validate(merged, userId);
    this.db
      .prepare(
        `UPDATE hooks SET name=?, trigger_type=?, trigger_config=?, resolved=?, channel_type=?, channel_config=?, active=?, updated_at=? WHERE id=? AND user_id=?`,
      )
      .run(
        merged.name.trim(),
        merged.trigger.type,
        JSON.stringify(v.trigger),
        JSON.stringify(v.resolved),
        merged.channel.type,
        JSON.stringify(v.channel),
        merged.active === false ? 0 : 1,
        nowSec(),
        id,
        userId,
      );
    this.invalidate();
    return this.get(userId, id);
  }

  get(userId: string, id: string): PublicHook {
    const row = this.db.prepare("SELECT * FROM hooks WHERE id = ? AND user_id = ?").get(id, userId) as Parameters<typeof toPublicHook>[0] | undefined;
    if (!row) throw new HttpError(404, "Hook not found");
    const hook = toPublicHook(row);
    hook.stats = this.stats(id);
    return hook;
  }

  list(userId: string): PublicHook[] {
    const rows = this.db.prepare("SELECT * FROM hooks WHERE user_id = ? ORDER BY created_at DESC").all(userId) as Parameters<typeof toPublicHook>[0][];
    return rows.map((r) => ({ ...toPublicHook(r), stats: this.stats(r.id) }));
  }

  private stats(hookId: string): { success: number; failed: number; pending: number } {
    const rows = this.db.prepare("SELECT status, COUNT(*) AS n FROM deliveries WHERE hook_id = ? GROUP BY status").all(hookId) as { status: string; n: number }[];
    const s = { success: 0, failed: 0, pending: 0 };
    for (const r of rows) if (r.status in s) s[r.status as keyof typeof s] = r.n;
    return s;
  }

  remove(userId: string, id: string): void {
    const r = this.db.prepare("DELETE FROM hooks WHERE id = ? AND user_id = ?").run(id, userId);
    if (r.changes === 0) throw new HttpError(404, "Hook not found");
    this.invalidate();
  }

  rotateSecret(userId: string, id: string): PublicHook {
    const r = this.db.prepare("UPDATE hooks SET secret = ?, updated_at = ? WHERE id = ? AND user_id = ?").run(`whsec_${randomToken(24)}`, nowSec(), id, userId);
    if (r.changes === 0) throw new HttpError(404, "Hook not found");
    this.invalidate();
    return this.get(userId, id);
  }

  /**
   * Store an event and queue its delivery. Idempotent on (hook, dedupeKey), so
   * re-processing a block range never double-delivers. Returns false if it was a duplicate.
   */
  recordEvent(hook: { id: string; user_id: string }, dedupeKey: string, payload: EventPayload, opts: { quota?: boolean } = {}): boolean {
    const queued = tx(this.db, () => {
      const ins = this.db
        .prepare(
          `INSERT OR IGNORE INTO events (id, hook_id, dedupe_key, event_type, payload, block_number, tx_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(payload.id, hook.id, dedupeKey, payload.type, toJson(payload), payload.tx?.blockNumber ?? null, payload.tx?.hash ?? null, nowSec());
      if (ins.changes === 0) return false;
      const allowed = opts.quota === false ? true : consumeQuota(this.db, this.cfg, hook.user_id);
      this.db
        .prepare(
          `INSERT INTO deliveries (id, event_id, hook_id, status, attempts, next_attempt_at, last_error, created_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
        )
        .run(newId("dlv"), payload.id, hook.id, allowed ? "pending" : "skipped", nowSec(), allowed ? null : "Monthly event quota reached", nowSec());
      this.db.prepare("UPDATE hooks SET fire_count = fire_count + 1, last_fired_at = ? WHERE id = ?").run(nowSec(), hook.id);
      return true;
    });
    if (queued) this.onDeliveriesQueued();
    return queued;
  }

  /** Re-resolve `.qie` names (owners can repoint a name). Rebuilds the index when anything changed. */
  async refreshNames(): Promise<number> {
    const rows = this.db
      .prepare("SELECT id, trigger_type, trigger_config, resolved FROM hooks WHERE trigger_type IN ('payment','token_transfer','wallet','balance')")
      .all() as Pick<HookRow, "id" | "trigger_type" | "trigger_config" | "resolved">[];
    let changed = 0;
    for (const r of rows) {
      const c = JSON.parse(r.trigger_config) as Record<string, string | undefined>;
      const fields = r.trigger_type === "payment" ? ["recipient"] : r.trigger_type === "token_transfer" ? ["from", "to"] : ["address"];
      const resolved = JSON.parse(r.resolved || "{}") as Record<string, string | undefined>;
      let dirty = false;
      for (const f of fields) {
        const v = c[f];
        if (!v || !looksLikeQieName(v)) continue;
        try {
          const addr = await this.names.resolve(v);
          if (addr && addr !== resolved[f]) {
            log.info("qie name now points elsewhere", { hook: r.id, name: v, from: resolved[f], to: addr });
            resolved[f] = addr;
            dirty = true;
          }
        } catch {
          /* keep the last known address */
        }
      }
      if (dirty) {
        this.db.prepare("UPDATE hooks SET resolved = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(resolved), nowSec(), r.id);
        changed++;
      }
    }
    if (changed) this.invalidate();
    return changed;
  }
}
