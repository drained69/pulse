import { decodeEventLog, getAddress, toEventSelector } from "viem";
import { SUBSCRIBED_EVENT, hexToNum, numToHex, type RpcLog } from "./chain.ts";
import type { Config, Plan } from "./config.ts";
import { type Db, kvGet, kvSet, tx } from "./db.ts";
import type { RpcPool } from "./rpc.ts";
import { errMsg, log, newId, nowSec } from "./util.ts";

export const monthKey = (d = new Date()): string => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

export type UserRow = { id: string; address: string; qie_name: string | null; plan: string; plan_expires_at: number | null; created_at: number };

export function planFor(cfg: Config, user: Pick<UserRow, "plan" | "plan_expires_at">): Plan {
  if (user.plan === "pro" && (user.plan_expires_at ?? 0) > nowSec()) return cfg.plans.pro;
  if (user.plan === "system") return { ...cfg.plans.pro, id: "pro", label: "System", monthlyEvents: Number.MAX_SAFE_INTEGER };
  return cfg.plans.free;
}

export function usageThisMonth(db: Db, userId: string): number {
  const row = db.prepare("SELECT events FROM usage WHERE user_id = ? AND month = ?").get(userId, monthKey()) as { events: number } | undefined;
  return row?.events ?? 0;
}

/** Count one event against the monthly quota. Returns false when the quota is used up. */
export function consumeQuota(db: Db, cfg: Config, userId: string): boolean {
  const user = db.prepare("SELECT plan, plan_expires_at FROM users WHERE id = ?").get(userId) as UserRow | undefined;
  if (!user) return false;
  const plan = planFor(cfg, user);
  const used = usageThisMonth(db, userId);
  if (used >= plan.monthlyEvents) return false;
  db.prepare("INSERT INTO usage (user_id, month, events) VALUES (?, ?, 1) ON CONFLICT(user_id, month) DO UPDATE SET events = events + 1").run(userId, monthKey());
  return true;
}

export function ensureUser(db: Db, address: string): UserRow {
  const addr = getAddress(address);
  const existing = db.prepare("SELECT * FROM users WHERE address = ?").get(addr) as UserRow | undefined;
  if (existing) return existing;
  const row: UserRow = { id: newId("usr"), address: addr, qie_name: null, plan: "free", plan_expires_at: null, created_at: nowSec() };
  db.prepare("INSERT INTO users (id, address, qie_name, plan, plan_expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    row.id,
    row.address,
    row.qie_name,
    row.plan,
    row.plan_expires_at,
    row.created_at,
  );
  return row;
}

/**
 * Apply a `Subscribed` event from the QPulseBilling contract. The event's
 * `paidUntil` is authoritative: it is the contract's own record of the paid period.
 */
export function applySubscriptionLog(db: Db, l: RpcLog): { address: string; paidUntil: number } | null {
  let args: { account: `0x${string}`; planId: number; periods: number; amount: bigint; paidUntil: bigint };
  try {
    args = decodeEventLog({ abi: [SUBSCRIBED_EVENT], data: l.data, topics: l.topics as [`0x${string}`, ...`0x${string}`[]] }).args as typeof args;
  } catch {
    return null;
  }
  const paidUntil = Number(args.paidUntil);
  const logIndex = hexToNum(l.logIndex);
  return tx(db, () => {
    const inserted = db
      .prepare(
        `INSERT OR IGNORE INTO subscriptions (tx_hash, log_index, address, plan_id, periods, amount, paid_until, block_number, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(l.transactionHash, logIndex, getAddress(args.account), args.planId, args.periods, args.amount.toString(), paidUntil, hexToNum(l.blockNumber), nowSec());
    if (inserted.changes === 0) return null;
    const user = ensureUser(db, args.account);
    db.prepare("UPDATE users SET plan = 'pro', plan_expires_at = MAX(COALESCE(plan_expires_at, 0), ?) WHERE id = ?").run(paidUntil, user.id);
    log.info("subscription applied", { address: user.address, paidUntil });
    return { address: user.address, paidUntil };
  });
}

const BILLING_SCANNED_KEY = "billing_scanned_to";
const BILLING_CHUNK = 5000;

/**
 * Catch up on `Subscribed` events from BILLING_START_BLOCK (the contract's deploy block) to the
 * chain head. The live indexer only reads from where it started, so without this a payment made
 * before the server's first start would never unlock Pro. Safe to repeat: events are applied
 * once per (tx, log index), and progress is saved after each chunk.
 */
export async function backfillSubscriptions(cfg: Config, db: Db, rpc: RpcPool): Promise<number> {
  if (!cfg.billingContract || !/^\d+$/.test(cfg.billingStartBlock)) return 0;
  const done = kvGet(db, BILLING_SCANNED_KEY);
  let from = Math.max(Number(cfg.billingStartBlock), done === null ? 0 : Number(done) + 1);
  const head = hexToNum(await rpc.call<string>("eth_blockNumber"));
  let applied = 0;
  while (from <= head) {
    const to = Math.min(head, from + BILLING_CHUNK - 1);
    const logs = await rpc.call<RpcLog[]>("eth_getLogs", [
      { fromBlock: numToHex(from), toBlock: numToHex(to), address: cfg.billingContract, topics: [toEventSelector(SUBSCRIBED_EVENT)] },
    ]);
    for (const l of logs) if (applySubscriptionLog(db, l)) applied++;
    kvSet(db, BILLING_SCANNED_KEY, String(to));
    from = to + 1;
  }
  if (applied) log.info("billing history imported", { applied, through: head });
  return applied;
}

/** Run the catch-up in the background, retrying a few times if the RPC is flaky. */
export function startBillingBackfill(cfg: Config, db: Db, rpc: RpcPool): void {
  void (async () => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        await backfillSubscriptions(cfg, db, rpc);
        return;
      } catch (e) {
        log.warn("billing history import failed", { attempt, error: errMsg(e) });
        await new Promise((r) => setTimeout(r, attempt * 10_000).unref());
      }
    }
  })();
}
