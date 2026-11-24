import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeAbiParameters, type Hex } from "viem";
import { ensureUser } from "../src/billing.ts";
import { KNOWN_TOKENS, QIE_MAINNET, TOPIC, type RpcBlock, type RpcLog } from "../src/chain.ts";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import type { HookService } from "../src/hooks.ts";
import { Indexer, NodeBehindError } from "../src/indexer.ts";
import { isCompleteBlockLogs, logsBloomFor } from "../src/log-completeness.ts";
import { StaticNameResolver } from "../src/names.ts";
import { ProjectService } from "../src/projects.ts";
import type { RpcPool } from "../src/rpc.ts";
import type { TokenService } from "../src/tokens.ts";
import { HookIndex, type HookRow } from "../src/triggers.ts";

const SHOP = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const PAIR = "0x3333333333333333333333333333333333333333";
const BLOCK = `0x${"aa".repeat(32)}` as Hex;
const makeLog = (n: number, address = PAIR): RpcLog => ({
  address: address as Hex, topics: [TOPIC.SYNC], data: encodeAbiParameters([{ type: "uint112" }, { type: "uint112" }], [500n, 500n]),
  blockNumber: "0x1", blockHash: BLOCK, transactionHash: `0x${n.toString(16).padStart(64, "0")}`, transactionIndex: "0x0", logIndex: `0x${n.toString(16)}`,
});
const hook = (type: string, config: unknown): HookRow => ({ id: "hk_audit", user_id: "u", name: "Audit", trigger_type: type, trigger_config: JSON.stringify(config), resolved: "{}", channel_type: "webhook", channel_config: "{}", secret: "s", active: 1, fire_count: 0, last_fired_at: null, created_at: 0, updated_at: 0 } as HookRow);

function harness(h: HookRow, logs: RpcLog[], bloom = logsBloomFor(logs)) {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO users (id,address,plan,created_at) VALUES ('u',?,'free',0)").run(SHOP);
  db.prepare("INSERT INTO hooks (id,user_id,name,trigger_type,trigger_config,channel_type,channel_config,secret,created_at,updated_at) VALUES (?,?,?,?,?,'webhook','{}','s',0,0)").run(h.id, h.user_id, h.name, h.trigger_type, h.trigger_config);
  const header = { number: "0x1", hash: BLOCK, timestamp: "0x64", transactions: [], logsBloom: bloom };
  const state = { logs, records: 0, failRecord: false, demoted: 0 };
  const rpc = {
    call: async () => "0x1",
    batch: async (calls: { method: string }[]) => calls.map(c => c.method === "eth_getLogs" ? state.logs : header),
    demote: () => { state.demoted++; },
  } as unknown as RpcPool;
  const hooks = { getIndex: () => HookIndex.build([h]), recordEvent: () => { if (state.failRecord) throw new Error("simulated outbox failure"); state.records++; return true; } } as unknown as HookService;
  const tokens = { refreshPairs: async () => {}, token: async (a: string) => KNOWN_TOKENS[a.toLowerCase()] ?? { address: a, symbol: "TOK", decimals: 6 }, pair: async () => null, priceUsd: () => null } as unknown as TokenService;
  const indexer = new Indexer(loadConfig({ DB_PATH: ":memory:", START_BLOCK: "1" } as NodeJS.ProcessEnv), db, rpc, hooks, new StaticNameResolver({}), tokens);
  return { db, state, indexer, header };
}

describe("audit: log response consistency and durable liquidity state", () => {
  it("rejects nonempty partial responses, wrong block hashes, and duplicates", () => {
    const logs = [makeLog(1), makeLog(2, OTHER)];
    const block = { number: "0x1", hash: BLOCK, logsBloom: logsBloomFor(logs) };
    assert.equal(isCompleteBlockLogs(block, logs), true);
    assert.equal(isCompleteBlockLogs({ ...block, logsBloom: undefined }, logs), false);
    assert.equal(isCompleteBlockLogs(block, [{ ...logs[0]!, blockHash: undefined as never }, logs[1]!]), false);
    assert.equal(isCompleteBlockLogs(block, [logs[0]!]), false);
    assert.equal(isCompleteBlockLogs(block, [{ ...logs[0]!, blockHash: `0x${"bb".repeat(32)}` }, logs[1]!]), false);
    assert.equal(isCompleteBlockLogs(block, [logs[0]!, logs[0]!, logs[1]!]), false);
  });

  it("never skips a bloom mismatch after repeated failures", async () => {
    const log = makeLog(1);
    const h = harness(hook("liquidity", { pair: PAIR, dropPercent: 30 }), [], logsBloomFor([log]));
    try {
      for (let i = 0; i < 25; i++) await assert.rejects(h.indexer.processRange(1, 1), NodeBehindError);
      assert.equal(h.state.records, 0);
      h.state.logs = [log];
      await h.indexer.processRange(1, 1);
      assert.equal(h.state.demoted, 25);
    } finally { h.db.close(); }
  });

  it("keeps liquidity armed when the event/outbox write fails, then fires on retry", async () => {
    const h = harness(hook("liquidity", { pair: PAIR, dropPercent: 30 }), [makeLog(1)]);
    h.db.prepare("INSERT INTO trigger_state(hook_id,state,updated_at) VALUES (?,?,0)").run("hk_audit", JSON.stringify({ peak: "1000", peakAt: 99, armed: true }));
    try {
      h.state.failRecord = true;
      await assert.rejects(h.indexer.processRange(1, 1), /simulated outbox failure/);
      const state = () => JSON.parse((h.db.prepare("SELECT state FROM trigger_state WHERE hook_id='hk_audit'").get() as { state: string }).state);
      assert.equal(state().armed, true);
      h.state.failRecord = false;
      await h.indexer.processRange(1, 1);
      assert.equal(h.state.records, 1);
      assert.equal(state().armed, false);
    } finally { h.db.close(); }
  });

  it("propagates invoice persistence failures instead of advancing its cursor", async () => {
    const l = { ...makeLog(1), address: QIE_MAINNET.QUSDC, topics: [TOPIC.TRANSFER, `0x${"0".repeat(24)}${OTHER.slice(2)}`, `0x${"0".repeat(24)}${SHOP.slice(2)}`] as Hex[] };
    const h = harness(hook("payment", { recipient: SHOP, assets: ["QUSDC"] }), [l]);
    h.indexer.invoices = { watched: () => new Map([[SHOP.toLowerCase(), true]]), needsNative: () => false, matchLog: async () => { throw new Error("invoice database unavailable"); } } as never;
    try {
      h.indexer.setCursor(0);
      await assert.rejects(h.indexer.tick(), /invoice database unavailable/);
      assert.equal(h.indexer.status.cursor, 0);
    } finally { h.db.close(); }
  });
});

describe("audit: protected infrastructure ownership", () => {
  it("does not let ownership of an unrelated contract authorize listing QUSDC", async () => {
    const db = openDb(":memory:");const cfg = loadConfig({ DB_PATH: ":memory:" } as NodeJS.ProcessEnv);
    const user = ensureUser(db, SHOP);
    const rpc = { batch: async () => ["0x6080", "0x6080"] } as unknown as RpcPool;
    const service = new ProjectService(cfg, db, rpc);
    service.verifyOwner = async (_address, contracts) => contracts.includes(PAIR) ? "deployer" : null;
    try {
      await assert.rejects(service.create(user, { name: "Borrow ecosystem", contracts: [PAIR, QIE_MAINNET.QUSDC] }), /shared QIE infrastructure/);
      assert.equal((db.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }).n, 0);
    } finally { db.close(); }
  });
});
