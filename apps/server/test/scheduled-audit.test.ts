import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { encodeFunctionResult, type Address } from "viem";
import { ensureUser } from "../src/billing.ts";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { buildServices } from "../src/main.ts";
import { StaticNameResolver } from "../src/names.ts";
import { AGGREGATOR_V3_ABI } from "../src/oracles.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
function fixture() {
  const cfg = loadConfig({ DB_PATH: ":memory:", RPC_URLS: "http://127.0.0.1:1", ALLOW_PRIVATE_WEBHOOKS: "true" });
  const db = openDb(":memory:");
  const s = buildServices(cfg, { db, names: new StaticNameResolver({}) });
  cleanup.push(() => { s.rpc.stop(); s.gatewayRpc.stop(); s.stream.stop(); db.close(); });
  const user = ensureUser(db, "0x1111111111111111111111111111111111111111");
  s.rpc.batch = async <T>(calls: { method: string; params: unknown[] }[]): Promise<T[]> => {
    const now = BigInt(Math.floor(Date.now() / 1000));
    const data = encodeFunctionResult({ abi: AGGREGATOR_V3_ABI, functionName: "latestRoundData", result: [1n, 65000_00000000n, now, now, 1n] });
    return calls.map(() => data as T);
  };
  const add = () => s.hooks.create(user, { name: "Oracle audit", trigger: { type: "oracle_price", config: { feed: "BTC/USDT", above: 60000 } }, channel: { type: "webhook", config: { url: "http://127.0.0.1:1/alert" } } });
  const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return { s, db, user, add, count };
}

describe("scheduled alert persistence audit", () => {
  it("rolls back the event and delivery if threshold-state persistence fails", async () => {
    const { s, db, add, count } = fixture();
    await add();
    db.exec("CREATE TRIGGER fail_state BEFORE INSERT ON trigger_state BEGIN SELECT RAISE(ABORT, 'state write failed'); END;");
    await assert.rejects(s.checks.runOnce(), /state write failed/);
    assert.equal(count("events"), 0);
    assert.equal(count("deliveries"), 0);
    assert.equal(count("usage"), 0);
    db.exec("DROP TRIGGER fail_state");
    await s.checks.runOnce();
    await s.checks.runOnce();
    assert.equal(count("events"), 1);
  });

  it("re-arms when the watched feed or threshold changes", async () => {
    const { s, user, add, count } = fixture();
    const hook = await add();
    await s.checks.runOnce();
    assert.equal(count("events"), 1);
    await s.hooks.update(user.id, hook.id, { trigger: { type: "oracle_price", config: { feed: "ETH/USDT", above: 1000 } } });
    await s.checks.runOnce();
    assert.equal(count("events"), 2, "new feed must not inherit the old feed's disarmed state");
    await s.hooks.update(user.id, hook.id, { trigger: { type: "oracle_price", config: { feed: "ETH/USDT", above: 2000 } } });
    await s.checks.runOnce();
    assert.equal(count("events"), 3, "new threshold starts a new condition");
  });

  it("does not re-arm for a name-only update or pause/resume", async () => {
    const { s, user, add, count } = fixture();
    const hook = await add();
    await s.checks.runOnce();
    await s.hooks.update(user.id, hook.id, { name: "Renamed" });
    await s.checks.runOnce();
    await s.hooks.update(user.id, hook.id, { active: false });
    await s.checks.runOnce();
    await s.hooks.update(user.id, hook.id, { active: true });
    await s.checks.runOnce();
    assert.equal(count("events"), 1);
  });

  it("does not alert on a hook paused while the oracle read is in flight", async () => {
    const { s, user, add, count } = fixture();
    const hook = await add();
    const batch = s.rpc.batch.bind(s.rpc);
    let release!: () => void;
    s.rpc.batch = async <T>(calls: { method: string; params: unknown[] }[]): Promise<T[]> => {
      await new Promise<void>((resolve) => { release = resolve; });
      return batch<T>(calls);
    };
    const pending = s.checks.runOnce();
    await s.hooks.update(user.id, hook.id, { active: false });
    release();
    await pending;
    assert.equal(count("events"), 0);
  });

  for (const action of ["delete", "edit"] as const) {
    it(`ignores a hook ${action === "delete" ? "deleted" : "edited"} while its oracle read is in flight`, async () => {
      const { s, user, add, count } = fixture();
      const hook = await add();
      const batch = s.rpc.batch.bind(s.rpc);
      let release!: () => void;
      s.rpc.batch = async <T>(calls: { method: string; params: unknown[] }[]): Promise<T[]> => {
        await new Promise<void>((resolve) => { release = resolve; });
        return batch<T>(calls);
      };
      const pending = s.checks.runOnce();
      if (action === "delete") s.hooks.remove(user.id, hook.id);
      else await s.hooks.update(user.id, hook.id, { trigger: { type: "oracle_price", config: { feed: "ETH/USDT", above: 1000 } } });
      release();
      await pending;
      assert.equal(count("events"), 0);
      assert.equal(count("trigger_state"), 0);
      if (action === "edit") {
        await s.checks.runOnce();
        assert.equal(count("events"), 1, "the next pass evaluates the edited condition");
      }
    });
  }

  it("commits name-change events and resolver state atomically", async () => {
    const { s, db, user, count } = fixture();
    let address: Address = "0x1111111111111111111111111111111111111111";
    s.names.resolve = async () => address;
    await s.hooks.create(user, { name: "Name audit", trigger: { type: "name_watch", config: { name: "shop.qie" } }, channel: { type: "webhook", config: { url: "http://127.0.0.1:1/alert" } } });
    await s.checks.runOnce();
    address = "0x2222222222222222222222222222222222222222";
    db.exec("CREATE TRIGGER fail_state BEFORE INSERT ON trigger_state BEGIN SELECT RAISE(ABORT, 'state write failed'); END;");
    await assert.rejects(s.checks.runOnce(), /state write failed/);
    assert.equal(count("events"), 0);
    db.exec("DROP TRIGGER fail_state");
    await s.checks.runOnce();
    await s.checks.runOnce();
    assert.equal(count("events"), 1);
  });

  it("commits daily digests and their day marker atomically", async () => {
    const { s, db, user, count } = fixture();
    const channel = { type: "webhook" as const, config: { url: "http://127.0.0.1:1/alert" } };
    const src = await s.hooks.create(user, { name: "Source", trigger: { type: "invoice", config: {} }, channel });
    await s.hooks.create(user, { name: "Digest", trigger: { type: "daily_digest", config: { sourceHookId: src.id, hourUtc: 0 } }, channel });
    const now = new Date("2026-11-28T00:01:00Z");
    db.exec("CREATE TRIGGER fail_state BEFORE INSERT ON trigger_state BEGIN SELECT RAISE(ABORT, 'state write failed'); END;");
    await assert.rejects(s.checks.runOnce(now), /state write failed/);
    assert.equal(count("events"), 0);
    assert.equal(count("deliveries"), 0);
    db.exec("DROP TRIGGER fail_state");
    await s.checks.runOnce(now);
    await s.checks.runOnce(now);
    assert.equal(count("events"), 1);
  });

});
