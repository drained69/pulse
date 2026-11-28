import { decodeFunctionResult, encodeFunctionData, formatUnits, getAddress, parseUnits } from "viem";
import { ERC20_ABI, NATIVE_TOKEN, type TokenInfo } from "./chain.ts";
import { backupDatabase } from "./backup.ts";
import type { Config } from "./config.ts";
import { tx, type Db } from "./db.ts";
import type { HookService } from "./hooks.ts";
import { OracleService } from "./oracles.ts";
import type { NameResolver } from "./names.ts";
import { amount, scheduledPayload, type EventPayload } from "./payload.ts";
import type { RpcPool } from "./rpc.ts";
import type { TokenService } from "./tokens.ts";
import { SCHEDULED_TYPES, tokenAddressFor, triggerSchemas, type HookRow, type Resolved } from "./triggers.ts";
import { errMsg, log, nowSec, shortAddr, sleep } from "./util.ts";

type State = { armed?: boolean; lastFiredAt?: number; value?: string | null; lastDay?: string };

/**
 * Timer-driven triggers. Threshold triggers fire once when the condition
 * becomes true (including right after the hook is created, if it is already
 * true) and re-arm when it becomes false again, so a low balance does not
 * page you every minute.
 */
export class Checks {
  private cfg: Config;
  private db: Db;
  private rpc: RpcPool;
  private hooks: HookService;
  private names: NameResolver;
  private tokens: TokenService;
  private oracles: OracleService;
  private stopped = false;
  lastRunAt: number | null = null;

  constructor(cfg: Config, db: Db, rpc: RpcPool, hooks: HookService, names: NameResolver, tokens: TokenService, oracles = new OracleService(cfg, rpc)) {
    this.cfg = cfg;
    this.db = db;
    this.rpc = rpc;
    this.hooks = hooks;
    this.names = names;
    this.tokens = tokens;
    this.oracles = oracles;
  }

  private getState(hookId: string): State | null {
    const row = this.db.prepare("SELECT state FROM trigger_state WHERE hook_id = ?").get(hookId) as { state: string } | undefined;
    return row ? (JSON.parse(row.state) as State) : null;
  }

  private setState(hookId: string, st: State): void {
    this.db
      .prepare("INSERT INTO trigger_state (hook_id, state, updated_at) VALUES (?, ?, ?) ON CONFLICT(hook_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at")
      .run(hookId, JSON.stringify(st), nowSec());
  }

  private fire(hook: HookRow, payload: EventPayload): void {
    this.hooks.recordEvent(hook, `${payload.type}:${payload.id}`, payload);
  }

  /** Ignore a snapshot changed or deleted while a remote read was in flight. */
  private isCurrent(hook: HookRow): boolean {
    const current = this.db.prepare("SELECT active, trigger_type, trigger_config, resolved FROM hooks WHERE id = ?").get(hook.id) as Pick<HookRow, "active" | "trigger_type" | "trigger_config" | "resolved"> | undefined;
    return Boolean(current?.active && current.trigger_type === hook.trigger_type && current.trigger_config === hook.trigger_config && current.resolved === hook.resolved);
  }

  /** Edge-triggered threshold: event, outbox and armed state commit together. */
  private threshold(hook: HookRow, condition: boolean, build: () => EventPayload, value: string): boolean {
    return tx(this.db, () => {
      if (!this.isCurrent(hook)) return false;
      const st = this.getState(hook.id) ?? { armed: true };
      let fired = false;
      if (condition && st.armed !== false) {
        this.fire(hook, build());
        st.armed = false;
        st.lastFiredAt = nowSec();
        fired = true;
      } else if (!condition) {
        st.armed = true;
      }
      st.value = value;
      this.setState(hook.id, st);
      return fired;
    });
  }

  async runOnce(now = new Date()): Promise<number> {
    const rows = this.db
      .prepare(`SELECT * FROM hooks WHERE active = 1 AND trigger_type IN (${SCHEDULED_TYPES.map(() => "?").join(",")})`)
      .all(...SCHEDULED_TYPES) as HookRow[];
    let fired = 0;
    const by = (t: string) => rows.filter((r) => r.trigger_type === t);
    const ctx = { chainId: this.cfg.chainId, network: this.cfg.network };

    // ── balances: one batch for all hooks ──
    const balances = by("balance");
    if (balances.length) {
      const items = await Promise.all(
        balances.map(async (h) => {
          const c = triggerSchemas.balance.parse(JSON.parse(h.trigger_config));
          const addr = getAddress(((JSON.parse(h.resolved || "{}") as Resolved).address ?? c.address) as string);
          const tokenAddr = tokenAddressFor(c.asset);
          const token: TokenInfo = tokenAddr === null ? NATIVE_TOKEN : await this.tokens.token(tokenAddr);
          return { h, c, addr, token };
        }),
      );
      try {
        const results = await this.rpc.batch<string>(
          items.map((i) =>
            i.token.address === null
              ? { method: "eth_getBalance", params: [i.addr, "latest"] }
              : { method: "eth_call", params: [{ to: i.token.address, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "balanceOf", args: [i.addr] }) }, "latest"] },
          ),
        );
        for (const [k, i] of items.entries()) {
          const raw = i.token.address === null ? BigInt(results[k]!) : decodeFunctionResult({ abi: ERC20_ABI, functionName: "balanceOf", data: results[k] as `0x${string}` });
          const below = i.c.below !== undefined;
          const limit = parseUnits((i.c.below ?? i.c.above)!, i.token.decimals);
          const condition = below ? raw < limit : raw > limit;
          const name = (i.c.address as string).toLowerCase().endsWith(".qie") ? (i.c.address as string).toLowerCase() : null;
          const didFire = this.threshold(
            i.h,
            condition,
            () =>
              scheduledPayload(
                { id: i.h.id, name: i.h.name },
                "balance.threshold",
                {
                  wallet: { address: i.addr, name },
                  symbol: i.token.symbol,
                  token: { address: i.token.address, symbol: i.token.symbol, decimals: i.token.decimals },
                  direction: below ? "below" : "above",
                  threshold: i.c.below ?? i.c.above,
                  balance: amount(raw, i.token, this.tokens.priceUsd(i.token.address)),
                },
                ctx,
                `${this.cfg.explorerUrl}/address/${i.addr}`,
              ),
            raw.toString(),
          );
          if (didFire) fired++;
        }
      } catch (e) {
        log.warn("balance checks failed", { error: errMsg(e) });
      }
    }

    // ── prices from QIEDEX ──
    const prices = by("price");
    if (prices.length) {
      await this.tokens.refreshPairs();
      for (const h of prices) {
        const c = triggerSchemas.price.parse(JSON.parse(h.trigger_config));
        const tokenAddr = tokenAddressFor(c.token);
        const price = this.tokens.priceUsd(tokenAddr);
        if (price === null) continue;
        const token = tokenAddr === null ? NATIVE_TOKEN : await this.tokens.token(tokenAddr);
        const below = c.below !== undefined;
        const limit = (c.below ?? c.above)!;
        const condition = below ? price < limit : price > limit;
        const didFire = this.threshold(
          h,
          condition,
          () =>
            scheduledPayload(
              { id: h.id, name: h.name },
              "price.threshold",
              { symbol: token.symbol, token: { address: token.address, symbol: token.symbol }, direction: below ? "below" : "above", threshold: limit, priceUsd: price, source: "QIEDEX" },
              ctx,
              "https://www.dex.qie.digital/",
            ),
          String(price),
        );
        if (didFire) fired++;
      }
    }

    // ── oracle prices: independent of QIEDEX; missing data never changes armed state ──
    const oracleHooks = by("oracle_price");
    if (oracleHooks.length) {
      const readings = await this.oracles.prices();
      for (const h of oracleHooks) {
        const c = triggerSchemas.oracle_price.parse(JSON.parse(h.trigger_config));
        const reading = readings.find((r) => r.feed === c.feed);
        if (!reading || reading.price === null || reading.stale) continue;
        const below = c.below !== undefined;
        const limit = (c.below ?? c.above)!;
        if (this.threshold(
          h,
          below ? reading.price < limit : reading.price > limit,
          () => scheduledPayload(
            { id: h.id, name: h.name },
            "price.threshold",
            { symbol: c.feed, feed: c.feed, direction: below ? "below" : "above", threshold: limit, priceUsd: reading.price, source: "QIE Oracles", oracle: reading.address, updatedAt: reading.updatedAt },
            ctx,
            `${this.cfg.explorerUrl}/address/${reading.address}`,
          ),
          String(reading.price),
        )) fired++;
      }
    }

    // ── QIE ID name changes ──
    for (const h of by("name_watch")) {
      const c = triggerSchemas.name_watch.parse(JSON.parse(h.trigger_config));
      let addr: string | null;
      try {
        addr = await this.names.resolve(c.name);
      } catch {
        continue; // resolver down: try next time, never alert on an outage
      }
      tx(this.db, () => {
        if (!this.isCurrent(h)) return;
        const st = this.getState(h.id);
        if (st && st.value !== addr) {
          this.fire(h, scheduledPayload({ id: h.id, name: h.name }, "name.changed", { name: c.name, from: st.value ?? null, to: addr }, ctx, addr ? `${this.cfg.explorerUrl}/address/${addr}` : undefined));
          fired++;
        }
        this.setState(h.id, { ...(st ?? {}), value: addr, lastFiredAt: st && st.value !== addr ? nowSec() : st?.lastFiredAt });
      });
    }

    // ── daily summaries ──
    const day = now.toISOString().slice(0, 10);
    for (const h of by("daily_digest")) {
      const c = triggerSchemas.daily_digest.parse(JSON.parse(h.trigger_config));
      // Due from hourUtc; catch up for up to 6 hours if the server was down at that hour.
      if ((now.getUTCHours() - c.hourUtc + 24) % 24 >= 6) continue;
      tx(this.db, () => {
        if (!this.isCurrent(h)) return;
        const st = this.getState(h.id) ?? {};
        if (st.lastDay === day) return;
        const src = this.db.prepare("SELECT id, name FROM hooks WHERE id = ? AND user_id = ?").get(c.sourceHookId, h.user_id) as { id: string; name: string } | undefined;
        if (src) {
          this.fire(h, scheduledPayload({ id: h.id, name: h.name }, "digest.daily", this.summarize(src, Math.floor(now.getTime() / 1000)), ctx));
          fired++;
        }
        this.setState(h.id, { ...st, lastDay: day });
      });
    }

    if (Date.now() - this.lastPruneAt > 3600_000) this.prune();
    try {
      const file = backupDatabase(this.db, this.cfg.backupDir, this.cfg.backupKeep, now);
      if (file) log.info("database backup written", { file });
    } catch (e) {
      log.warn("database backup failed", { error: errMsg(e) });
    }
    this.lastRunAt = Date.now();
    return fired;
  }

  private lastPruneAt = 0;

  /** Delete old events (deliveries cascade), expired sessions, nonces and link codes. */
  prune(nowS = nowSec()): { events: number } {
    const cutoff = nowS - this.cfg.eventRetentionDays * 86400;
    const events = Number(this.db.prepare("DELETE FROM events WHERE created_at < ?").run(cutoff).changes);
    this.db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(nowS);
    this.db.prepare("DELETE FROM auth_nonces WHERE expires_at < ?").run(nowS);
    this.db.prepare("DELETE FROM telegram_link_codes WHERE expires_at < ?").run(nowS);
    this.lastPruneAt = Date.now();
    if (events) log.info("pruned old events", { events, olderThanDays: this.cfg.eventRetentionDays });
    return { events };
  }

  /** Totals per token, event count and most frequent counterparties over the last 24 hours. */
  summarize(src: { id: string; name: string }, nowS: number): Record<string, unknown> {
    const rows = this.db.prepare("SELECT payload FROM events WHERE hook_id = ? AND created_at > ? AND event_type != 'test'").all(src.id, nowS - 86400) as {
      payload: string;
    }[];
    const totals = new Map<string, { symbol: string; decimals: number; raw: bigint }>();
    const parties = new Map<string, number>();
    for (const r of rows) {
      const d = (JSON.parse(r.payload) as EventPayload).data as Record<string, any>;
      const amt = d.amount ?? d.amountIn ?? d.balance;
      const tok = d.token ?? d.tokenIn;
      if (amt?.raw && tok) {
        const key = `${tok.symbol}:${tok.address ?? "native"}`;
        const t = totals.get(key) ?? { symbol: tok.symbol, decimals: tok.decimals ?? 18, raw: 0n };
        t.raw += BigInt(amt.raw);
        totals.set(key, t);
      }
      const who = d.from ?? d.trader;
      if (who?.address) {
        const label = who.name ?? shortAddr(who.address);
        parties.set(label, (parties.get(label) ?? 0) + 1);
      }
    }
    return {
      sourceHookId: src.id,
      sourceHookName: src.name,
      count: rows.length,
      periodHours: 24,
      totals: [...totals.values()].map((t) => {
        const f = formatUnits(t.raw, t.decimals);
        const [i, fr = ""] = f.split(".");
        const pretty = `${(i ?? "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${fr.slice(0, 4).replace(/0+$/, "") ? `.${fr.slice(0, 4).replace(/0+$/, "")}` : ""}`;
        return { symbol: t.symbol, raw: t.raw.toString(), formatted: f, display: `${pretty} ${t.symbol}` };
      }),
      top: [...parties.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([label, count]) => ({ label, count })),
    };
  }

  async run(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.runOnce();
      } catch (e) {
        log.error("scheduled checks failed", { error: errMsg(e) });
      }
      await sleep(this.cfg.checkIntervalMs);
    }
  }

  stop(): void {
    this.stopped = true;
  }
}
