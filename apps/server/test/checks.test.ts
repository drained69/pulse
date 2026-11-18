import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeAbiParameters } from "viem";
import { QIE_MAINNET } from "../src/chain.ts";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { buildServices } from "../src/main.ts";
import { StaticNameResolver } from "../src/names.ts";

const W = "0x172083F7f31f82e4B57bA8aCf9822C72BB35b174";

function setup() {
  const cfg = loadConfig({ DB_PATH: ":memory:", RPC_URLS: "http://127.0.0.1:1", ALLOW_PRIVATE_WEBHOOKS: "true", TELEGRAM_BOT_TOKEN: "" } as NodeJS.ProcessEnv);
  const db = openDb(":memory:");
  const names = new StaticNameResolver({ "shop.qie": W });
  const s = buildServices(cfg, { db, names });
  // Fake chain: native balance and QUSDC balance we control.
  const chain = { qie: 10n ** 18n, qusdc: 50_000_000n };
  (s.rpc as unknown as { batch: unknown }).batch = async (calls: { method: string }[]) =>
    calls.map((c) => (c.method === "eth_getBalance" ? `0x${chain.qie.toString(16)}` : encodeAbiParameters([{ type: "uint256" }], [chain.qusdc])));
  (s.tokens as unknown as { refreshPairs: unknown }).refreshPairs = async () => {};
  db.prepare("INSERT INTO users (id, address, plan, created_at) VALUES ('usr_1', ?, 'free', 0)").run(W);
  const addHook = (id: string, type: string, config: object, resolved: object = {}) =>
    db
      .prepare(
        `INSERT INTO hooks (id, user_id, name, trigger_type, trigger_config, resolved, channel_type, channel_config, secret, active, created_at, updated_at)
         VALUES (?, 'usr_1', ?, ?, ?, ?, 'webhook', '{"url":"http://127.0.0.1:1/x"}', 's', 1, 0, 0)`,
      )
      .run(id, id, type, JSON.stringify(config), JSON.stringify(resolved));
  const events = (id: string) => (db.prepare("SELECT payload FROM events WHERE hook_id = ? ORDER BY rowid").all(id) as { payload: string }[]).map((r) => JSON.parse(r.payload));
  return { s, db, chain, addHook, events, names };
}

describe("scheduled checks", () => {
  it("balance alerts fire once on crossing and re-arm", async () => {
    const { s, chain, addHook, events } = setup();
    addHook("hk_gas", "balance", { address: "shop.qie", asset: "QIE", below: "0.5" }, { address: W });
    addHook("hk_rich", "balance", { address: W, asset: "QUSDC", above: "100" });
    await s.checks.runOnce();
    assert.equal(events("hk_gas").length, 0, "1 QIE is not below 0.5");
    chain.qie = 10n ** 17n; // 0.1 QIE
    await s.checks.runOnce();
    await s.checks.runOnce();
    const gas = events("hk_gas");
    assert.equal(gas.length, 1, "fires once, not every run");
    assert.equal(gas[0].type, "balance.threshold");
    assert.equal(gas[0].data.balance.display, "0.1 QIE");
    assert.equal(gas[0].data.wallet.name, "shop.qie");
    assert.equal(gas[0].tx, null);
    chain.qie = 10n ** 18n;
    await s.checks.runOnce(); // re-arm
    chain.qie = 1n;
    await s.checks.runOnce();
    assert.equal(events("hk_gas").length, 2, "fires again after recovering");
    chain.qusdc = 150_000_000n;
    await s.checks.runOnce();
    assert.equal(events("hk_rich")[0].data.balance.display, "150 QUSDC");
  });

  it("price alerts use QIEDEX prices", async () => {
    const { s, addHook, events } = setup();
    addHook("hk_up", "price", { token: "WQIE", above: 0.2 });
    s.tokens.setPriceForTest(QIE_MAINNET.WQIE, 0.15);
    await s.checks.runOnce();
    assert.equal(events("hk_up").length, 0);
    s.tokens.setPriceForTest(QIE_MAINNET.WQIE, 0.21);
    await s.checks.runOnce();
    const e = events("hk_up");
    assert.equal(e.length, 1);
    assert.equal(e[0].data.symbol, "WQIE");
    assert.equal(e[0].data.priceUsd, 0.21);
  });

  it("name watch alerts when a QIE ID is repointed, not on first sight", async () => {
    const { s, addHook, events, names } = setup();
    addHook("hk_name", "name_watch", { name: "shop.qie" });
    await s.checks.runOnce();
    assert.equal(events("hk_name").length, 0);
    (names as unknown as { names: Map<string, string> }).names.set("shop.qie", "0x9999999999999999999999999999999999999999");
    await s.checks.runOnce();
    const e = events("hk_name");
    assert.equal(e.length, 1);
    assert.equal(e[0].data.from, W);
    assert.equal(e[0].data.to, "0x9999999999999999999999999999999999999999");
  });

  it("daily summary totals the source hook's last 24 hours once per day", async () => {
    const { s, db, addHook, events } = setup();
    addHook("hk_pay", "payment", { recipient: W });
    addHook("hk_digest", "daily_digest", { sourceHookId: "hk_pay", hourUtc: 8 });
    const now = Math.floor(Date.now() / 1000);
    const ins = db.prepare("INSERT INTO events (id, hook_id, dedupe_key, event_type, payload, created_at) VALUES (?, 'hk_pay', ?, 'payment.received', ?, ?)");
    const pay = (i: number, raw: string, from: string, when = now) =>
      ins.run(`evt_${i}`, `k${i}`, JSON.stringify({ data: { from: { address: "0xabc0000000000000000000000000000000000000", name: from }, token: { symbol: "QUSDC", address: QIE_MAINNET.QUSDC, decimals: 6 }, amount: { raw } } }), when);
    pay(1, "25000000", "alice.qie");
    pay(2, "5500000", "alice.qie");
    pay(3, "1000000", "bob.qie");
    pay(4, "99000000", "old.qie", now - 2 * 86400);
    const at8 = new Date();
    at8.setUTCHours(8, 5, 0, 0);
    await s.checks.runOnce(new Date(at8.getTime() - 3600_000)); // 07:05, not yet
    assert.equal(events("hk_digest").length, 0);
    await s.checks.runOnce(at8);
    await s.checks.runOnce(at8);
    const e = events("hk_digest");
    assert.equal(e.length, 1, "once per day");
    assert.equal(e[0].data.count, 3);
    assert.equal(e[0].data.totals[0].display, "31.5 QUSDC");
    assert.deepEqual(e[0].data.top[0], { label: "alice.qie", count: 2 });
  });

  it("catches up on a missed digest hour, but not much later", async () => {
    const { s, addHook, events } = setup();
    addHook("hk_pay", "payment", { recipient: W });
    addHook("hk_late", "daily_digest", { sourceHookId: "hk_pay", hourUtc: 8 });
    addHook("hk_too_late", "daily_digest", { sourceHookId: "hk_pay", hourUtc: 2 });
    const at11 = new Date();
    at11.setUTCHours(11, 0, 0, 0); // server was down from before 08:00 until 11:00
    await s.checks.runOnce(at11);
    assert.equal(events("hk_late").length, 1, "3 hours late: sent");
    assert.equal(events("hk_too_late").length, 0, "9 hours late: skipped, next one tomorrow");
  });
});
