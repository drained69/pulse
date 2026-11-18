import { getAddress, isAddress } from "viem";
import type { RpcTx } from "./chain.ts";
import type { Config } from "./config.ts";
import { type Db, tx } from "./db.ts";
import { HttpError } from "./hooks.ts";
import type { RpcPool } from "./rpc.ts";
import { errMsg, escapeHtml, log, newId, nowSec, sleep } from "./util.ts";

/**
 * Traction pages: a public, live record of how many transactions and distinct
 * wallets use a project's contracts. Counted from chain data only (the indexer
 * plus an explorer backfill), so anyone can check the numbers.
 *
 * "Activity" = transactions sent directly to one of the project's contracts.
 * Only successful ones count towards the headline numbers; failed ones are shown
 * separately.
 */

export type ProjectRow = {
  id: string;
  user_id: string;
  slug: string;
  name: string;
  description: string;
  website: string | null;
  contracts: string;
  verified_by: string | null;
  public: number;
  backfill_status: string;
  backfill_error: string | null;
  created_at: number;
  updated_at: number;
};

export type ProjectInput = { name?: unknown; slug?: unknown; description?: unknown; website?: unknown; contracts?: unknown; public?: unknown };

export type PublicProject = {
  id: string;
  slug: string;
  name: string;
  description: string;
  website: string | null;
  contracts: string[];
  verifiedBy: string | null;
  public: boolean;
  backfill: { status: string; error: string | null };
  createdAt: number;
};

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
const RESERVED = new Set(["new", "edit", "explore", "api", "admin", "qie", "qiehooks"]);
const DAY = 86400;

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

function toPublic(r: ProjectRow): PublicProject {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    description: r.description,
    website: r.website,
    contracts: JSON.parse(r.contracts) as string[],
    verifiedBy: r.verified_by,
    public: r.public === 1,
    backfill: { status: r.backfill_status, error: r.backfill_error },
    createdAt: r.created_at,
  };
}

export function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

type ExplorerTx = {
  hash: string;
  block_number: number;
  timestamp: string;
  status: string | null;
  value: string;
  method: string | null;
  from: { hash: string };
  to: { hash: string } | null;
};

export class ProjectService {
  private cfg: Config;
  private db: Db;
  private rpc: RpcPool;
  private index: Map<string, string[]> | null = null;
  private running = new Set<string>();

  constructor(cfg: Config, db: Db, rpc: RpcPool) {
    this.cfg = cfg;
    this.db = db;
    this.rpc = rpc;
  }

  /** contract address (lowercase) → project ids. Rebuilt lazily after changes. */
  contractIndex(): Map<string, string[]> {
    if (this.index) return this.index;
    const m = new Map<string, string[]>();
    for (const r of this.db.prepare("SELECT id, contracts FROM projects").all() as { id: string; contracts: string }[]) {
      for (const c of JSON.parse(r.contracts) as string[]) {
        const k = c.toLowerCase();
        m.set(k, [...(m.get(k) ?? []), r.id]);
      }
    }
    this.index = m;
    return m;
  }

  private invalidate(): void {
    this.index = null;
  }

  // ───────── create / edit ─────────

  private async validate(input: ProjectInput, userId: string, existing?: ProjectRow) {
    const name = String(input.name ?? existing?.name ?? "").trim();
    if (!name || name.length > 60) throw new HttpError(400, "name: 1–60 characters");
    const description = String(input.description ?? existing?.description ?? "").trim();
    if (description.length > 280) throw new HttpError(400, "description: at most 280 characters");
    let website: string | null = input.website === undefined ? (existing?.website ?? null) : String(input.website ?? "").trim() || null;
    if (website) {
      if (!/^https?:\/\//i.test(website)) website = `https://${website}`;
      try {
        const u = new URL(website);
        if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
        website = u.toString();
      } catch {
        throw new HttpError(400, "website: must be a valid URL");
      }
      if (website.length > 200) throw new HttpError(400, "website: too long");
    }

    const slug = input.slug === undefined || input.slug === "" ? (existing?.slug ?? slugify(name)) : String(input.slug).trim().toLowerCase();
    if (!SLUG_RE.test(slug) || RESERVED.has(slug)) throw new HttpError(400, "slug: 3–40 lowercase letters, numbers and dashes");
    const taken = this.db.prepare("SELECT id FROM projects WHERE slug = ?").get(slug) as { id: string } | undefined;
    if (taken && taken.id !== existing?.id) throw new HttpError(409, `The page name “${slug}” is taken. Pick another.`);

    let contracts: string[];
    if (input.contracts === undefined && existing) contracts = JSON.parse(existing.contracts) as string[];
    else {
      if (!Array.isArray(input.contracts) || input.contracts.length === 0) throw new HttpError(400, "contracts: add at least one contract address");
      if (input.contracts.length > 10) throw new HttpError(400, "contracts: at most 10");
      contracts = [];
      for (const c of input.contracts) {
        const a = String(c).trim();
        if (!isAddress(a)) throw new HttpError(400, `contracts: ${a.slice(0, 50)} is not an address`);
        const cs = getAddress(a);
        if (!contracts.includes(cs)) contracts.push(cs);
      }
      const codes = await this.rpc.batch<string>(contracts.map((c) => ({ method: "eth_getCode", params: [c, "latest"] }))).catch((e) => {
        throw new HttpError(502, `Could not reach QIE RPC: ${errMsg(e)}`);
      });
      codes.forEach((code, i) => {
        if (!code || code === "0x") throw new HttpError(400, `contracts: ${contracts[i]} is not a contract on QIE ${this.cfg.network}`);
      });
    }
    const pub = input.public === undefined ? (existing ? existing.public === 1 : true) : Boolean(input.public);
    void userId;
    return { name, description, website, slug, contracts, public: pub };
  }

  /** Is the signed-in wallet the deployer or `owner()` of one of the contracts? */
  async verifyOwner(address: string, contracts: string[]): Promise<string | null> {
    const me = address.toLowerCase();
    for (const c of contracts) {
      try {
        const res = await fetch(`${this.cfg.explorerApiUrl}/api/v2/addresses/${c}`, { signal: AbortSignal.timeout(8000) });
        if (res.ok) {
          const d = (await res.json()) as { creator_address_hash?: string | null };
          if (d.creator_address_hash?.toLowerCase() === me) return "deployer";
        }
      } catch {
        /* explorer unavailable: try owner() */
      }
      try {
        // owner() — Ownable and most admin patterns.
        const out = await this.rpc.call<string>("eth_call", [{ to: c, data: "0x8da5cb5b" }, "latest"]);
        if (out && out.length >= 66 && `0x${out.slice(-40)}`.toLowerCase() === me) return "owner";
      } catch {
        /* not Ownable */
      }
    }
    return null;
  }

  async create(user: { id: string; address: string }, input: ProjectInput): Promise<PublicProject> {
    const n = (this.db.prepare("SELECT COUNT(*) AS n FROM projects WHERE user_id = ?").get(user.id) as { n: number }).n;
    if (n >= this.cfg.maxProjects) throw new HttpError(402, `You can have up to ${this.cfg.maxProjects} traction pages.`);
    const v = await this.validate(input, user.id);
    const verified = await this.verifyOwner(user.address, v.contracts);
    const id = newId("prj");
    this.db
      .prepare(
        `INSERT INTO projects (id, user_id, slug, name, description, website, contracts, verified_by, public, backfill_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(id, user.id, v.slug, v.name, v.description, v.website, JSON.stringify(v.contracts), verified, v.public ? 1 : 0, nowSec(), nowSec());
    this.invalidate();
    void this.backfill(id);
    return this.get(user.id, id);
  }

  async update(user: { id: string; address: string }, id: string, input: ProjectInput): Promise<PublicProject> {
    const row = this.row(user.id, id);
    const v = await this.validate(input, user.id, row);
    const contractsChanged = JSON.stringify(v.contracts) !== row.contracts;
    const verified = contractsChanged ? await this.verifyOwner(user.address, v.contracts) : row.verified_by;
    tx(this.db, () => {
      this.db
        .prepare("UPDATE projects SET slug=?, name=?, description=?, website=?, contracts=?, verified_by=?, public=?, updated_at=? WHERE id=?")
        .run(v.slug, v.name, v.description, v.website, JSON.stringify(v.contracts), verified, v.public ? 1 : 0, nowSec(), id);
      if (contractsChanged) {
        // Drop activity of removed contracts; re-backfill the new set.
        const keep = new Set(v.contracts.map((c) => c.toLowerCase()));
        for (const r of this.db.prepare("SELECT DISTINCT contract FROM project_txs WHERE project_id = ?").all(id) as { contract: string }[]) {
          if (!keep.has(r.contract)) this.db.prepare("DELETE FROM project_txs WHERE project_id = ? AND contract = ?").run(id, r.contract);
        }
        this.db.prepare("UPDATE projects SET backfill_status = 'pending', backfill_error = NULL WHERE id = ?").run(id);
      }
    });
    this.invalidate();
    if (contractsChanged) void this.backfill(id);
    return this.get(user.id, id);
  }

  /**
   * Hand a page to the project's team: anyone can create a page for public contracts,
   * but the wallet that deployed one of them (or its owner()) can take it over.
   */
  async claim(user: { id: string; address: string }, slug: string): Promise<PublicProject> {
    const row = this.bySlug(slug);
    if (!row) throw new HttpError(404, "No traction page with that name");
    if (row.user_id === user.id) return toPublic(row);
    const verified = await this.verifyOwner(user.address, JSON.parse(row.contracts) as string[]);
    if (!verified) throw new HttpError(403, "Sign in with the wallet that deployed one of these contracts (or its owner()) to claim this page.");
    this.db.prepare("UPDATE projects SET user_id = ?, verified_by = ?, updated_at = ? WHERE id = ?").run(user.id, verified, nowSec(), row.id);
    log.info("project claimed", { project: row.id, by: user.address });
    return this.get(user.id, row.id);
  }

  remove(userId: string, id: string): void {
    this.row(userId, id);
    this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
    this.invalidate();
  }

  private row(userId: string, id: string): ProjectRow {
    const r = this.db.prepare("SELECT * FROM projects WHERE id = ? AND user_id = ?").get(id, userId) as ProjectRow | undefined;
    if (!r) throw new HttpError(404, "Project not found");
    return r;
  }

  get(userId: string, id: string): PublicProject {
    return toPublic(this.row(userId, id));
  }

  list(userId: string): (PublicProject & { summary: ReturnType<ProjectService["summary"]> })[] {
    const rows = this.db.prepare("SELECT * FROM projects WHERE user_id = ? ORDER BY created_at DESC").all(userId) as ProjectRow[];
    return rows.map((r) => ({ ...toPublic(r), summary: this.summary(r.id) }));
  }

  bySlug(slug: string): ProjectRow | null {
    return (this.db.prepare("SELECT * FROM projects WHERE slug = ?").get(slug.toLowerCase()) as ProjectRow | undefined) ?? null;
  }

  // ───────── activity ─────────

  /** Called by the indexer for every transaction sent to a tracked contract. */
  record(tx: RpcTx, ok: boolean, ts: number): void {
    const to = tx.to?.toLowerCase();
    if (!to) return;
    const ids = this.contractIndex().get(to);
    if (!ids) return;
    const ins = this.db.prepare(
      "INSERT OR IGNORE INTO project_txs (project_id, tx_hash, contract, wallet, block_number, ts, ok, value, method) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const method = tx.input && tx.input.length >= 10 ? tx.input.slice(0, 10) : null;
    for (const id of ids) {
      ins.run(id, tx.hash.toLowerCase(), to, tx.from.toLowerCase(), Number(BigInt(tx.blockNumber ?? "0x0")), ts, ok ? 1 : 0, BigInt(tx.value ?? "0x0").toString(), method);
    }
  }

  /**
   * Import past transactions from the explorer so a new page isn't empty. Goes back
   * `backfillDays` or `backfillMaxTxs` per contract, whichever comes first. Safe to
   * re-run: rows are unique per (project, tx).
   */
  async backfill(id: string): Promise<void> {
    if (this.running.has(id)) return;
    this.running.add(id);
    try {
      const row = this.db.prepare("SELECT contracts FROM projects WHERE id = ?").get(id) as { contracts: string } | undefined;
      if (!row) return;
      this.db.prepare("UPDATE projects SET backfill_status = 'running', backfill_error = NULL WHERE id = ?").run(id);
      const cutoff = nowSec() - this.cfg.backfillDays * DAY;
      const ins = this.db.prepare(
        "INSERT OR IGNORE INTO project_txs (project_id, tx_hash, contract, wallet, block_number, ts, ok, value, method) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      let imported = 0;
      for (const contract of JSON.parse(row.contracts) as string[]) {
        let params: Record<string, unknown> | null = {};
        let seen = 0;
        while (params && seen < this.cfg.backfillMaxTxs) {
          const qs = new URLSearchParams({ filter: "to" });
          for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined) qs.set(k, String(v));
          const res = await fetch(`${this.cfg.explorerApiUrl}/api/v2/addresses/${contract}/transactions?${qs}`, { signal: AbortSignal.timeout(20_000) });
          if (!res.ok) throw new Error(`explorer HTTP ${res.status}`);
          const page = (await res.json()) as { items: ExplorerTx[]; next_page_params: Record<string, unknown> | null };
          let older = false;
          tx(this.db, () => {
            for (const t of page.items) {
              const ts = Math.floor(Date.parse(t.timestamp) / 1000);
              if (ts < cutoff) {
                older = true;
                continue;
              }
              if (t.to?.hash.toLowerCase() !== contract.toLowerCase()) continue;
              if (t.status === null) continue; // still pending
              const r = ins.run(id, t.hash.toLowerCase(), contract.toLowerCase(), t.from.hash.toLowerCase(), t.block_number, ts, t.status === "ok" ? 1 : 0, t.value ?? "0", t.method?.startsWith("0x") ? t.method : null);
              imported += Number(r.changes);
            }
          });
          seen += page.items.length;
          params = older ? null : page.next_page_params;
          if (params) await sleep(150);
        }
      }
      this.db.prepare("UPDATE projects SET backfill_status = 'done' WHERE id = ?").run(id);
      log.info("project backfilled", { project: id, imported });
    } catch (e) {
      log.warn("project backfill failed", { project: id, error: errMsg(e) });
      this.db.prepare("UPDATE projects SET backfill_status = 'failed', backfill_error = ? WHERE id = ?").run(errMsg(e).slice(0, 200), id);
    } finally {
      this.running.delete(id);
    }
  }

  /** Re-run backfills that never finished (e.g. the server restarted mid-way). */
  resumeBackfills(): void {
    for (const r of this.db.prepare("SELECT id FROM projects WHERE backfill_status IN ('pending','running')").all() as { id: string }[]) void this.backfill(r.id);
  }

  // ───────── stats ─────────

  summary(id: string, now = nowSec()) {
    const q = (since: number) =>
      this.db.prepare("SELECT COUNT(*) AS txs, COUNT(DISTINCT wallet) AS wallets FROM project_txs WHERE project_id = ? AND ok = 1 AND ts >= ?").get(id, since) as {
        txs: number;
        wallets: number;
      };
    const all = q(0);
    const d7 = q(now - 7 * DAY);
    return { txs: all.txs, wallets: all.wallets, txs7d: d7.txs, wallets7d: d7.wallets };
  }

  stats(id: string, now = nowSec()) {
    const one = <T>(sql: string, ...args: (string | number)[]) => this.db.prepare(sql).get(id, ...args) as T;
    const many = <T>(sql: string, ...args: (string | number)[]) => this.db.prepare(sql).all(id, ...args) as T[];

    const totals = one<{ txs: number; wallets: number; failed: number; since: number | null; value: number | null }>(
      `SELECT SUM(ok) AS txs, COUNT(DISTINCT CASE WHEN ok = 1 THEN wallet END) AS wallets, SUM(1 - ok) AS failed, MIN(ts) AS since,
              SUM(CASE WHEN ok = 1 THEN CAST(value AS REAL) ELSE 0 END) AS value
       FROM project_txs WHERE project_id = ?`,
    );
    const window = (secs: number) =>
      one<{ txs: number; wallets: number }>("SELECT COUNT(*) AS txs, COUNT(DISTINCT wallet) AS wallets FROM project_txs WHERE project_id = ? AND ok = 1 AND ts >= ?", now - secs);
    const returning = one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM (SELECT wallet FROM project_txs WHERE project_id = ? AND ok = 1 GROUP BY wallet HAVING COUNT(DISTINCT ts / 86400) >= 2)`,
    ).n;
    const top = many<{ wallet: string; n: number }>(
      "SELECT wallet, COUNT(*) AS n FROM project_txs WHERE project_id = ? AND ok = 1 GROUP BY wallet ORDER BY n DESC LIMIT 10",
    );
    const topShare = totals.txs ? top.reduce((s, r) => s + r.n, 0) / totals.txs : 0;

    const start = Math.floor((now - 29 * DAY) / DAY) * DAY;
    const daily = many<{ day: number; txs: number; wallets: number }>(
      "SELECT ts / 86400 AS day, COUNT(*) AS txs, COUNT(DISTINCT wallet) AS wallets FROM project_txs WHERE project_id = ? AND ok = 1 AND ts >= ? GROUP BY day",
      start,
    );
    const firstSeen = many<{ day: number; n: number }>(
      `SELECT first / 86400 AS day, COUNT(*) AS n FROM (SELECT MIN(ts) AS first FROM project_txs WHERE project_id = ? AND ok = 1 GROUP BY wallet)
       WHERE first >= ? GROUP BY day`,
      start,
    );
    const byDay = new Map(daily.map((d) => [d.day, d]));
    const newByDay = new Map(firstSeen.map((d) => [d.day, d.n]));
    const series = Array.from({ length: 30 }, (_, i) => {
      const day = start / DAY + i;
      const d = byDay.get(day);
      return { date: new Date(day * DAY * 1000).toISOString().slice(0, 10), txs: d?.txs ?? 0, wallets: d?.wallets ?? 0, newWallets: newByDay.get(day) ?? 0 };
    });
    const recent = many<{ tx_hash: string; wallet: string; contract: string; ts: number; ok: number; method: string | null }>(
      "SELECT tx_hash, wallet, contract, ts, ok, method FROM project_txs WHERE project_id = ? ORDER BY ts DESC, block_number DESC LIMIT 15",
    );

    return {
      totals: {
        txs: totals.txs ?? 0,
        wallets: totals.wallets ?? 0,
        failedTxs: totals.failed ?? 0,
        returningWallets: returning,
        topWalletsShare: Math.round(topShare * 1000) / 10,
        qieValue: totals.value ? Math.round((totals.value / 1e18) * 1e4) / 1e4 : 0,
        since: totals.since,
      },
      last24h: window(DAY),
      last7d: window(7 * DAY),
      last30d: window(30 * DAY),
      series,
      recent: recent.map((r) => ({ txHash: r.tx_hash, wallet: r.wallet, contract: r.contract, ts: r.ts, ok: r.ok === 1, method: r.method })),
    };
  }

  /** Public projects ranked by distinct wallets in the last 7 days. */
  leaderboard(limit = 100, now = nowSec()) {
    const rows = this.db
      .prepare(
        `SELECT p.slug, p.name, p.description, p.verified_by,
                COUNT(DISTINCT CASE WHEN t.ts >= ? THEN t.wallet END) AS wallets7d,
                SUM(CASE WHEN t.ts >= ? THEN 1 ELSE 0 END) AS txs7d,
                COUNT(DISTINCT t.wallet) AS wallets, COUNT(t.tx_hash) AS txs
         FROM projects p LEFT JOIN project_txs t ON t.project_id = p.id AND t.ok = 1
         WHERE p.public = 1 GROUP BY p.id ORDER BY wallets7d DESC, txs7d DESC, wallets DESC, p.created_at ASC LIMIT ?`,
      )
      .all(now - 7 * DAY, now - 7 * DAY, limit) as {
      slug: string;
      name: string;
      description: string;
      verified_by: string | null;
      wallets7d: number;
      txs7d: number;
      wallets: number;
      txs: number;
    }[];
    return rows.map((r, i) => ({
      rank: i + 1,
      slug: r.slug,
      name: r.name,
      description: r.description,
      verified: Boolean(r.verified_by),
      wallets7d: r.wallets7d,
      txs7d: r.txs7d ?? 0,
      wallets: r.wallets,
      txs: r.txs,
    }));
  }

  /** Shields-style SVG badge for READMEs and submissions. */
  badge(row: ProjectRow): string {
    const s = this.summary(row.id);
    const left = "QIE traction";
    const right = `${compact(s.txs)} tx · ${compact(s.wallets)} wallets`;
    const w = (t: string) => Math.round(t.length * 6.6 + 14);
    const lw = w(left);
    const rw = w(right);
    const total = lw + rw;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" aria-label="${escapeHtml(`${left}: ${right}`)}">
<title>${escapeHtml(`${row.name} on QIE: ${right} (live, via QIE Hooks)`)}</title>
<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
<clipPath id="r"><rect width="${total}" height="20" rx="3" fill="#fff"/></clipPath>
<g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#2b2650"/><rect x="${lw}" width="${rw}" height="20" fill="#7c5cff"/><rect width="${total}" height="20" fill="url(#s)"/></g>
<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
<text x="${lw / 2}" y="14">${escapeHtml(left)}</text><text x="${lw + rw / 2}" y="14">${escapeHtml(right)}</text></g></svg>`;
  }
}
