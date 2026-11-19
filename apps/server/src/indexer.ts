import { toEventSelector } from "viem";
import { applySubscriptionLog } from "./billing.ts";
import { SUBSCRIBED_EVENT, TOPIC, hexToNum, numToHex, type RpcBlock, type RpcLog, type RpcReceipt, type RpcTx } from "./chain.ts";
import type { Config } from "./config.ts";
import { type Db, kvGet, kvSet } from "./db.ts";
import type { HookService } from "./hooks.ts";
import type { InvoiceService } from "./invoices.ts";
import type { Metrics } from "./metrics.ts";
import type { NameResolver } from "./names.ts";
import type { ProjectService } from "./projects.ts";
import { buildPayload } from "./payload.ts";
import type { RpcPool } from "./rpc.ts";
import type { TokenService } from "./tokens.ts";
import { matchLog, matchNativeTx, matchWalletTx, type MatchedEvent, type Resolved } from "./triggers.ts";
import { errMsg, log, sleep } from "./util.ts";

const CURSOR_KEY = "indexer_cursor";

/** The node that answered does not have the requested block yet. */
export class NodeBehindError extends Error {
  constructor(block: number) {
    super(`RPC node has not reached block ${block} yet`);
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
    const range = { fromBlock: numToHex(from), toBlock: numToHex(to) };

    // One batch = one node. Asking that node for the range's last header first proves it
    // has the whole range, so a lagging node can never hand us a silently incomplete getLogs.
    const calls: { method: string; params: unknown[] }[] = [{ method: "eth_getBlockByNumber", params: [numToHex(to), false] }];
    if (topics.length) calls.push({ method: "eth_getLogs", params: [{ ...range, topics: [topics] }] });
    if (this.cfg.billingContract) calls.push({ method: "eth_getLogs", params: [{ ...range, address: this.cfg.billingContract, topics: [SUBSCRIBED_TOPIC] }] });
    const res = await this.rpc.batch<unknown>(calls, calls.length);
    const last = res[0] as RpcBlock | null;
    if (!last) throw new NodeBehindError(to);
    const logs = (topics.length ? res[1] : []) as RpcLog[];
    const billingLogs = (this.cfg.billingContract ? res[res.length - 1] : []) as RpcLog[];

    for (const l of billingLogs) applySubscriptionLog(this.db, l);

    const timestamps = new Map<number, number>([[to, hexToNum(last.timestamp)]]);
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
      const blockNums = Array.from({ length: to - from + 1 }, (_, i) => from + i);
      const blocks = await this.rpc.batch<RpcBlock | null>(blockNums.map((n) => ({ method: "eth_getBlockByNumber", params: [numToHex(n), true] })), 25);
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
        const receipts = await this.rpc.batch<RpcReceipt | null>(candidates.map((c) => ({ method: "eth_getTransactionReceipt", params: [c.tx.hash] })));
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
        await this.invoices!.matchLog(l, ts(hexToNum(l.blockNumber))).catch((e) => log.warn("invoice match failed", { tx: l.transactionHash, error: errMsg(e) }));
      }
      for (const t of invoicePaid) {
        await this.invoices!.matchNative(t, ts(hexToNum(t.blockNumber))).catch((e) => log.warn("invoice match failed", { tx: t.hash, error: errMsg(e) }));
      }
    }

    if (matches.length === 0) return 0;

    const missing = [...new Set(matches.map((m) => m.blockNumber))].filter((n) => !timestamps.has(n));
    if (missing.length) {
      const headers = await this.rpc.batch<RpcBlock | null>(missing.map((n) => ({ method: "eth_getBlockByNumber", params: [numToHex(n), false] })));
      headers.forEach((h, i) => h && timestamps.set(missing[i]!, hexToNum(h.timestamp)));
    }

    matches.sort((a, b) => a.blockNumber - b.blockNumber || (a.logIndex ?? -1) - (b.logIndex ?? -1));
    let stored = 0;
    for (const m of matches) {
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
    this.status.eventsMatched += stored;
    log.info("events matched", { from, to, stored });
    return stored;
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
