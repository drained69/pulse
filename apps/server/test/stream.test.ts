import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { serve } from "@hono/node-server";
import { createPublicClient, encodeAbiParameters, encodeEventTopics, http, parseAbi, webSocket, type Hex } from "viem";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { buildApp, buildServices } from "../src/main.ts";
import { Metrics, pct } from "../src/metrics.ts";
import { StaticNameResolver } from "../src/names.ts";
import { attachWebSocket, logMatches, parseLogFilter, ParamError, RpcGateway, StreamHub, type WsServer } from "../src/stream.ts";

const TOKEN = "0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5";
const OTHER = "0x0087904D95BEe9E5F24dc8852804b547981A9139";
const ALICE = "0x172083F7f31f82e4B57bA8aCf9822C72BB35b174";
const BOB = "0x0000000000000000000000000000000000000b0b";
const erc20 = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);

const hex = (n: number) => `0x${n.toString(16)}`;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

/** A tiny fake QIE node: blocks appear when the test calls `mine()`. */
function fakeChain() {
  let head = 100;
  let hideHead = false;
  let dropLogs = false;
  const logs = new Map<string, unknown[]>();
  const calls: string[] = [];
  const block = (n: number) => ({
    number: hex(n),
    hash: hash(n),
    parentHash: hash(n - 1),
    timestamp: hex(Math.floor(Date.now() / 1000)),
    gasLimit: "0xffffffff",
    gasUsed: "0x0",
    baseFeePerGas: "0x3b9aca00",
    miner: "0x444e2b928e60f537ac267261029cd4bbac583a54",
    extraData: "0x",
    logsBloom: `0x${(logs.get(hash(n))?.length ? "1" : "0").padEnd(512, "0")}`,
    difficulty: "0x0",
    totalDifficulty: "0x0",
    nonce: "0x0000000000000000",
    mixHash: hash(0),
    sha3Uncles: hash(0),
    stateRoot: hash(0),
    receiptsRoot: hash(0),
    transactionsRoot: hash(0),
    size: "0x100",
    transactions: [],
    uncles: [],
  });
  const answer = (r: { id: number; method: string; params: any[] }) => {
    calls.push(r.method);
    const res = (result: unknown) => ({ jsonrpc: "2.0", id: r.id, result });
    switch (r.method) {
      case "eth_blockNumber":
        return res(hex(head));
      case "eth_chainId":
        return res("0x7c6");
      case "eth_getBalance":
        return res("0x2a");
      case "eth_getBlockByNumber": {
        const n = r.params[0] === "latest" ? head : Number.parseInt(r.params[0], 16);
        return res(n > head || (hideHead && n === head) ? null : block(n));
      }
      case "eth_getLogs": {
        const f = r.params[0] ?? {};
        if (dropLogs) return res([]);
        if (f.blockHash) return res(logs.get(f.blockHash) ?? []);
        const out: unknown[] = [];
        const to = Math.min(head - (hideHead ? 1 : 0), Number.parseInt(f.toBlock, 16));
        for (let n = Number.parseInt(f.fromBlock, 16); n <= to; n++) out.push(...(logs.get(hash(n)) ?? []));
        return res(out);
      }
      default:
        return { jsonrpc: "2.0", id: r.id, error: { code: -32601, message: `fake: ${r.method}` } };
    }
  };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const msg = JSON.parse(body);
      const out = Array.isArray(msg) ? msg.map(answer) : answer(msg);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
    });
  });
  let logIndex = 0;
  return {
    server,
    calls,
    get head() {
      return head;
    },
    set hideHead(v: boolean) {
      hideHead = v;
    },
    set dropLogs(v: boolean) {
      dropLogs = v;
    },
    /** Produce a block, optionally with Transfer logs. */
    mine(transfers: { address: string; from: string; to: string; value: bigint }[] = []) {
      head++;
      logs.set(
        hash(head),
        transfers.map((t, i) => ({
          address: t.address.toLowerCase(),
          topics: encodeEventTopics({ abi: erc20, eventName: "Transfer", args: { from: t.from as Hex, to: t.to as Hex } }),
          data: encodeAbiParameters([{ type: "uint256" }], [t.value]),
          blockNumber: hex(head),
          blockHash: hash(head),
          transactionHash: hash(10_000 + head * 10 + i),
          transactionIndex: hex(i),
          logIndex: hex(logIndex++),
        })),
      );
      return head;
    },
  };
}

function waitFor<T>(check: () => T | undefined, ms = 4000): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const t = setInterval(() => {
      const v = check();
      if (v !== undefined) {
        clearInterval(t);
        resolve(v);
      } else if (Date.now() - started > ms) {
        clearInterval(t);
        reject(new Error("timed out"));
      }
    }, 10);
  });
}

describe("WebSocket eth_subscribe gateway", () => {
  const chain = fakeChain();
  let server: Server;
  let ws: WsServer;
  let base = "";
  let s: ReturnType<typeof buildServices>;

  before(async () => {
    await new Promise<void>((r) => chain.server.listen(0, "127.0.0.1", r));
    const rpc = `http://127.0.0.1:${(chain.server.address() as AddressInfo).port}`;
    const cfg = loadConfig({ DB_PATH: ":memory:", RPC_URLS: rpc, POLL_INTERVAL_MS: "40", TELEGRAM_BOT_TOKEN: "" } as NodeJS.ProcessEnv);
    s = buildServices(cfg, { db: openDb(":memory:"), names: new StaticNameResolver({}) });
    const app = buildApp(s);
    server = await new Promise<Server>((r) => {
      const srv = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => r(srv as Server)) as Server;
    });
    ws = attachWebSocket(server, s.gateway, s.rpcLimiter, "");
    s.wsConnections = ws.connections;
    base = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => {
    s.stream.stop();
    s.gateway.stop();
    ws.close();
    server.close();
    chain.server.close();
  });

  it("streams new blocks to viem's watchBlocks over WebSocket", async () => {
    const client = createPublicClient({ transport: webSocket(`ws://${base}/rpc`) });
    const seen: bigint[] = [];
    const unwatch = client.watchBlocks({ onBlock: (b) => seen.push(b.number!) });
    await waitFor(() => (s.stream.size > 0 ? true : undefined));
    await new Promise((r) => setTimeout(r, 120)); // let the hub pick up the current head
    const a = chain.mine();
    const b = chain.mine();
    await waitFor(() => (seen.length >= 2 ? true : undefined));
    assert.deepEqual(seen.slice(0, 2), [BigInt(a), BigInt(b)]);
    unwatch();
    await waitFor(() => (s.stream.size === 0 ? true : undefined));
    await (await client.transport.getRpcClient()).close();
  });

  it("delivers only matching logs to watchContractEvent, decoded by viem", async () => {
    const client = createPublicClient({ transport: webSocket(`ws://${base}/rpc`) });
    const got: { from: string; to: string; value: bigint; blockNumber: bigint }[] = [];
    const unwatch = client.watchContractEvent({
      address: TOKEN,
      abi: erc20,
      eventName: "Transfer",
      args: { to: BOB },
      onLogs: (logs) => {
        for (const l of logs) got.push({ from: l.args.from!, to: l.args.to!, value: l.args.value!, blockNumber: l.blockNumber! });
      },
    });
    await waitFor(() => (s.stream.size > 0 ? true : undefined));
    await new Promise((r) => setTimeout(r, 120));
    const n = chain.mine([
      { address: TOKEN, from: ALICE, to: BOB, value: 5_000_000n }, // match
      { address: OTHER, from: ALICE, to: BOB, value: 1n }, // wrong contract
      { address: TOKEN, from: BOB, to: ALICE, value: 2n }, // wrong recipient
    ]);
    await waitFor(() => (got.length ? true : undefined));
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(got.length, 1);
    assert.equal(got[0]!.value, 5_000_000n);
    assert.equal(got[0]!.from.toLowerCase(), ALICE.toLowerCase());
    assert.equal(got[0]!.blockNumber, BigInt(n));
    unwatch();
    await (await client.transport.getRpcClient()).close();
  });

  it("makes eth_newFilter work over plain HTTP, across a load-balanced pool", async () => {
    const client = createPublicClient({ transport: http(`http://${base}/rpc`), pollingInterval: 50 });
    const got: bigint[] = [];
    const unwatch = client.watchContractEvent({ address: TOKEN, abi: erc20, eventName: "Transfer", onLogs: (ls) => ls.forEach((l) => got.push(l.args.value!)) });
    await waitFor(() => (s.gateway.filterCount > 0 ? true : undefined));
    await new Promise((r) => setTimeout(r, 120));
    chain.mine([{ address: TOKEN, from: ALICE, to: BOB, value: 77n }]);
    await waitFor(() => (got.length ? true : undefined));
    assert.deepEqual(got, [77n]);
    assert.ok(!chain.calls.includes("eth_newFilter"), "filters live in Pulse, not on one upstream node");
    unwatch();
    await waitFor(() => (s.gateway.filterCount === 0 ? true : undefined)); // viem uninstalls its filter
    await new Promise((r) => setTimeout(r, 100));
  });

  it("forwards ordinary calls and answers eth_chainId locally", async () => {
    const client = createPublicClient({ transport: webSocket(`ws://${base}/rpc`) });
    assert.equal(await client.getBalance({ address: ALICE }), 42n);
    assert.equal(await client.getChainId(), 1990);
    await (await client.transport.getRpcClient()).close();
  });

  it("does not emit a block until the upstream node can serve it", async () => {
    const hub = new StreamHub(s.rpc, null, { pollMs: 1_000_000 });
    const heads: string[] = [];
    hub.subscribe("newHeads", null, (h) => heads.push((h as { number: string }).number));
    await hub.tick(); // anchors at the current head
    chain.hideHead = true;
    const n = chain.mine();
    assert.equal(await hub.tick(), 0);
    chain.hideHead = false;
    assert.equal(await hub.tick(), 1);
    assert.deepEqual(heads, [hex(n)]);
    hub.stop();
  });

  it("never emits a block whose logs the node has not indexed yet (bloom check)", async () => {
    const hub = new StreamHub(s.rpc, null, { pollMs: 1_000_000 });
    const got: string[] = [];
    hub.subscribe("logs", parseLogFilter({ address: TOKEN }), (l) => got.push((l as { blockNumber: string }).blockNumber));
    await hub.tick();
    const n = chain.mine([{ address: TOKEN, from: ALICE, to: BOB, value: 1n }]);
    chain.dropLogs = true; // header is served, logs are not (yet)
    assert.equal(await hub.tick(), 0);
    chain.dropLogs = false;
    assert.equal(await hub.tick(), 1);
    assert.deepEqual(got, [hex(n)]);
    hub.stop();
  });

  it("indexer waits for a node that has the whole range instead of indexing a gap", async () => {
    s.indexer.setCursor(chain.head);
    chain.hideHead = true;
    chain.mine(); // eth_blockNumber reports it, but this node cannot serve it yet
    assert.equal(await s.indexer.tick(), 0);
    assert.equal(s.indexer.status.cursor, chain.head - 1, "cursor must not move past a block we did not read");
    chain.hideHead = false;
    assert.equal(await s.indexer.tick(), 1);
    assert.equal(s.indexer.status.cursor, chain.head);
  });

  it("rejects bad requests with standard JSON-RPC errors", async () => {
    const post = async (body: unknown) => (await fetch(`http://${base}/rpc`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json() as Promise<any>;
    assert.equal((await post({ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: ["newHeads"] })).error.code, -32601);
    assert.equal((await post({ jsonrpc: "2.0", id: 2, method: "eth_sendTransaction", params: [{}] })).error.code, -32601);
    assert.equal((await post({ jsonrpc: "2.0", id: 3, method: "debug_traceTransaction", params: [] })).error.code, -32601);
    assert.equal((await post({ jsonrpc: "2.0", id: 4, method: "eth_newFilter", params: [{ address: "0xnope" }] })).error.code, -32602);
    const batch = await post([
      { jsonrpc: "2.0", id: 5, method: "eth_chainId" },
      { jsonrpc: "2.0", id: 6, method: "eth_getBalance", params: [ALICE, "latest"] },
    ]);
    assert.deepEqual(batch.map((r: any) => r.result), ["0x7c6", "0x2a"]);
    const raw = await fetch(`http://${base}/rpc`, { method: "POST", body: "{nope" });
    assert.equal(((await raw.json()) as any).error.code, -32700);
  });

  it("reports live stream status on /api/status", async () => {
    const st = (await (await fetch(`http://${base}/api/status`)).json()) as any;
    assert.ok(st.stream.blocksStreamed >= 2);
    assert.ok(st.latency.stream.count >= 1);
    assert.equal(typeof st.latency.stream.p50, "number");
  });
});

describe("log filters", () => {
  const log = (address: string, topics: string[]) => ({ address, topics, data: "0x", blockNumber: "0x1", transactionHash: hash(1), transactionIndex: "0x0", logIndex: "0x0", blockHash: hash(1) }) as any;
  const T0 = hash(0xaa);
  const T1 = hash(0xbb);

  it("matches address sets and positional topic alternatives", () => {
    const f = parseLogFilter({ address: [TOKEN, OTHER], topics: [T0, null, [T1, T0]] });
    assert.ok(logMatches(f, log(TOKEN.toLowerCase(), [T0, T1, T1])));
    assert.ok(!logMatches(f, log(ALICE, [T0, T1, T1])));
    assert.ok(!logMatches(f, log(TOKEN, [T1, T1, T1])));
    assert.ok(!logMatches(f, log(TOKEN, [T0, T1])), "missing third topic");
    assert.ok(logMatches(parseLogFilter(undefined), log(ALICE, [])));
  });

  it("rejects malformed filters", () => {
    assert.throws(() => parseLogFilter({ address: "0x12" }), ParamError);
    assert.throws(() => parseLogFilter({ topics: ["0xzz"] }), ParamError);
    assert.throws(() => parseLogFilter({ topics: [null, null, null, null, null] }), ParamError);
    assert.throws(() => parseLogFilter([]), ParamError);
  });

  it("expires server-side filters nobody polls", async () => {
    const cfg = loadConfig({ DB_PATH: ":memory:", RPC_URLS: "http://127.0.0.1:1" } as NodeJS.ProcessEnv);
    const s = buildServices(cfg, { db: openDb(":memory:"), names: new StaticNameResolver({}) });
    const gw = new RpcGateway(cfg, s.rpc, new StreamHub(s.rpc, null, { pollMs: 1_000_000 }));
    const res = (await gw.handle({ jsonrpc: "2.0", id: 1, method: "eth_newBlockFilter" }, null)) as any;
    assert.equal(gw.filterCount, 1);
    gw.sweep(Date.now() + 6 * 60_000);
    assert.equal(gw.filterCount, 0);
    const gone = (await gw.handle({ jsonrpc: "2.0", id: 2, method: "eth_getFilterChanges", params: [res.result] }, null)) as any;
    assert.equal(gone.error.message, "filter not found");
    gw.hub.stop();
    gw.stop();
  });
});

describe("latency metrics", () => {
  it("computes nearest-rank percentiles", () => {
    const v = Array.from({ length: 100 }, (_, i) => i + 1);
    assert.equal(pct(v, 50), 50);
    assert.equal(pct(v, 95), 95);
    assert.equal(pct([7], 99), 7);
    assert.equal(pct([], 50), null);
  });

  it("measures from the block timestamp and ignores catch-up after downtime", () => {
    const m = new Metrics(openDb(":memory:"));
    const now = 1_800_000_000_000;
    m.record("deliver", now / 1000 - 2, now);
    m.record("deliver", now / 1000 - 1, now);
    m.record("deliver", now / 1000 - 3600, now); // an hour late: backlog, not live latency
    m.record("deliver", null, now);
    const st = m.stats("deliver", 24 * 3600_000, now);
    assert.equal(st.count, 2);
    assert.equal(st.p50, 1000);
    assert.equal(st.max, 2000);
  });
});
