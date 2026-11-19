import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { encodeAbiParameters, encodeEventTopics, getAddress } from "viem";
import { backfillSubscriptions, planFor, type UserRow } from "../src/billing.ts";
import { SUBSCRIBED_EVENT } from "../src/chain.ts";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { RpcPool } from "../src/rpc.ts";

const BILLING = "0x9999999999999999999999999999999999999999";
const PAYER = getAddress("0x1111111111111111111111111111111111111111");

describe("billing history catch-up", () => {
  const ranges: [number, number][] = [];
  const paidUntil = BigInt(Math.floor(Date.now() / 1000) + 30 * 86400);
  const subscribed = {
    address: BILLING,
    topics: encodeEventTopics({ abi: [SUBSCRIBED_EVENT], args: { account: PAYER, planId: 1 } }),
    data: encodeAbiParameters([{ type: "uint32" }, { type: "uint256" }, { type: "uint64" }], [1, 9_000_000n, paidUntil]),
    blockNumber: "0x2af8", // 11000: before the server ever started
    transactionHash: `0x${"ab".repeat(32)}`,
    transactionIndex: "0x0",
    logIndex: "0x0",
    blockHash: `0x${"00".repeat(32)}`,
  };
  const node = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const r = JSON.parse(body);
      let result: unknown = null;
      if (r.method === "eth_blockNumber") result = "0x4e20"; // 20000
      if (r.method === "eth_getLogs") {
        const f = r.params[0];
        const [from, to] = [Number.parseInt(f.fromBlock, 16), Number.parseInt(f.toBlock, 16)];
        ranges.push([from, to]);
        result = from <= 11000 && 11000 <= to && f.address.toLowerCase() === BILLING ? [subscribed] : [];
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: r.id, result }));
    });
  });
  let url = "";
  before(async () => {
    await new Promise<void>((r) => node.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(node.address() as AddressInfo).port}`;
  });
  after(() => node.close());

  it("unlocks Pro for a payment made before the server started, in bounded chunks, once", async () => {
    const cfg = loadConfig({ DB_PATH: ":memory:", RPC_URLS: url, BILLING_CONTRACT: BILLING, BILLING_START_BLOCK: "10000" } as NodeJS.ProcessEnv);
    const db = openDb(":memory:");
    const rpc = new RpcPool([url]);
    assert.equal(await backfillSubscriptions(cfg, db, rpc), 1);
    const user = db.prepare("SELECT * FROM users WHERE address = ?").get(PAYER) as UserRow;
    assert.equal(planFor(cfg, user).id, "pro");
    assert.deepEqual(ranges, [
      [10000, 14999],
      [15000, 19999],
      [20000, 20000],
    ]);
    // Progress is saved: a restart scans nothing new and applies nothing twice.
    ranges.length = 0;
    assert.equal(await backfillSubscriptions(cfg, db, rpc), 0);
    assert.deepEqual(ranges, []);
  });

  it("does nothing without a billing contract or start block", async () => {
    const db = openDb(":memory:");
    const rpc = new RpcPool([url]);
    assert.equal(await backfillSubscriptions(loadConfig({ DB_PATH: ":memory:", RPC_URLS: url } as NodeJS.ProcessEnv), db, rpc), 0);
    assert.equal(await backfillSubscriptions(loadConfig({ DB_PATH: ":memory:", RPC_URLS: url, BILLING_CONTRACT: BILLING } as NodeJS.ProcessEnv), db, rpc), 0);
  });
});
