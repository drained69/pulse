import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { randomBytes } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { hexToNum, numToHex, type RpcLog } from "./chain.ts";
import type { Config } from "./config.ts";
import type { Metrics } from "./metrics.ts";
import { RpcError, type RpcPool } from "./rpc.ts";
import { errMsg, log } from "./util.ts";

/**
 * Real-time JSON-RPC for QIE.
 *
 * QIE's public nodes reject `eth_subscribe`, and filter ids (`eth_newFilter`)
 * live on a single node, so they break behind a load-balanced pool. Pulse fills
 * both gaps:
 *
 *   StreamHub   one upstream poller fans out every new block to N subscribers.
 *               Each poll is a single batched request (head + headers + logs) to
 *               one node; logs are checked against each header's hash and bloom,
 *               so a node that is behind can never produce a silently empty block.
 *   RpcGateway  speaks standard JSON-RPC: `eth_subscribe` / `eth_unsubscribe`
 *               (WebSocket), server-side `eth_newFilter` / `eth_getFilterChanges`
 *               (HTTP), and forwards everything else to the RPC pool with failover.
 *
 * QIE has CometBFT instant finality, so a streamed block is final: `removed` is always false.
 */

// ───────── filters ─────────

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const TOPIC = /^0x[0-9a-fA-F]{64}$/;

export type LogFilter = { address: Set<string> | null; topics: (Set<string> | null)[] };

export class ParamError extends Error {}

/** Parse the `{ address, topics }` part of an eth_subscribe("logs") / eth_newFilter request. */
export function parseLogFilter(raw: unknown): LogFilter {
  if (raw === undefined || raw === null) return { address: null, topics: [] };
  if (typeof raw !== "object" || Array.isArray(raw)) throw new ParamError("filter must be an object");
  const r = raw as { address?: unknown; topics?: unknown };
  let address: Set<string> | null = null;
  if (r.address !== undefined && r.address !== null) {
    const list = Array.isArray(r.address) ? r.address : [r.address];
    if (list.length > 100) throw new ParamError("at most 100 addresses");
    for (const a of list) if (typeof a !== "string" || !ADDR.test(a)) throw new ParamError(`invalid address: ${String(a)}`);
    address = list.length ? new Set((list as string[]).map((a) => a.toLowerCase())) : null;
  }
  const topics: (Set<string> | null)[] = [];
  if (r.topics !== undefined && r.topics !== null) {
    if (!Array.isArray(r.topics) || r.topics.length > 4) throw new ParamError("topics must be an array of at most 4 entries");
    for (const t of r.topics) {
      if (t === null) {
        topics.push(null);
        continue;
      }
      const alts = Array.isArray(t) ? t : [t];
      for (const x of alts) if (typeof x !== "string" || !TOPIC.test(x)) throw new ParamError(`invalid topic: ${String(x)}`);
      topics.push(alts.length ? new Set((alts as string[]).map((x) => x.toLowerCase())) : null);
    }
  }
  return { address, topics };
}

export function logMatches(f: LogFilter, l: RpcLog): boolean {
  if (f.address && !f.address.has(l.address.toLowerCase())) return false;
  for (let i = 0; i < f.topics.length; i++) {
    const want = f.topics[i];
    if (!want) continue;
    const got = l.topics[i];
    if (!got || !want.has(got.toLowerCase())) return false;
  }
  return true;
}

// ───────── hub ─────────

type Sub = { kind: "newHeads" | "logs"; filter: LogFilter | null; push: (result: unknown) => void };
type Header = Record<string, unknown> & { number: string; hash: string; timestamp: string };

export type StreamStatus = { subscribers: number; head: number | null; lastBlock: number | null; blocksStreamed: number; notifications: number; lastError: string | null };

export class StreamHub {
  private rpc: RpcPool;
  private metrics: Metrics | null;
  private pollMs: number;
  private maxCatchUp: number;
  private subs = new Map<string, Sub>();
  private last: number | null = null;
  private running = false;
  private stopped = false;
  private napTimer: NodeJS.Timeout | null = null;
  private napDone: (() => void) | null = null;
  status: StreamStatus = { subscribers: 0, head: null, lastBlock: null, blocksStreamed: 0, notifications: 0, lastError: null };

  constructor(rpc: RpcPool, metrics: Metrics | null, opts: { pollMs?: number; maxCatchUp?: number } = {}) {
    this.rpc = rpc;
    this.metrics = metrics;
    this.pollMs = opts.pollMs ?? 1000;
    this.maxCatchUp = opts.maxCatchUp ?? 20;
  }

  get size(): number {
    return this.subs.size;
  }

  subscribe(kind: Sub["kind"], filter: LogFilter | null, push: Sub["push"]): string {
    const id = `0x${randomBytes(16).toString("hex")}`;
    this.subs.set(id, { kind, filter, push });
    this.status.subscribers = this.subs.size;
    if (!this.running && !this.stopped) void this.loop();
    return id;
  }

  unsubscribe(id: string): boolean {
    const ok = this.subs.delete(id);
    this.status.subscribers = this.subs.size;
    return ok;
  }

  /**
   * Stream every block after the last one seen. Returns how many blocks were pushed.
   *
   * QIE's public nodes take ~1-2 s per request, so a tick is ONE batched round trip:
   * the head, the next few headers, and their logs, all answered by the same node.
   * Asking for blocks that do not exist yet is fine (null header, empty logs).
   */
  async tick(): Promise<number> {
    if (this.last === null) {
      // Start at the next block, like geth: a subscription sees blocks produced after it.
      this.last = hexToNum(await this.rpc.call<string>("eth_blockNumber"));
      this.status.head = this.last;
      return 0;
    }
    // After a long outage, skip ahead instead of flooding clients with stale blocks.
    const knownHead = this.status.head ?? this.last;
    if (knownHead - this.last > this.maxCatchUp) this.last = knownHead - this.maxCatchUp;
    const from = this.last + 1;
    const count = Math.min(this.maxCatchUp, Math.max(LOOKAHEAD, knownHead - this.last + 1));
    const nums = Array.from({ length: count }, (_, i) => from + i);
    const wantLogs = [...this.subs.values()].some((s) => s.kind === "logs");
    const calls = [
      { method: "eth_blockNumber", params: [] as unknown[] },
      ...nums.map((n) => ({ method: "eth_getBlockByNumber", params: [numToHex(n), false] as unknown[] })),
      // Last in the batch, so it runs after the headers it is checked against.
      ...(wantLogs ? [{ method: "eth_getLogs", params: [{ fromBlock: numToHex(from), toBlock: numToHex(from + count - 1) }] as unknown[] }] : []),
    ];
    const res = await this.rpc.batch<unknown>(calls, calls.length);
    this.status.head = hexToNum(res[0] as string);
    const headers = res.slice(1, 1 + count) as (Header | null)[];
    const logsByBlock = new Map<number, RpcLog[]>();
    for (const l of (wantLogs ? (res[1 + count] as RpcLog[]) : []) ?? []) {
      const n = hexToNum(l.blockNumber);
      (logsByBlock.get(n) ?? logsByBlock.set(n, []).get(n)!).push(l);
    }

    // Emit consecutive blocks only, and only when their logs are provably complete.
    const ready: { header: Header; logs: RpcLog[] }[] = [];
    for (const h of headers) {
      if (!h) break;
      const blockLogs = (logsByBlock.get(hexToNum(h.number)) ?? []).filter((l) => !l.blockHash || l.blockHash === h.hash);
      // A non-empty bloom with no logs means the node answered getLogs before it had this block.
      if (wantLogs && blockLogs.length === 0 && hasBloom(h)) break;
      ready.push({ header: h, logs: blockLogs });
    }

    for (const { header: b, logs } of ready) {
      const header = toHeader(b);
      const blockLogs = logs.map((l) => ({ ...l, removed: false }));
      for (const s of [...this.subs.values()]) {
        if (s.kind === "newHeads") this.send(s, header);
        else for (const l of blockLogs) if (logMatches(s.filter!, l)) this.send(s, l);
      }
      this.metrics?.record("stream", hexToNum(b.timestamp));
      this.status.blocksStreamed++;
    }
    if (ready.length) {
      this.last = hexToNum(ready[ready.length - 1]!.header.number);
      this.status.lastBlock = this.last;
    }
    return ready.length;
  }

  private send(s: Sub, result: unknown): void {
    try {
      s.push(result);
      this.status.notifications++;
    } catch (e) {
      log.warn("stream push failed", { error: errMsg(e) });
    }
  }

  private async loop(): Promise<void> {
    this.running = true;
    try {
      while (this.subs.size > 0 && !this.stopped) {
        let pushed = 0;
        try {
          pushed = await this.tick();
          this.status.lastError = null;
        } catch (e) {
          this.status.lastError = errMsg(e);
          log.warn("stream tick failed", { error: this.status.lastError });
          await this.nap(this.pollMs * 3);
        }
        if (pushed === 0) await this.nap(this.pollMs);
      }
    } finally {
      this.running = false;
      // Nobody listening: forget the position so the next subscriber starts at the live head.
      this.last = null;
    }
  }

  /** A sleep that stop() can cut short, so shutdown never waits on a timer. */
  private nap(ms: number): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return new Promise((resolve) => {
      this.napDone = resolve;
      this.napTimer = setTimeout(resolve, ms);
    });
  }

  stop(): void {
    this.stopped = true;
    this.subs.clear();
    this.status.subscribers = 0;
    if (this.napTimer) clearTimeout(this.napTimer);
    this.napDone?.();
  }
}

/** Blocks requested past the last one seen; most ticks find 0 or 1 new block. */
const LOOKAHEAD = 2;

function hasBloom(h: Header): boolean {
  const bloom = h.logsBloom;
  return typeof bloom === "string" && /[1-9a-f]/i.test(bloom.slice(2));
}

/** Shape of a `newHeads` notification: the block header without body fields. */
export function toHeader(b: Header): Record<string, unknown> {
  const { transactions: _t, uncles: _u, size: _s, totalDifficulty: _d, ...header } = b;
  return header;
}

// ───────── gateway ─────────

type JsonRpcReq = { jsonrpc?: string; id?: unknown; method?: unknown; params?: unknown };
type JsonRpcRes = { jsonrpc: "2.0"; id: unknown; result?: unknown; error?: { code: number; message: string } };

/** A WebSocket connection, as the gateway sees it. */
export type Conn = {
  subs: Set<string>;
  notify: (subscription: string, result: unknown) => void;
  /** Queue notifications for a new subscription until its id has been sent to the client. */
  hold?: (subscription: string) => void;
};

type ServerFilter = { kind: "logs" | "blocks"; params: unknown; subId: string; buf: unknown[]; lastPoll: number; ip: string };

const FORWARD = /^(eth|net|web3)_[A-Za-z0-9]+$/;
/** Account / signing methods make no sense on a shared public gateway. */
const DENY = new Set(["eth_sign", "eth_signTransaction", "eth_sendTransaction", "eth_signTypedData", "eth_signTypedData_v3", "eth_signTypedData_v4", "eth_coinbase", "eth_mining", "eth_submitWork", "eth_submitHashrate"]);
const FILTER_TTL_MS = 5 * 60_000;
const MAX_FILTERS = 2000;
/** One client must not be able to use up the shared filter table. */
export const MAX_FILTERS_PER_IP = 50;
const MAX_FILTER_BUFFER = 10_000;
export const MAX_SUBS_PER_CONN = 100;
const MAX_BATCH = 100;
/** Most blocks one forwarded eth_getLogs (or eth_newFilter) may span. */
export const MAX_LOG_RANGE = 5000;

const ok = (id: unknown, result: unknown): JsonRpcRes => ({ jsonrpc: "2.0", id: id ?? null, result });
const fail = (id: unknown, code: number, message: string): JsonRpcRes => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

export class RpcGateway {
  private cfg: Config;
  private rpc: RpcPool;
  readonly hub: StreamHub;
  private filters = new Map<string, ServerFilter>();
  private filtersPerIp = new Map<string, number>();
  private headAt = 0;
  private sweeper: NodeJS.Timeout;

  /**
   * `rpc` should be a pool of its own, not the indexer's: a client's slow call that times out
   * marks a node unhealthy in that pool only, so public traffic can't push the indexer off its nodes.
   */
  constructor(cfg: Config, rpc: RpcPool, hub: StreamHub) {
    this.cfg = cfg;
    this.rpc = rpc;
    this.hub = hub;
    this.sweeper = setInterval(() => this.sweep(), 30_000);
    this.sweeper.unref();
  }

  get filterCount(): number {
    return this.filters.size;
  }

  /** Handle one JSON-RPC message (single or batch). `conn` is null for plain HTTP. Returns null for notifications-only. */
  async handle(msg: unknown, conn: Conn | null, ip = "local"): Promise<JsonRpcRes | JsonRpcRes[] | null> {
    if (Array.isArray(msg)) {
      if (msg.length === 0) return fail(null, -32600, "empty batch");
      if (msg.length > MAX_BATCH) return fail(null, -32600, `batch too large (max ${MAX_BATCH})`);
      const out = await Promise.all(msg.map((m) => this.one(m as JsonRpcReq, conn, ip)));
      return out.filter((r): r is JsonRpcRes => r !== null);
    }
    return this.one(msg as JsonRpcReq, conn, ip);
  }

  /** Number of requests a message counts as, for rate limiting. */
  static weight(msg: unknown): number {
    return Array.isArray(msg) ? Math.max(1, msg.length) : 1;
  }

  private async one(req: JsonRpcReq, conn: Conn | null, ip: string): Promise<JsonRpcRes | null> {
    if (!req || typeof req !== "object" || typeof req.method !== "string") return fail(req?.id, -32600, "invalid request");
    const { id, method } = req;
    const params = Array.isArray(req.params) ? req.params : req.params === undefined ? [] : null;
    if (params === null) return fail(id, -32602, "params must be an array");
    try {
      const result = await this.dispatch(method, params, conn, ip);
      return id === undefined ? null : ok(id, result);
    } catch (e) {
      if (e instanceof ParamError) return fail(id, -32602, e.message);
      if (e instanceof RpcError) return fail(id, e.code, e.message);
      if (e instanceof MethodError) return fail(id, e.code, e.message);
      log.warn("rpc gateway upstream error", { method, error: errMsg(e) });
      return fail(id, -32603, "upstream unavailable");
    }
  }

  private async dispatch(method: string, params: unknown[], conn: Conn | null, ip: string): Promise<unknown> {
    switch (method) {
      case "eth_chainId":
        return numToHex(this.cfg.chainId);
      case "net_version":
        return String(this.cfg.chainId);
      case "eth_subscribe": {
        if (!conn) throw new MethodError(-32601, "eth_subscribe needs a WebSocket connection (wss://…/rpc)");
        if (conn.subs.size >= MAX_SUBS_PER_CONN) throw new MethodError(-32005, `subscription limit reached (${MAX_SUBS_PER_CONN} per connection)`);
        const kind = params[0];
        if (kind !== "newHeads" && kind !== "logs") throw new ParamError(`unsupported subscription type: ${String(kind)} (supported: newHeads, logs)`);
        const filter = kind === "logs" ? parseLogFilter(params[1]) : null;
        let subId = "";
        subId = this.hub.subscribe(kind, filter, (result) => conn.notify(subId, result));
        conn.hold?.(subId);
        conn.subs.add(subId);
        return subId;
      }
      case "eth_unsubscribe": {
        const subId = String(params[0] ?? "");
        if (!conn || !conn.subs.has(subId)) return false;
        conn.subs.delete(subId);
        return this.hub.unsubscribe(subId);
      }
      case "eth_newFilter":
        return this.newFilter("logs", params[0], ip);
      case "eth_newBlockFilter":
        return this.newFilter("blocks", null, ip);
      case "eth_newPendingTransactionFilter":
        throw new MethodError(-32601, "pending transaction filters are not supported (QIE has no public mempool feed)");
      case "eth_getFilterChanges": {
        const f = this.filter(params[0]);
        f.lastPoll = Date.now();
        return f.buf.splice(0, f.buf.length);
      }
      case "eth_getFilterLogs": {
        const f = this.filter(params[0]);
        if (f.kind !== "logs") throw new ParamError("not a log filter");
        f.lastPoll = Date.now();
        return this.rpc.call("eth_getLogs", [f.params]);
      }
      case "eth_uninstallFilter": {
        const fid = String(params[0] ?? "");
        const f = this.filters.get(fid);
        if (!f) return false;
        this.dropFilter(fid, f);
        return true;
      }
    }
    if (!FORWARD.test(method) || DENY.has(method)) throw new MethodError(-32601, `method not available: ${method}`);
    if (method === "eth_getLogs") await this.checkLogRange(params[0]);
    return this.rpc.call(method, params);
  }

  /** Unbounded eth_getLogs ranges are the cheapest way to make a public node time out. */
  async checkLogRange(raw: unknown): Promise<void> {
    if (!raw || typeof raw !== "object") throw new ParamError("filter must be an object");
    const f = raw as { fromBlock?: unknown; toBlock?: unknown; blockHash?: unknown };
    if (f.blockHash !== undefined) return;
    const tag = async (v: unknown): Promise<number> => {
      if (v === undefined || v === null || v === "latest" || v === "safe" || v === "finalized" || v === "pending") return this.head();
      if (v === "earliest") return 0;
      if (typeof v === "string" && /^0x[0-9a-fA-F]{1,16}$/.test(v)) return hexToNum(v);
      throw new ParamError(`invalid block: ${String(v)}`);
    };
    const from = await tag(f.fromBlock);
    const to = await tag(f.toBlock);
    if (to - from >= MAX_LOG_RANGE) throw new MethodError(-32005, `block range too large: ${to - from + 1} blocks (max ${MAX_LOG_RANGE}); split it or query by blockHash`);
  }

  private async head(): Promise<number> {
    const known = this.hub.status.head;
    if (known !== null && Date.now() - this.headAt < 10_000) return known;
    const h = hexToNum(await this.rpc.call<string>("eth_blockNumber"));
    this.hub.status.head = h;
    this.headAt = Date.now();
    return h;
  }

  private async newFilter(kind: ServerFilter["kind"], raw: unknown, ip: string): Promise<string> {
    if (this.filters.size >= MAX_FILTERS) this.sweep();
    if (this.filters.size >= MAX_FILTERS) throw new MethodError(-32005, "too many active filters, try again later");
    if ((this.filtersPerIp.get(ip) ?? 0) >= MAX_FILTERS_PER_IP) {
      throw new MethodError(-32005, `filter limit reached (${MAX_FILTERS_PER_IP} per client): uninstall old filters with eth_uninstallFilter`);
    }
    const parsed = kind === "logs" ? parseLogFilter(raw) : null;
    if (kind === "logs") await this.checkLogRange(raw ?? {});
    const fid = `0x${randomBytes(16).toString("hex")}`;
    const f: ServerFilter = { kind, params: raw ?? {}, subId: "", buf: [], lastPoll: Date.now(), ip };
    f.subId = this.hub.subscribe(kind === "logs" ? "logs" : "newHeads", parsed, (r) => {
      f.buf.push(kind === "logs" ? r : (r as { hash: string }).hash);
      if (f.buf.length > MAX_FILTER_BUFFER) f.buf.splice(0, f.buf.length - MAX_FILTER_BUFFER);
    });
    this.filters.set(fid, f);
    this.filtersPerIp.set(ip, (this.filtersPerIp.get(ip) ?? 0) + 1);
    return fid;
  }

  private filter(id: unknown): ServerFilter {
    const f = this.filters.get(String(id ?? ""));
    if (!f) throw new MethodError(-32000, "filter not found");
    return f;
  }

  private dropFilter(fid: string, f: ServerFilter): void {
    this.hub.unsubscribe(f.subId);
    this.filters.delete(fid);
    const n = (this.filtersPerIp.get(f.ip) ?? 1) - 1;
    if (n <= 0) this.filtersPerIp.delete(f.ip);
    else this.filtersPerIp.set(f.ip, n);
  }

  /** Filters nobody polled for 5 minutes are removed (geth behaves the same). */
  sweep(now = Date.now()): void {
    for (const [fid, f] of this.filters) if (now - f.lastPoll > FILTER_TTL_MS) this.dropFilter(fid, f);
  }

  /** Called when a WebSocket closes. */
  release(conn: Conn): void {
    for (const id of conn.subs) this.hub.unsubscribe(id);
    conn.subs.clear();
  }

  stop(): void {
    clearInterval(this.sweeper);
  }
}

class MethodError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

// ───────── rate limiting ─────────

/** Token bucket: `rate` requests per second, bursts up to `burst`. */
export class Bucket {
  private rate: number;
  private burst: number;
  private tokens: number;
  private at = Date.now();
  constructor(rate: number, burst: number) {
    this.rate = rate;
    this.burst = burst;
    this.tokens = burst;
  }
  take(n = 1): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.at) / 1000) * this.rate);
    this.at = now;
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}

/** Per-IP buckets shared by HTTP and WebSocket traffic. */
export class IpLimiter {
  private buckets = new Map<string, Bucket>();
  private rate: number;
  private burst: number;
  constructor(rate = 25, burst = 100) {
    this.rate = rate;
    this.burst = burst;
  }
  take(ip: string, n = 1): boolean {
    let b = this.buckets.get(ip);
    if (!b) {
      if (this.buckets.size > 10_000) this.buckets.clear();
      b = new Bucket(this.rate, this.burst);
      this.buckets.set(ip, b);
    }
    return b.take(n);
  }
}

export function ipOf(req: IncomingMessage, header: string): string {
  if (header) {
    const raw = req.headers[header];
    const v = (Array.isArray(raw) ? raw[0] : raw)?.split(",").at(-1)?.trim();
    if (v) return v;
  }
  return req.socket.remoteAddress ?? "local";
}

// ───────── WebSocket server ─────────

export const RPC_PATHS = new Set(["/rpc", "/api/rpc"]);
const MAX_CONNS_PER_IP = 20;
/** A client that stops reading gets disconnected instead of growing our memory. */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

export type WsServer = { wss: WebSocketServer; connections: () => number; close: () => void };

export function attachWebSocket(server: Server, gw: RpcGateway, limiter: IpLimiter, clientIpHeader: string): WsServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  const perIp = new Map<string, number>();
  const alive = new WeakMap<WebSocket, boolean>();

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (!RPC_PATHS.has(path)) {
      socket.write("HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const ip = ipOf(req, clientIpHeader);
    if ((perIp.get(ip) ?? 0) >= MAX_CONNS_PER_IP) {
      socket.write("HTTP/1.1 429 Too Many Requests\r\nconnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
      alive.set(ws, true);
      const send = (data: unknown) => {
        if (ws.readyState !== ws.OPEN) return;
        if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
          ws.close(1013, "client too slow");
          return;
        }
        ws.send(JSON.stringify(data));
      };
      const held = new Map<string, unknown[]>();
      const notification = (subscription: string, result: unknown) => ({ jsonrpc: "2.0", method: "eth_subscription", params: { subscription, result } });
      const conn: Conn = {
        subs: new Set(),
        notify: (subscription, result) => {
          const q = held.get(subscription);
          if (q) q.push(result);
          else send(notification(subscription, result));
        },
        hold: (subscription) => held.set(subscription, []),
      };
      const release = () => {
        for (const [subscription, q] of held) for (const r of q) send(notification(subscription, r));
        held.clear();
      };
      ws.on("pong", () => alive.set(ws, true));
      ws.on("message", async (data) => {
        let msg: unknown;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          send(fail(null, -32700, "parse error"));
          return;
        }
        if (!limiter.take(ip, RpcGateway.weight(msg))) {
          send(fail((msg as JsonRpcReq)?.id, -32005, "rate limit exceeded"));
          return;
        }
        const res = await gw.handle(msg, conn, ip);
        if (res !== null) send(res);
        release();
      });
      ws.on("close", () => {
        gw.release(conn);
        const n = (perIp.get(ip) ?? 1) - 1;
        if (n <= 0) perIp.delete(ip);
        else perIp.set(ip, n);
      });
      ws.on("error", () => ws.terminate());
    });
  });

  // Drop connections whose peer vanished without closing (mobile networks, crashed clients).
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.get(ws)) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, 30_000);
  heartbeat.unref();

  return {
    wss,
    connections: () => wss.clients.size,
    close: () => {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}
