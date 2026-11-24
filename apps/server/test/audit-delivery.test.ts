import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EventEmitter } from "node:events";
import type { Server, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { loadConfig } from "../src/config.ts";
import type { RpcPool } from "../src/rpc.ts";
import { assertPublicUrl, isBlockedIp } from "../src/ssrf.ts";
import { attachWebSocket, IpLimiter, MAX_FILTERS_PER_IP, MAX_LOG_RANGE, RpcGateway, type StreamHub } from "../src/stream.ts";

function gatewayFixture(initialHead = 100) {
  const forwarded: { method: string; params: unknown[] }[] = [];
  let head = initialHead;
  let nextSub = 0;
  const live = new Set<string>();
  const hub = {
    status: { head: null as number | null },
    subscribe: () => { const id = String(++nextSub); live.add(id); return id; },
    unsubscribe: (id: string) => live.delete(id),
  } as unknown as StreamHub;
  const rpc = { call: async (method: string, params: unknown[] = []) => {
    forwarded.push({ method, params });
    return method === "eth_blockNumber" ? `0x${head.toString(16)}` : [];
  } } as unknown as RpcPool;
  const gateway = new RpcGateway(loadConfig({ DB_PATH: ":memory:" }), rpc, hub);
  return { gateway, live, forwarded, advance: (n: number) => { head = n; hub.status.head = n; } };
}

describe("audit: public RPC filter resource limits", () => {
  it("enforces the per-client filter limit across an asynchronous JSON-RPC batch", async () => {
    const f = gatewayFixture();
    try {
      const requests = Array.from({ length: MAX_FILTERS_PER_IP + 1 }, (_, id) => ({
        jsonrpc: "2.0", id, method: "eth_newFilter", params: [{ fromBlock: "latest", toBlock: "latest" }],
      }));
      const result = await f.gateway.handle(requests, null, "198.51.100.4") as { result?: string; error?: { code: number } }[];
      assert.equal(result.filter(r => r.result).length, MAX_FILTERS_PER_IP);
      assert.equal(result.filter(r => r.error?.code === -32005).length, 1);
      assert.equal(f.gateway.filterCount, MAX_FILTERS_PER_IP);
      assert.equal(f.live.size, MAX_FILTERS_PER_IP, "rejected creations must not leak subscriptions");
      const other = await f.gateway.handle({ id: 99, method: "eth_newBlockFilter" }, null, "198.51.100.5") as { result?: string };
      assert.ok(other.result, "another client's allocation is unaffected");
    } finally { f.gateway.stop(); }
  });

  it("rechecks a stored filter's dynamic range before every upstream log query", async () => {
    const f = gatewayFixture(MAX_LOG_RANGE);
    try {
      const made = await f.gateway.handle({ id: 1, method: "eth_newFilter", params: [{ fromBlock: "0x1", toBlock: "latest" }] }, null) as { result: string };
      assert.ok(made.result);
      f.advance(MAX_LOG_RANGE + 1);
      const result = await f.gateway.handle({ id: 2, method: "eth_getFilterLogs", params: [made.result] }, null) as { error?: { code: number } };
      assert.equal(result.error?.code, -32005, "a once-valid latest range must not become an unbounded query");
      assert.equal(f.forwarded.filter(c => c.method === "eth_getLogs").length, 0);
    } finally { f.gateway.stop(); }
  });
});

describe("audit: private IPv6 webhook destinations", () => {
  it("rejects site-local IPv6 literals before a request can be opened", async () => {
    for (const ip of ["fec0::1", "fedf::1234", "feff:ffff::1"]) {
      assert.equal(isBlockedIp(ip), true, ip);
      await assert.rejects(assertPublicUrl(`https://[${ip}]/hook`, false), /private or reserved/);
    }
    assert.equal(isBlockedIp("2606:4700:4700::1111"), false, "public IPv6 destinations still work");
  });
});


describe("audit: malformed WebSocket upgrades", () => {
  it("rejects invalid request targets without throwing out of the server's upgrade callback", () => {
    const server = new EventEmitter() as unknown as Server;
    const ws = attachWebSocket(server, {} as RpcGateway, new IpLimiter(), "");
    let written = "";
    let destroyed = false;
    const socket = { write: (value: string) => { written += value; }, destroy: () => { destroyed = true; } } as unknown as Duplex;
    try {
      const req = { url: "http://[", headers: {}, socket: { remoteAddress: "198.51.100.4" } } as unknown as IncomingMessage;
      assert.doesNotThrow(() => server.emit("upgrade", req, socket, Buffer.alloc(0)));
      assert.match(written, /^HTTP\/1\.1 400 Bad Request/);
      assert.equal(destroyed, true);
    } finally { ws.close(); }
  });
});
