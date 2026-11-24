import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { ensureUser } from "../src/billing.ts";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { buildApp, buildServices } from "../src/main.ts";
import { StaticNameResolver } from "../src/names.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });
function fixture() {
  const cfg = loadConfig({ DB_PATH: ":memory:", PUBLIC_URL: "https://qpulse.example", ALLOW_PRIVATE_WEBHOOKS: "true", RPC_URLS: "http://127.0.0.1:1", QIEDEX_API_URL: "http://127.0.0.1:1" } as NodeJS.ProcessEnv);
  const s = buildServices(cfg, { db: openDb(":memory:"), names: new StaticNameResolver({}) });
  cleanup.push(() => s.db.close());
  const app = buildApp(s);
  const user = ensureUser(s.db, "0x172083F7f31f82e4B57bA8aCf9822C72BB35b174");
  const { key } = s.auth.createApiKey(user.id, "audit");
  const post = async (body: unknown) => {
    const res = await app.request("/api/mcp", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json() as any };
  };
  return { s, user, post };
}

describe("audit: MCP request integrity", () => {
  it("returns JSON-RPC invalid-request errors for malformed envelopes", async () => {
    const { post } = fixture();
    for (const input of [null, 7, "ping", [], { jsonrpc: "2.0", id: [], method: "ping" }, { jsonrpc: "2.0", id: 1, method: "ping", params: [] }]) {
      const res = await post(input);
      assert.ok(res.status < 500, JSON.stringify(input));
      assert.equal(res.json.error?.code, -32600, JSON.stringify(input));
    }
    const nullId = await post({ jsonrpc: "2.0", id: null, method: "ping" });
    assert.deepEqual(nullId.json, { jsonrpc: "2.0", id: null, result: {} }, "an explicit null id is a request, not an omitted-id notification");
  });

  it("a malformed batch member cannot hide the successful result of a state-changing tool", async () => {
    const { s, user, post } = fixture();
    const res = await post([null, { jsonrpc: "2.0", id: "invoice", method: "tools/call", params: { name: "create_payment_link", arguments: { amount: "5" } } }]);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal((s.db.prepare("SELECT COUNT(*) AS n FROM invoices WHERE user_id=?").get(user.id) as { n: number }).n, 1);
    assert.equal(res.status, 200);
    assert.equal(res.json.length, 2);
    assert.equal(res.json[0].error.code, -32600);
    assert.equal(res.json[1].id, "invoice");
    assert.equal(res.json[1].result.isError, false, "the client receives the created invoice instead of a retry-inducing HTTP 500");
  });

  it("does not turn a string false into an instruction to enable an alert", async () => {
    const { s, user, post } = fixture();
    const hook = await s.hooks.create(user, { name: "Paused", trigger: { type: "invoice", config: {} }, channel: { type: "webhook", config: { url: "http://127.0.0.1:1/hook" } } });
    await s.hooks.update(user.id, hook.id, { active: false });
    const bad = await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "set_alert_active", arguments: { id: hook.id, active: "false" } } });
    assert.equal(bad.json.result.isError, true);
    assert.match(bad.json.result.content[0].text, /active.*boolean/i);
    assert.equal(s.hooks.get(user.id, hook.id).active, false);
    const valid = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "set_alert_active", arguments: { id: hook.id, active: true } } });
    assert.equal(valid.json.result.isError, false);
    assert.equal(s.hooks.get(user.id, hook.id).active, true);
  });
});
