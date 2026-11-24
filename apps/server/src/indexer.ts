import { toEventSelector } from "viem";
import { applySubscriptionLog } from "./billing.ts";
import { SUBSCRIBED_EVENT, TOPIC, hexToNum, numToHex, type RpcBlock, type RpcLog, type RpcReceipt, type RpcTx } from "./chain.ts";
import type { Config } from "./config.ts";
import { type Db, kvGet, kvSet, tx } from "./db.ts";
import type { HookService } from "./hooks.ts";
import type { InvoiceService } from "./invoices.ts";
import { isCompleteBlockLogs } from "./log-completeness.ts";
import type { Metrics } from "./metrics.ts";
import type { NameResolver } from "./names.ts";
import type { ProjectService } from "./projects.ts";
import { buildPayload } from "./payload.ts";
import { poisoningSignal } from "./poisoning.ts";
import { depthOf, stepLiquidity, type LiquidityState } from "./liquidity.ts";
import type { RpcPool } from "./rpc.ts";
import type { TokenService } from "./tokens.ts";
import { matchLog, matchNativeTx, matchWalletTx, type HookIndex, type MatchedEvent, type Resolved } from "./triggers.ts";
import { errMsg, log, sleep } from "./util.ts";

const CURSOR_KEY = "indexer_cursor";

/** The node that answered does not have the requested block (or its logs / receipts) yet. */
export class NodeBehindError extends Error {
  block: number;
  constructor(block: number, what = "block") {
    super(`RPC node has not indexed ${what} ${block} yet`);
    this.block = block;
  }
}
const SUBSCRIBED_TOPIC = toEventSelector(SUBSCRIBED_EVENT);

export type IndexerStatus = {
  head: number | null;
  cursor: number | null;
  lagBlocks: number | null;
  lastTickAt: number | null;
  lastError: string | null;
  eventsMatched: number;
  blocksProcessed: number;
  startedAt: number;
};

/**
 * Follows QIE blocks over the RPC pool, matches logs and native transfers to
 * hooks, and queues deliveries. One cursor, advanced only after a range is
 * fully stored, so a crash replays the range and dedupe keys stop doubles.
 */
export class Indexer {
  private cfg: Config;
  private db: Db;
  private rpc: RpcPool;
  private hooks: HookService;
  private names: NameResolver;
  private tokens: TokenService;
  /** Traction pages: transactions to tracked contracts. Optional so tests can omit it. */
  projects: ProjectService | null = null;
  /** Payment links: matched by recipient + token + exact amount. */
  invoices: InvoiceService | null = null;
  /** Block → stored latency samples. */
  metrics: Metrics | null = null;
  private stopped = false;
  status: IndexerStatus = { head: null, cursor: null, lagBlocks: null, lastTickAt: null, lastError: null, eventsMatched: 0, blocksProcessed: 0, startedAt: Date.now() };

  constructor(cfg: Config, db: Db, rpc: RpcPool, hooks: HookService, names: NameResolver, tokens: TokenService) {
    this.cfg = cfg;
    this.db = db;
    this.rpc = rpc;
    this.hooks = hooks;
    this.names = names;
    this.tokens = tokens;
    const c = kvGet(db, CURSOR_KEY);
    this.status.cursor = c === null ? null : Number(c);
  }

  private async initCursor(head: number): Promise<number> {
    const start = this.cfg.startBlock === "latest" ? head - this.cfg.confirmations : Number(this.cfg.startBlock) - 1;
    kvSet(this.db, CURSOR_KEY, String(start));
    log.info("indexer cursor initialised", { block: start });
    return start;
  }

  setCursor(block: number): void {
    kvSet(this.db, CURSOR_KEY, String(block));
    this.status.cursor = block;
  }

  /** Process one batch. Returns how many blocks were processed. */
  async tick(): Promise<number> {
    const head = hexToNum(await this.rpc.call<string>("eth_blockNumber"));
    this.status.head = head;
    const target = head - this.cfg.confirmations;
    let cursor = this.status.cursor ?? Number(kvGet(this.db, CURSOR_KEY) ?? Number.NaN);
    if (!Number.isFinite(cursor)) cursor = await this.initCursor(head);
    this.status.cursor = cursor;
    this.status.lagBlocks = Math.max(0, target - cursor);
    if (cursor >= target) return 0;

    const from = cursor + 1;
    const to = Math.min(target, from + this.cfg.maxBlocksPerBatch - 1);
    try {
      await this.processRange(from, to);
    } catch (e) {
      if (e instanceof NodeBehindError) return 0; // the next poll reaches an up-to-date node
      throw e;
    }
    this.setCursor(to);
    this.status.lagBlocks = Math.max(0, target - to);
    this.status.blocksProcessed += to - from + 1;
    return to - from + 1;
  }

  async processRange(from: number, to: number): Promise<number> {
    const idx = this.hooks.getIndex();
    const watchedInvoices = this.invoices?.watched();
    const tracksInvoices = Boolean(watchedInvoices && watchedInvoices.size > 0);
    const topics = idx.topics();
    if (tracksInvoices && !topics.includes(TOPIC.TRANSFER)) topics.push(TOPIC.TRANSFER);
    const billing = this.cfg.billingContract?.toLowerCase() ?? null;
    const wantLogs = topics.length > 0 || billing !== null;
    const blockNums = Array.from({ length: to - from + 1 }, (_, i) => from + i);

    // One batch = one node: every header of the range, then (last, so the node answers it after
    // the headers) all logs of the range. A missing header means the node is behind. A header
    // whose bloom says "has logs" with no logs returned means its log index is behind. Either way
    // the range is retried, so a lagging node can never make us skip a payment.
    // Logs are fetched unfiltered and matched here: QIE has few logs per block, and only the
    // complete set can be checked against the blooms.
    const calls: { method: string; params: unknown[] }[] = blockNums.map((n) => ({ method: "eth_getBlockByNumber", params: [numToHex(n), false] }));
    if (wantLogs) calls.push({ method: "eth_getLogs", params: [{ fromBlock: numToHex(from), toBlock: numToHex(to) }] });
    const meta: { url?: string } = {};
    const res = await this.rpc.batch<unknown>(calls, calls.length, meta);
    const headers = res.slice(0, blockNums.length) as ((RpcBlock & { logsBloom?: string }) | null)[];
    const missingHeader = headers.findIndex((h) => !h);
    // A node a block behind the head is normal (the head just moved), so it is not demoted for that.
    if (missingHeader >= 0) throw new NodeBehindError(blockNums[missingHeader]!);
    const wrongHeader = headers.findIndex((h, i) => hexToNum(h!.number) !== blockNums[i]);
    if (wrongHeader >= 0) throw this.behind(meta.url, new NodeBehindError(blockNums[wrongHeader]!, "the requested header of block"));
    const allLogs = (wantLogs ? (res[res.length - 1] as RpcLog[] | null) : []) ?? [];
    if (wantLogs) this.checkLogsComplete(headers as (RpcBlock & { logsBloom?: string })[], allLogs, meta.url);

    const topicSet = new Set(topics.map((t) => t.toLowerCase()));
    const logs = allLogs.filter((l) => topicSet.has(l.topics[0]?.toLowerCase() ?? ""));
    const billingLogs = billing
      ? allLogs.filter((l) => l.address.toLowerCase() === billing && l.topics[0]?.toLowerCase() === SUBSCRIBED_TOPIC.toLowerCase())
      : [];

    for (const l of billingLogs) applySubscriptionLog(this.db, l);

    const timestamps = new Map<number, number>(headers.map((h) => [hexToNum(h!.number), hexToNum(h!.timestamp)]));
    const invoicePaid: RpcTx[] = [];
    const matches: MatchedEvent[] = [];
    if (topics.length || idx.needsNativeTxs()) await this.tokens.refreshPairs();

    const tokenOf = (a: string) => this.tokens.token(a);
    const pairOf = (a: string) => this.tokens.pair(a);
    for (const l of logs) {
      try {
        matches.push(...(await matchLog(l, idx, tokenOf, pairOf)));
      } catch (e) {
        log.warn("log match failed", { tx: l.transactionHash, error: errMsg(e) });
      }
    }

    const projectIdx = this.projects?.contractIndex();
    const tracksProjects = Boolean(projectIdx && projectIdx.size > 0);
    const invoiceNative = tracksInvoices && this.invoices!.needsNative();
    if (idx.needsNativeTxs() || tracksProjects || invoiceNative) {
      // Blocks with transactions, only for the blocks that have any (the headers above say).
      const withTxs = headers.filter((h) => !Array.isArray(h!.transactions) || h!.transactions.length > 0).map((h) => hexToNum(h!.number));
      const bmeta: { url?: string } = {};
      const blocks = await this.rpc.batch<RpcBlock | null>(withTxs.map((n) => ({ method: "eth_getBlockByNumber", params: [numToHex(n), true] })), 25, bmeta);
      const nullBlock = blocks.findIndex((b) => !b);
      if (nullBlock >= 0) throw new NodeBehindError(withTxs[nullBlock]!);
      const candidates: { tx: RpcTx; m: MatchedEvent[]; wallet: boolean; project: boolean; invoice: boolean }[] = [];
      for (const b of blocks) {
        if (!b) continue;
        timestamps.set(hexToNum(b.number), hexToNum(b.timestamp));
        for (const t of b.transactions as RpcTx[]) {
          if (typeof t === "string") continue;
          const m = matchNativeTx(t, idx);
          const wallet = idx.walletsByAddress.has(t.from.toLowerCase()) || (t.to !== null && idx.walletsByAddress.has(t.to.toLowerCase()));
          const project = tracksProjects && t.to !== null && projectIdx!.has(t.to.toLowerCase());
          const invoice = invoiceNative && this.invoices!.nativeCandidate(t);
          if (m.length || wallet || project || invoice) candidates.push({ tx: t, m, wallet, project, invoice });
        }
      }
      if (candidates.length) {
        // A reverted tx still carries `value`; only successful transfers count as payments.
        const rmeta: { url?: string } = {};
        const receipts = await this.rpc.batch<RpcReceipt | null>(candidates.map((c) => ({ method: "eth_getTransactionReceipt", params: [c.tx.hash] })), 50, rmeta);
        const nullReceipt = receipts.findIndex((r) => !r);
        if (nullReceipt >= 0) throw this.behind(rmeta.url, new NodeBehindError(hexToNum(candidates[nullReceipt]!.tx.blockNumber), "the receipts of block"));
        // Token transfers already describe a wallet's outgoing ERC-20 call better than "contract call".
        const tokenEventKeys = new Set(
          matches.filter((x) => x.type === "wallet.activity").map((x) => `${x.hook.id}:${x.txHash.toLowerCase()}`),
        );
        candidates.forEach((c, i) => {
          const r = receipts[i];
          if (!r) return;
          const ok = r.status === "0x1";
          if (c.project) this.projects!.record(c.tx, ok, timestamps.get(hexToNum(c.tx.blockNumber)) ?? 0);
          if (c.invoice && ok) invoicePaid.push(c.tx);
          if (ok) matches.push(...c.m);
          if (!c.wallet) return;
          for (const w of matchWalletTx(c.tx, ok ? "success" : "failed", idx)) {
            const redundant = ok && w.data.kind === "contract_call" && tokenEventKeys.has(`${w.hook.id}:${w.txHash.toLowerCase()}`);
            if (!redundant) matches.push(w);
          }
        });
      }
    }

    if (tracksInvoices) {
      // Matching needs block times (a payment can't predate its link): load any we lack.
      const needed = [
        ...new Set(
          logs
            .filter((l) => l.topics[0] === TOPIC.TRANSFER && l.topics.length === 3 && watchedInvoices!.has(`0x${l.topics[2]!.slice(26)}`.toLowerCase()))
            .map((l) => hexToNum(l.blockNumber))
            .filter((n) => !timestamps.has(n)),
        ),
      ];
      if (needed.length) {
        const headers = await this.rpc.batch<RpcBlock | null>(needed.map((n) => ({ method: "eth_getBlockByNumber", params: [numToHex(n), false] })));
        headers.forEach((h, i) => h && timestamps.set(needed[i]!, hexToNum(h.timestamp)));
      }
      const ts = (n: number) => timestamps.get(n) ?? null;
      for (const l of logs) {
        if (l.topics[0] !== TOPIC.TRANSFER) continue;
        await this.invoices!.matchLog(l, ts(hexToNum(l.blockNumber)));
      }
      for (const t of invoicePaid) {
        await this.invoices!.matchNative(t, ts(hexToNum(t.blockNumber)));
      }
    }

    const liquidity = this.matchLiquidity(logs, idx, timestamps);
    matches.push(...liquidity.matches);

    if (matches.length === 0) {
      liquidity.commit();
      return 0;
    }

    const missing = [...new Set(matches.map((m) => m.blockNumber))].filter((n) => !timestamps.has(n));
    if (missing.length) {
      const headers = await this.rpc.batch<RpcBlock | null>(missing.map((n) => ({ method: "eth_getBlockByNumber", params: [numToHex(n), false] })));
      headers.forEach((h, i) => h && timestamps.set(missing[i]!, hexToNum(h.timestamp)));
    }

    matches.sort((a, b) => a.blockNumber - b.blockNumber || (a.logIndex ?? -1) - (b.logIndex ?? -1));
    let stored = 0;
    const seen = new Map<string, Set<string>>();
    for (const m of matches) {
      this.flagPoisoning(m, seen);
      const cfg = JSON.parse(m.hook.trigger_config) as Record<string, string>;
      const resolved = JSON.parse(m.hook.resolved || "{}") as Resolved;
      const nameIf = (v?: string) => (v && v.toLowerCase().endsWith(".qie") ? v.toLowerCase() : undefined);
      const payload = await buildPayload(m, timestamps.get(m.blockNumber) ?? null, {
        chainId: this.cfg.chainId,
        network: this.cfg.network,
        explorerUrl: this.cfg.explorerUrl,
        names: this.names,
        tokens: this.tokens,
        configuredNames: {
          recipient: nameIf(cfg.recipient ?? cfg.address),
          from: nameIf(cfg.from),
          to: nameIf(cfg.to),
        },
      });
      if (this.hooks.recordEvent(m.hook, m.dedupeKey, payload)) {
        stored++;
        this.metrics?.record("detect", timestamps.get(m.blockNumber));
      }
    }
    // State may suppress a future alert: commit it only after all event/outbox writes succeed.
    liquidity.commit();
    this.status.eventsMatched += stored;
    log.info("events matched", { from, to, stored });
    return stored;
  }

  /**
   * Rug-pull radar: follow each watched pair's depth through its Sync events (in block order) and
   * produce liquidity.drop events. Runs after every RPC call of the range, so a retried range can't
   * lose an event whose state was already saved.
   */
  private matchLiquidity(logs: RpcLog[], idx: HookIndex, timestamps: Map<number, number>): { matches: MatchedEvent[]; commit: () => void } {
    const out: MatchedEvent[] = [];
    const syncs = logs
      .filter((l) => l.topics[0]?.toLowerCase() === TOPIC.SYNC && idx.liquidityByPair.has(l.address.toLowerCase()))
      .sort((a, b) => hexToNum(a.blockNumber) - hexToNum(b.blockNumber) || hexToNum(a.logIndex) - hexToNum(b.logIndex));
    if (!syncs.length) return { matches: out, commit: () => {} };
    const updates = new Map<string, { state: LiquidityState; now: number }>();
    const getState = this.db.prepare("SELECT state FROM trigger_state WHERE hook_id = ?");
    const setState = this.db.prepare(
      "INSERT INTO trigger_state (hook_id, state, updated_at) VALUES (?, ?, ?) ON CONFLICT(hook_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at",
    );
    for (const l of syncs) {
      const data = l.data.slice(2).padEnd(128, "0");
      const r0 = BigInt(`0x${data.slice(0, 64)}`);
      const r1 = BigInt(`0x${data.slice(64, 128)}`);
      const depth = depthOf(r0, r1);
      const block = hexToNum(l.blockNumber);
      const now = timestamps.get(block) ?? Math.floor(Date.now() / 1000);
      for (const w of idx.liquidityByPair.get(l.address.toLowerCase()) ?? []) {
        const row = getState.get(w.hook.id) as { state: string } | undefined;
        const previous = updates.get(w.hook.id)?.state ?? (row ? (JSON.parse(row.state) as LiquidityState) : null);
        const step = stepLiquidity(previous, depth, w.dropPercent, now);
        updates.set(w.hook.id, { state: step.state, now });
        if (step.fire === null) continue;
        out.push({
          hook: w.hook,
          type: "liquidity.drop",
          dedupeKey: `${l.transactionHash}:${hexToNum(l.logIndex)}`,
          blockNumber: block,
          txHash: l.transactionHash,
          logIndex: hexToNum(l.logIndex),
          data: { pair: l.address, reserve0: r0, reserve1: r1, dropPercent: step.fire, peakDepth: step.peak, depth },
        });
      }
    }
    return {
      matches: out,
      commit: () => tx(this.db, () => {
        for (const [hookId, update] of updates) setState.run(hookId, JSON.stringify(update.state), update.now);
      }),
    };
  }

  /** Addresses a hook has dealt with before, from its recent events (newest 300). */
  private knownCounterparties(hookId: string): Set<string> {
    const out = new Set<string>();
    const rows = this.db.prepare("SELECT payload FROM events WHERE hook_id = ? ORDER BY created_at DESC LIMIT 300").all(hookId) as { payload: string }[];
    for (const r of rows) {
      const d = (JSON.parse(r.payload) as { data?: { from?: { address?: string }; to?: { address?: string } | null; security?: unknown } }).data;
      if (!d || d.security) continue; // never learn a flagged address as "known"
      for (const a of [d.from?.address, d.to?.address]) if (typeof a === "string" && a.length === 42) out.add(a.toLowerCase());
    }
    return out;
  }

  /** Mark wallet and payment events whose counterparty imitates a known address (address poisoning). */
  private flagPoisoning(m: MatchedEvent, cache: Map<string, Set<string>>): void {
    if (m.type !== "wallet.activity" && m.type !== "payment.received") return;
    const d = m.data as { kind?: string; direction?: string; wallet?: string; from: string; to: string | null; amount: bigint };
    const watched = (m.type === "payment.received" ? d.to : d.wallet)?.toLowerCase();
    const counterparty = m.type === "payment.received" || d.direction === "in" ? d.from : d.to;
    const isToken = m.type === "payment.received" || d.kind === "token_transfer";
    let known = cache.get(m.hook.id);
    if (!known) cache.set(m.hook.id, (known = this.knownCounterparties(m.hook.id)));
    const signal = poisoningSignal(counterparty, isToken ? d.amount : null, [...known].filter((a) => a !== watched));
    if (signal) (m.data as Record<string, unknown>).security = signal;
    else if (counterparty) known.add(counterparty.toLowerCase());
  }

  /** Reject inconsistent log responses without ever advancing past a failed consistency check. */
  private checkLogsComplete(headers: (RpcBlock & { logsBloom?: string })[], logs: RpcLog[], url: string | undefined): void {
    const byNumber = new Map(headers.map((h) => [hexToNum(h.number), h]));
    const groups = new Map<number, RpcLog[]>();
    for (const l of logs) {
      const number = hexToNum(l.blockNumber);
      if (!byNumber.has(number)) throw this.behind(url, new NodeBehindError(number, "logs outside the requested range of block"));
      const group = groups.get(number) ?? [];
      group.push(l);
      groups.set(number, group);
    }
    for (const h of headers) {
      const n = hexToNum(h.number);
      if (!isCompleteBlockLogs(h, groups.get(n) ?? [])) throw this.behind(url, new NodeBehindError(n, "consistent logs of block"));
    }
  }

  /** The node has the block but not yet its logs or receipts: use another node until it catches up. */
  private behind(url: string | undefined, e: NodeBehindError): NodeBehindError {
    this.rpc.demote(url, e.message);
    return e;
  }

  async run(): Promise<void> {
    while (!this.stopped) {
      let processed = 0;
      try {
        processed = await this.tick();
        this.status.lastError = null;
      } catch (e) {
        this.status.lastError = errMsg(e);
        log.error("indexer tick failed", { error: this.status.lastError });
        await sleep(5000);
      }
      this.status.lastTickAt = Date.now();
      if (processed === 0) await sleep(this.cfg.pollIntervalMs);
    }
  }

  stop(): void {
    this.stopped = true;
  }
}
