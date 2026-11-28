import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { encodeFunctionData, encodeFunctionResult } from "viem";
import { ORACLE_FEED_NAMES, QIE_ORACLES } from "../src/chain.ts";
import { ensureUser } from "../src/billing.ts";
import { scheduledPayload } from "../src/payload.ts";
import { Checks } from "../src/checks.ts";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { buildApp, buildServices } from "../src/main.ts";
import { StaticNameResolver } from "../src/names.ts";
import { AGGREGATOR_V3_ABI, OracleService } from "../src/oracles.ts";
import { describe as describePayload, type EventPayload } from "../src/payload.ts";
import { SCHEDULED_TYPES, triggerSchemas } from "../src/triggers.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });
const OWNER = "0x172083F7f31f82e4B57bA8aCf9822C72BB35b174";
function fixture() {
  const cfg = loadConfig({ DB_PATH: ":memory:", RPC_URLS: "http://127.0.0.1:1", QIEDEX_API_URL: "http://127.0.0.1:1", ALLOW_PRIVATE_WEBHOOKS: "true" });
  const db = openDb(":memory:");
  const s = buildServices(cfg, { db, names: new StaticNameResolver({}) });
  cleanup.push(() => { s.rpc.stop(); s.gatewayRpc.stop(); s.stream.stop(); db.close(); });
  const state = { now: Date.now(), answer: 6_500_000_000_000n, age: 60, roundId: 42n, answeredInRound: 42n, future: false, malformed: false, fail: false, calls: 0, lastCalls: [] as { method: string; params: unknown[] }[] };
  s.rpc.batch = async <T>(calls: { method: string; params: unknown[] }[]): Promise<T[]> => {
    state.calls++; state.lastCalls = calls;
    if (state.fail) throw new Error("RPC unavailable");
    const at = BigInt(Math.floor(state.now / 1000) + (state.future ? 60 : -state.age));
    const data = state.malformed ? "0x" : encodeFunctionResult({ abi: AGGREGATOR_V3_ABI, functionName: "latestRoundData", result: [state.roundId, state.answer, at, at, state.answeredInRound] });
    return calls.map(() => data as T);
  };
  s.oracles = new OracleService(cfg, s.rpc, () => state.now);
  s.checks = new Checks(cfg, db, s.rpc, s.hooks, s.names, s.tokens, s.oracles);
  const user = ensureUser(db, OWNER);
  const add = (config: { feed: string; above?: number; below?: number }) => s.hooks.create(user, { name: "Oracle test", trigger: { type: "oracle_price", config }, channel: { type: "webhook", config: { url: "http://127.0.0.1:1/oracle-test" } } });
  const events = () => (db.prepare("SELECT payload FROM events ORDER BY rowid").all() as { payload: string }[]).map((r) => JSON.parse(r.payload) as EventPayload);
  const next = () => { state.now += 60_001; };
  return { cfg, s, db, state, add, events, next, user };
}

describe("QIE Oracles", () => {
  it("decodes 8-decimal rounds in one batch and shares the 60-second cache", async () => {
    const { s, state, next } = fixture(); state.answer = 6_060_612_345_678n;
    const [first, second] = await Promise.all([s.oracles.prices(), s.oracles.prices()]);
    assert.equal(state.calls, 1); assert.equal(state.lastCalls.length, 6); assert.deepEqual(first, second);
    assert.equal(first[1]!.price, 60606.12345678); assert.equal(first[1]!.decimals, 8); assert.equal(first[1]!.roundId, "42"); assert.equal(first[1]!.stale, false);
    const data = encodeFunctionData({ abi: AGGREGATOR_V3_ABI, functionName: "latestRoundData" });
    assert.deepEqual(state.lastCalls[1], { method: "eth_call", params: [{ to: QIE_ORACLES["BTC/USDT"].address, data }, "latest"] });
    state.answer = 1n; await s.oracles.prices(); assert.equal(state.calls, 1);
    next(); assert.equal((await s.oracles.prices())[1]!.price, 0.00000001); assert.equal(state.calls, 2);
  });
  it("ages cached rounds on every read, including the exact six-hour boundary", async () => {
    const { cfg, s, state } = fixture(); state.age = cfg.oracleMaxAgeSec; state.now = Math.floor(state.now / 1000) * 1000;
    assert.equal((await s.oracles.prices())[0]!.stale, false);
    state.now += 1000; const row = (await s.oracles.prices())[0]!;
    assert.equal(row.stale, true); assert.equal(row.price, null); assert.equal(state.calls, 1);
  });
  for (const [label, change] of [
    ["stale round", (x: ReturnType<typeof fixture>["state"]) => { x.age = 21601; }],
    ["zero answer", (x: ReturnType<typeof fixture>["state"]) => { x.answer = 0n; }],
    ["negative answer", (x: ReturnType<typeof fixture>["state"]) => { x.answer = -1n; }],
    ["RPC failure", (x: ReturnType<typeof fixture>["state"]) => { x.fail = true; }],
    ["malformed round", (x: ReturnType<typeof fixture>["state"]) => { x.malformed = true; }],
    ["future timestamp", (x: ReturnType<typeof fixture>["state"]) => { x.future = true; }],
    ["incomplete round", (x: ReturnType<typeof fixture>["state"]) => { x.answeredInRound = 41n; }],
  ] as const) it(`${label} gives no price and no alert`, async () => {
    const { s, state, add, events } = fixture(); await add({ feed: "BTC/USDT", above: 1 }); change(state);
    assert.ok((await s.oracles.prices()).every((r) => r.price === null));
    await s.checks.runOnce(); assert.equal(events().length, 0); assert.equal(state.calls, 1, "outages are cached too");
  });
  it("fires once, preserves armed state through outages and re-arms only after clearing", async () => {
    const { s, state, add, events, next } = fixture(); await add({ feed: "BTC/USDT", above: 64000 });
    await s.checks.runOnce(); await s.checks.runOnce(); assert.equal(events().length, 1);
    state.fail = true; next(); await s.checks.runOnce(); state.fail = false; next(); await s.checks.runOnce();
    assert.equal(events().length, 1, "outage must not re-arm");
    state.answer = 6_400_000_000_000n; next(); await s.checks.runOnce();
    state.answer = 6_500_000_000_000n; next(); await s.checks.runOnce(); assert.equal(events().length, 2);
    const p = events()[0]!; assert.equal(p.type, "price.threshold"); assert.equal(p.tx, null);
    assert.deepEqual(p.data, { symbol: "BTC/USDT", feed: "BTC/USDT", direction: "above", threshold: 64000, priceUsd: 65000, source: "QIE Oracles", oracle: QIE_ORACLES["BTC/USDT"].address, updatedAt: p.data.updatedAt });
    assert.equal(typeof p.data.updatedAt, "number"); assert.equal(p.link, `${s.cfg.explorerUrl}/address/${QIE_ORACLES["BTC/USDT"].address}`);
    assert.match(describePayload(p).lines.join("\n"), /Price now: \$65,000 from QIE Oracles \(BTC\/USDT\)/);
  });
  it("supports below thresholds and stays armed during an initial outage", async () => {
    const { s, state, add, events, next } = fixture(); await add({ feed: "QIE/USDT", below: 1 });
    state.fail = true; await s.checks.runOnce(); assert.equal(events().length, 0);
    state.fail = false; state.answer = 16_300_000n; next(); await s.checks.runOnce(); await s.checks.runOnce();
    assert.equal(events().length, 1); assert.equal(events()[0]!.data.direction, "below"); assert.equal(events()[0]!.data.priceUsd, 0.163);
  });
  it("keeps QIEDEX wording for existing price alerts", () => {
    const p = scheduledPayload({ id: "hk_test", name: "DEX test" }, "price.threshold", { symbol: "WQIE", direction: "above", threshold: 0.2, priceUsd: 0.21, source: "QIEDEX" }, { chainId: 1990, network: "mainnet" });
    assert.match(describePayload(p).lines[0]!, /on QIEDEX/); assert.doesNotMatch(describePayload(p).lines[0]!, /Oracles/);
  });
  it("formats feed, source and explorer links for Telegram and Discord", async (t) => {
    const { s, add, events } = fixture(); await add({ feed: "BTC/USDT", above: 64000 }); await s.checks.runOnce(); const p = events()[0]!;
    const sent = t.mock.method(s.telegram, "sendMessage", async () => {}); await s.telegram.sendEvent("local-test", p);
    assert.match(sent.mock.calls[0]!.arguments[1]!, /QIE Oracles \(BTC\/USDT\)/); assert.equal(sent.mock.calls[0]!.arguments[2], p.link);
    const fetched = t.mock.method(globalThis, "fetch", async () => new Response("{}", { status: 200 }));
    const result = await s.delivery.attempt("discord", { url: "https://discord.com/api/webhooks/123/test" }, p, JSON.stringify(p), "test-secret", "usr_oracle"); assert.equal(result.ok, true);
    const embed = JSON.parse(String(fetched.mock.calls[0]!.arguments[1]!.body)).embeds[0];
    assert.match(embed.title, /BTC\/USDT is above/); assert.match(embed.description, /QIE Oracles \(BTC\/USDT\)/); assert.equal(embed.url, p.link);
  });
  it("requires a known feed and exactly one positive finite threshold", () => {
    for (const config of [{ feed: "BTC/USDT" }, { feed: "BTC/USDT", below: 60000, above: 65000 }, { feed: "UNKNOWN/USDT", above: 1 }, { feed: "BTC/USDT", above: 0 }, { feed: "BTC/USDT", above: Infinity }, { feed: "BTC/USDT", below: -1 }]) assert.equal(triggerSchemas.oracle_price.safeParse(config).success, false, JSON.stringify(config));
    assert.equal(triggerSchemas.oracle_price.safeParse({ feed: "BTC/USDT", above: 65000 }).success, true); assert.ok(SCHEDULED_TYPES.includes("oracle_price"));
  });
  it("MCP accepts oracle_price, validates configs and exposes read-only oracle prices", async () => {
    const { s, user } = fixture(); const app = buildApp(s); const { key } = s.auth.createApiKey(user.id, "local-oracle-test");
    const request = async (method: string, params = {}) => {
      const r = await app.request("/api/mcp", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }); assert.equal(r.status, 200); return r.json() as Promise<any>;
    };
    const list = (await request("tools/list")).result.tools; assert.equal(list.length, 17); assert.equal(list.find((x: any) => x.name === "get_oracle_prices").annotations.readOnlyHint, true);
    const args = { name: "BTC oracle", trigger: { type: "oracle_price", config: { feed: "BTC/USDT", above: 65000 } }, channel: { type: "webhook", config: { url: "http://127.0.0.1:1/test" } } };
    const created = (await request("tools/call", { name: "create_alert", arguments: args })).result; assert.equal(created.isError, false); assert.equal(JSON.parse(created.content[0].text).trigger.type, "oracle_price");
    const invalid = (await request("tools/call", { name: "create_alert", arguments: { ...args, trigger: { type: "oracle_price", config: { feed: "BTC/USDT", above: 2, below: 1 } } } })).result; assert.equal(invalid.isError, true);
    const prices = (await request("tools/call", { name: "get_oracle_prices", arguments: {} })).result; assert.equal(prices.isError, false); assert.deepEqual(JSON.parse(prices.content[0].text).map((r: any) => r.feed), ORACLE_FEED_NAMES);
  });
  it("public status and config include verified feeds without authentication", async () => {
    const { s, state, next } = fixture(); const app = buildApp(s); const r = await app.request("/api/status"); assert.equal(r.status, 200);
    const status = await r.json() as any; assert.equal(status.oracles.length, 6); assert.equal(status.oracles[1].feed, "BTC/USDT"); assert.equal(status.oracles[1].price, 65000); assert.equal(status.oracles[1].stale, false);
    assert.deepEqual((await (await app.request("/api/config")).json() as any).oracleFeeds, ORACLE_FEED_NAMES);
    state.fail = true; next(); const down = await (await app.request("/api/status")).json() as any; assert.ok(down.oracles.every((r: any) => r.price === null));
  });
  it("never queries mainnet contract addresses on testnet", async () => {
    const { cfg, s, state } = fixture(); cfg.chainId = 1983; assert.deepEqual(await s.oracles.prices(), []); assert.equal(state.calls, 0);
  });
  it("validates optional staleness configuration", () => {
    assert.equal(loadConfig({}).oracleMaxAgeSec, 21600); assert.equal(loadConfig({ ORACLE_MAX_AGE_SEC: "300" }).oracleMaxAgeSec, 300);
    for (const value of ["0", "-1", "1.5", "Infinity"]) assert.throws(() => loadConfig({ ORACLE_MAX_AGE_SEC: value }));
  });
});
