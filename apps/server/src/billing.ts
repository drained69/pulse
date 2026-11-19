import { decodeEventLog, getAddress } from "viem";
import { SUBSCRIBED_EVENT, hexToNum, type RpcLog } from "./chain.ts";
import type { Config, Plan } from "./config.ts";
import { type Db, tx } from "./db.ts";
import { log, newId, nowSec } from "./util.ts";

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
 * Apply a `Subscribed` event from the QiePulseBilling contract. The event's
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
