import { formatUnits, getAddress, isAddress, parseUnits } from "viem";
import { QIE_MAINNET, TOPIC, type RpcLog, type RpcTx } from "./chain.ts";
import type { Config } from "./config.ts";
import { type Db, tx } from "./db.ts";
import { HttpError, type HookService } from "./hooks.ts";
import { looksLikeQieName, normalizeQieName, type NameResolver } from "./names.ts";
import type { EventPayload } from "./payload.ts";
import type { TokenService } from "./tokens.ts";
import { errMsg, log, newId, nowSec, prettyAmount } from "./util.ts";

/**
 * Payment links: a hosted checkout page for a fixed amount of QUSDC, QIE or WQIE.
 *
 * QIE transfers carry no memo, so each open invoice for the same recipient and
 * token gets a slightly different amount (the base amount plus 0–999 millionths).
 * The payment is matched by recipient + token + exact amount. A payment that
 * arrives up to 24 h after the link expired is still credited: the customer paid.
 */

export const INVOICE_TOKENS = {
  QUSDC: { address: QIE_MAINNET.QUSDC as string, symbol: "QUSDC", decimals: 6 },
  QIE: { address: "native", symbol: "QIE", decimals: 18 },
  WQIE: { address: QIE_MAINNET.WQIE as string, symbol: "WQIE", decimals: 18 },
} as const;
type TokenKey = keyof typeof INVOICE_TOKENS;

const LATE_GRACE_SEC = 86400;
const MAX_OPEN_PER_USER = 500;

export type InvoiceRow = {
  id: string;
  user_id: string;
  recipient: string;
  recipient_name: string | null;
  token: string;
  symbol: string;
  decimals: number;
  amount_raw: string;
  base_amount_raw: string;
  description: string;
  metadata: string;
  success_url: string | null;
  status: "open" | "paid" | "expired" | "cancelled";
  expires_at: number;
  created_at: number;
  paid_at: number | null;
  paid_tx: string | null;
  paid_from: string | null;
  paid_amount_raw: string | null;
  paid_block: number | null;
};

export type InvoiceInput = {
  amount?: unknown;
  token?: unknown;
  description?: unknown;
  recipient?: unknown;
  expiresInMinutes?: unknown;
  metadata?: unknown;
  successUrl?: unknown;
};

/** Effective status: an open link past its expiry reads as expired. */
function statusOf(r: InvoiceRow, now = nowSec()): InvoiceRow["status"] {
  return r.status === "open" && r.expires_at <= now ? "expired" : r.status;
}

/**
 * A transfer mined before a link existed can't pay it. Matters when blocks are replayed after a
 * restart: an old payment must not settle a newer link that happens to reuse the same amount.
 * Two minutes of slack covers clock skew between this server and the chain.
 */
function notBefore(inv: { created_at: number }, blockTs: number | null): boolean {
  return blockTs === null || blockTs >= inv.created_at - 120;
}

export class InvoiceService {
  private cfg: Config;
  private db: Db;
  private hooks: HookService;
  private names: NameResolver;
  private tokens: TokenService;
  private cache: { at: number; byRecipient: Map<string, InvoiceRow[]> } | null = null;

  constructor(cfg: Config, db: Db, hooks: HookService, names: NameResolver, tokens: TokenService) {
    this.cfg = cfg;
    this.db = db;
    this.hooks = hooks;
    this.names = names;
    this.tokens = tokens;
  }

  url(id: string): string {
    return `${this.cfg.publicUrl.replace(/\/$/, "")}/#/pay/${id}`;
  }

  /** Public JSON for the checkout page and the API. */
  view(r: InvoiceRow, opts: { owner?: boolean } = {}) {
    const fmt = (raw: string) => formatUnits(BigInt(raw), r.decimals);
    const amount = fmt(r.amount_raw);
    const tokenAddress = r.token === "native" ? null : r.token;
    return {
      id: r.id,
      url: this.url(r.id),
      status: statusOf(r),
      description: r.description,
      recipient: { address: r.recipient, name: r.recipient_name },
      token: { symbol: r.symbol, address: tokenAddress, decimals: r.decimals },
      amount: { raw: r.amount_raw, formatted: amount, display: `${prettyAmount(amount)} ${r.symbol}` },
      baseAmount: { raw: r.base_amount_raw, formatted: fmt(r.base_amount_raw) },
      expiresAt: r.expires_at,
      createdAt: r.created_at,
      successUrl: r.success_url,
      payment: r.paid_tx
        ? {
            txHash: r.paid_tx,
            from: r.paid_from,
            blockNumber: r.paid_block,
            paidAt: r.paid_at,
            late: r.paid_at !== null && r.paid_at > r.expires_at,
            explorerUrl: `${this.cfg.explorerUrl}/tx/${r.paid_tx}`,
          }
        : null,
      ...(opts.owner ? { metadata: JSON.parse(r.metadata) as Record<string, unknown> } : {}),
      chainId: this.cfg.chainId,
    };
  }

  private async resolveRecipient(input: unknown, fallback: string): Promise<{ address: string; name: string | null }> {
    const raw = String(input ?? "").trim();
    if (!raw) {
      const name = await this.names.reverse(fallback).catch(() => null);
      return { address: getAddress(fallback), name };
    }
    if (isAddress(raw)) return { address: getAddress(raw), name: null };
    if (looksLikeQieName(raw)) {
      const name = normalizeQieName(raw)!;
      let addr: string | null;
      try {
        addr = await this.names.resolve(name);
      } catch (e) {
        throw new HttpError(502, `Could not reach the QIE ID resolver: ${errMsg(e)}`);
      }
      if (!addr) throw new HttpError(400, `recipient: ${name} is not registered`);
      return { address: getAddress(addr), name };
    }
    throw new HttpError(400, "recipient: a 0x address or name.qie");
  }

  async create(user: { id: string; address: string }, input: InvoiceInput) {
    if (!input || typeof input !== "object") throw new HttpError(400, "Body must be a JSON object");
    const tokenKey = String(input.token ?? "QUSDC").toUpperCase() as TokenKey;
    const t = INVOICE_TOKENS[tokenKey];
    if (!t) throw new HttpError(400, "token: QUSDC, QIE or WQIE");
    const amountStr = String(input.amount ?? "").trim();
    if (!/^\d+(\.\d+)?$/.test(amountStr)) throw new HttpError(400, "amount: a positive number, e.g. 25 or 9.99");
    if ((amountStr.split(".")[1]?.length ?? 0) > 6) throw new HttpError(400, "amount: at most 6 decimal places");
    const base = parseUnits(amountStr, t.decimals);
    if (base <= 0n || base > parseUnits("1000000000", t.decimals)) throw new HttpError(400, "amount: must be between 0 and 1,000,000,000");
    const description = String(input.description ?? "").trim();
    if (description.length > 200) throw new HttpError(400, "description: at most 200 characters");
    const minutes = input.expiresInMinutes === undefined ? 60 : Number(input.expiresInMinutes);
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 60 * 24 * 30) throw new HttpError(400, "expiresInMinutes: 5 to 43200 (30 days)");
    let metadata = "{}";
    if (input.metadata !== undefined) {
      if (typeof input.metadata !== "object" || input.metadata === null || Array.isArray(input.metadata)) throw new HttpError(400, "metadata: a JSON object");
      metadata = JSON.stringify(input.metadata);
      if (metadata.length > 2000) throw new HttpError(400, "metadata: at most 2 KB");
    }
    let successUrl: string | null = null;
    if (input.successUrl !== undefined && input.successUrl !== null && input.successUrl !== "") {
      try {
        const u = new URL(String(input.successUrl));
        if (u.protocol !== "https:" && !(u.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/.test(u.hostname))) throw new Error();
        successUrl = u.toString();
      } catch {
        throw new HttpError(400, "successUrl: an https URL");
      }
      if (successUrl.length > 500) throw new HttpError(400, "successUrl: too long");
    }
    const recipient = await this.resolveRecipient(input.recipient, user.address);
    const now = nowSec();

    const row = tx(this.db, () => {
      const open = (this.db.prepare("SELECT COUNT(*) AS n FROM invoices WHERE user_id = ? AND status = 'open' AND expires_at > ?").get(user.id, now) as { n: number }).n;
      if (open >= MAX_OPEN_PER_USER) throw new HttpError(429, `At most ${MAX_OPEN_PER_USER} open payment links. Cancel some or let them expire.`);
      // Amounts already claimed by links that a payment could still be matched to.
      const taken = new Set(
        (
          this.db
            .prepare("SELECT amount_raw FROM invoices WHERE recipient = ? AND token = ? AND status IN ('open','expired') AND expires_at > ?")
            .all(recipient.address, t.address, now - LATE_GRACE_SEC) as { amount_raw: string }[]
        ).map((r) => r.amount_raw),
      );
      const step = 10n ** BigInt(t.decimals - 6); // one millionth of a token
      let amountRaw: bigint | null = null;
      for (let k = 0n; k < 1000n; k++) {
        const candidate = base + k * step;
        if (!taken.has(candidate.toString())) {
          amountRaw = candidate;
          break;
        }
      }
      if (amountRaw === null) throw new HttpError(429, "Too many open links for this amount. Try again shortly.");
      const r: InvoiceRow = {
        id: newId("inv", 10),
        user_id: user.id,
        recipient: recipient.address,
        recipient_name: recipient.name,
        token: t.address,
        symbol: t.symbol,
        decimals: t.decimals,
        amount_raw: amountRaw.toString(),
        base_amount_raw: base.toString(),
        description,
        metadata,
        success_url: successUrl,
        status: "open",
        expires_at: now + minutes * 60,
        created_at: now,
        paid_at: null,
        paid_tx: null,
        paid_from: null,
        paid_amount_raw: null,
        paid_block: null,
      };
      this.db
        .prepare(
          `INSERT INTO invoices (id, user_id, recipient, recipient_name, token, symbol, decimals, amount_raw, base_amount_raw, description, metadata, success_url, status, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
        )
        .run(r.id, r.user_id, r.recipient, r.recipient_name, r.token, r.symbol, r.decimals, r.amount_raw, r.base_amount_raw, r.description, r.metadata, r.success_url, r.expires_at, r.created_at);
      return r;
    });
    this.cache = null;
    return this.view(row, { owner: true });
  }

  getPublic(id: string) {
    const r = this.db.prepare("SELECT * FROM invoices WHERE id = ?").get(id) as InvoiceRow | undefined;
    if (!r) throw new HttpError(404, "Payment link not found");
    return this.view(r);
  }

  get(userId: string, id: string) {
    const r = this.db.prepare("SELECT * FROM invoices WHERE id = ? AND user_id = ?").get(id, userId) as InvoiceRow | undefined;
    if (!r) throw new HttpError(404, "Payment link not found");
    return this.view(r, { owner: true });
  }

  list(userId: string, opts: { status?: string; limit?: number } = {}) {
    const limit = Math.min(Math.max(Math.floor(opts.limit ?? 50) || 50, 1), 200);
    const rows = this.db.prepare("SELECT * FROM invoices WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(userId, limit) as InvoiceRow[];
    const out = rows.map((r) => this.view(r, { owner: true }));
    return opts.status ? out.filter((i) => i.status === opts.status) : out;
  }

  cancel(userId: string, id: string) {
    const r = this.db.prepare("SELECT * FROM invoices WHERE id = ? AND user_id = ?").get(id, userId) as InvoiceRow | undefined;
    if (!r) throw new HttpError(404, "Payment link not found");
    if (r.status !== "open") throw new HttpError(409, `This link is already ${statusOf(r)}`);
    this.db.prepare("UPDATE invoices SET status = 'cancelled' WHERE id = ? AND status = 'open'").run(id);
    this.cache = null;
    return this.get(userId, id);
  }

  stats(userId: string) {
    return this.db
      .prepare(
        `SELECT symbol, COUNT(*) AS paid, SUM(CAST(paid_amount_raw AS REAL)) AS total, decimals FROM invoices
         WHERE user_id = ? AND status = 'paid' GROUP BY symbol, decimals`,
      )
      .all(userId) as { symbol: string; paid: number; total: number; decimals: number }[];
  }

  // ───────── matching (called by the indexer) ─────────

  /** Recipients (lowercase) with links a payment can still be matched to. Cached for a few seconds. */
  watched(now = nowSec()): Map<string, InvoiceRow[]> {
    if (this.cache && this.cache.at > Date.now() - 3000) return this.cache.byRecipient;
    const rows = this.db
      .prepare("SELECT * FROM invoices WHERE status IN ('open','expired') AND expires_at > ?")
      .all(now - LATE_GRACE_SEC) as InvoiceRow[];
    const m = new Map<string, InvoiceRow[]>();
    for (const r of rows) {
      const k = r.recipient.toLowerCase();
      m.set(k, [...(m.get(k) ?? []), r]);
    }
    this.cache = { at: Date.now(), byRecipient: m };
    return m;
  }

  needsNative(): boolean {
    for (const list of this.watched().values()) if (list.some((r) => r.token === "native")) return true;
    return false;
  }

  /** An ERC-20 Transfer log. Returns the paid invoice id, if any. */
  async matchLog(l: RpcLog, ts: number | null): Promise<string | null> {
    if (l.topics[0] !== TOPIC.TRANSFER || l.topics.length !== 3) return null;
    const to = `0x${l.topics[2]!.slice(26)}`.toLowerCase();
    const list = this.watched().get(to);
    if (!list) return null;
    const value = BigInt(l.data === "0x" ? 0 : l.data).toString();
    const inv = list.find((r) => r.token.toLowerCase() === l.address.toLowerCase() && r.amount_raw === value && notBefore(r, ts));
    if (!inv) return null;
    const from = getAddress(`0x${l.topics[1]!.slice(26)}`);
    return (await this.markPaid(inv, l.transactionHash, from, value, Number(BigInt(l.blockNumber)), ts)) ? inv.id : null;
  }

  /** Is this successful native transfer a candidate? (Cheap check before fetching the receipt.) */
  nativeCandidate(t: RpcTx): boolean {
    if (!t.to || BigInt(t.value ?? "0x0") === 0n) return false;
    return Boolean(this.watched().get(t.to.toLowerCase())?.some((r) => r.token === "native"));
  }

  async matchNative(t: RpcTx, ts: number | null): Promise<string | null> {
    if (!t.to) return null;
    const value = BigInt(t.value).toString();
    const inv = this.watched().get(t.to.toLowerCase())?.find((r) => r.token === "native" && r.amount_raw === value && notBefore(r, ts));
    if (!inv) return null;
    return (await this.markPaid(inv, t.hash, getAddress(t.from), value, Number(BigInt(t.blockNumber)), ts)) ? inv.id : null;
  }

  private async markPaid(inv: InvoiceRow, txHash: string, from: string, value: string, block: number, ts: number | null): Promise<boolean> {
    const paidAt = ts ?? nowSec();
    const changed = this.db
      .prepare(
        `UPDATE invoices SET status = 'paid', paid_at = ?, paid_tx = ?, paid_from = ?, paid_amount_raw = ?, paid_block = ?
         WHERE id = ? AND status IN ('open','expired')`,
      )
      .run(paidAt, txHash, from, value, block, inv.id).changes;
    this.cache = null;
    if (!changed) return false;
    log.info("payment link paid", { invoice: inv.id, tx: txHash });

    const fresh = this.db.prepare("SELECT * FROM invoices WHERE id = ?").get(inv.id) as InvoiceRow;
    const fromName = await Promise.race([this.names.reverse(from).catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), 1500).unref())]);
    const v = this.view(fresh, { owner: true });
    const priceUsd = this.tokens.priceUsd(fresh.token === "native" ? QIE_MAINNET.WQIE : fresh.token);
    const valueUsd = fresh.symbol === "QUSDC" ? Number(v.amount.formatted) : priceUsd === null ? null : Math.round(Number(v.amount.formatted) * priceUsd * 100) / 100;
    const hooks = this.db.prepare("SELECT id, user_id, name FROM hooks WHERE user_id = ? AND trigger_type = 'invoice' AND active = 1").all(fresh.user_id) as {
      id: string;
      user_id: string;
      name: string;
    }[];
    for (const h of hooks) {
      const payload: EventPayload = {
        id: newId("evt"),
        type: "invoice.paid",
        createdAt: new Date().toISOString(),
        hook: { id: h.id, name: h.name },
        chain: { id: this.cfg.chainId, network: this.cfg.network },
        tx: { hash: txHash, blockNumber: block, logIndex: null, timestamp: ts, explorerUrl: `${this.cfg.explorerUrl}/tx/${txHash}` },
        data: {
          invoice: { id: v.id, url: v.url, description: v.description, metadata: v.metadata, expiresAt: v.expiresAt, late: v.payment?.late ?? false },
          amount: { ...v.amount, symbol: fresh.symbol, valueUsd },
          token: v.token,
          from: { address: from, name: fromName },
          to: v.recipient,
        },
      };
      this.hooks.recordEvent(h, `inv:${fresh.id}`, payload);
    }
    return true;
  }
}
