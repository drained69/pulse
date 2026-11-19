import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { ensureUser } from "../src/billing.ts";
import { buildApp, buildServices } from "../src/main.ts";
import { StaticNameResolver } from "../src/names.ts";

const SHOP = "0x172083F7f31f82e4B57bA8aCf9822C72BB35b174";

describe("MCP server", () => {
  const cfg = loadConfig({ DB_PATH: ":memory:", PUBLIC_URL: "https://hooks.example", RPC_URLS: "http://127.0.0.1:1", QIEDEX_API_URL: "http://127.0.0.1:1" } as NodeJS.ProcessEnv);
  const s = buildServices(cfg, { db: openDb(":memory:"), names: new StaticNameResolver({ "shop.qie": SHOP }) });
  const app = buildApp(s);
  const user = ensureUser(s.db, "0x9e121d718c80f99006523B38d556F114F1A072d3");
  const { key } = s.auth.createApiKey(user.id, "agent");
  after(() => s.rpc.stop());

  let nextId = 1;
  const post = async (body: unknown, auth = true) => {
    const res = await app.request("/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(auth ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null, res };
  };
  const rpc = (method: string, params?: unknown) => post({ jsonrpc: "2.0", id: nextId++, method, params });
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await rpc("tools/call", { name, arguments: args });
    const result = r.json.result;
    return { isError: result.isError as boolean, text: result.content[0].text as string, data: result.isError ? null : JSON.parse(result.content[0].text) };
  };

  it("requires an API key", async () => {
    const r = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, false);
    assert.equal(r.status, 401);
    assert.match(r.res.headers.get("www-authenticate") ?? "", /Bearer/);
    assert.equal((await app.request("/api/mcp")).status, 405, "no SSE stream: GET is not allowed");
  });

  it("initializes, accepts notifications and lists tools", async () => {
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    assert.equal(init.json.result.protocolVersion, "2025-06-18");
    assert.equal(init.json.result.serverInfo.name, "qiepulse");
    assert.ok(init.json.result.capabilities.tools);
    const old = await rpc("initialize", { protocolVersion: "1999-01-01" });
    assert.equal(old.json.result.protocolVersion, "2025-06-18", "falls back to a supported version");

    const n = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal(n.status, 202);

    const list = await rpc("tools/list");
    const names = list.json.result.tools.map((t: { name: string }) => t.name);
    for (const t of ["create_payment_link", "wait_for_payment", "create_alert", "wait_for_event", "get_traction", "resolve_qie_name"]) assert.ok(names.includes(t), t);
    for (const t of list.json.result.tools) {
      assert.equal(t.inputSchema.type, "object", t.name);
      assert.equal(t.run, undefined, "implementation not leaked");
    }
    assert.equal((await rpc("nope/nothing")).json.error.code, -32601);
  });

  it("takes a payment end to end: create link, wait, paid", async () => {
    const created = await tool("create_payment_link", { amount: "5", recipient: "shop.qie", description: "Agent task #7", metadata: { task: 7 } });
    assert.equal(created.isError, false, created.text);
    assert.equal(created.data.amount.display, "5 QUSDC");
    assert.equal(created.data.recipient.name, "shop.qie");

    const t0 = Date.now();
    const timedOut = await tool("wait_for_payment", { id: created.data.id, timeout_seconds: 1 });
    assert.equal(timedOut.data.waitedUntil, "timeout");
    assert.ok(Date.now() - t0 >= 900);

    // The payment lands while the agent is waiting.
    setTimeout(() => {
      s.db.prepare("UPDATE invoices SET status='paid', paid_at=?, paid_tx='0xfeed', paid_from=?, paid_amount_raw=amount_raw, paid_block=1 WHERE id=?").run(Math.floor(Date.now() / 1000), SHOP, created.data.id);
    }, 1200);
    const paid = await tool("wait_for_payment", { id: created.data.id, timeout_seconds: 10 });
    assert.equal(paid.data.status, "paid");
    assert.equal(paid.data.payment.txHash, "0xfeed");

    const listed = await tool("list_payment_links", { status: "paid" });
    assert.equal(listed.data.length, 1);
  });

  it("creates and manages alerts, and waits for events", async () => {
    const a = await tool("create_alert", {
      name: "Agent: invoices",
      trigger: { type: "invoice", config: {} },
      channel: { type: "webhook", config: { url: "https://example.com/agent" } },
    });
    assert.equal(a.isError, false, a.text);
    const id = a.data.id;
    assert.equal((await tool("list_alerts")).data[0].id, id);
    assert.equal((await tool("set_alert_active", { id, active: false })).data.active, false);

    setTimeout(() => {
      s.hooks.recordEvent({ id, user_id: user.id }, "k1", {
        id: "evt_1",
        type: "invoice.paid",
        createdAt: new Date().toISOString(),
        hook: { id, name: "Agent: invoices" },
        chain: { id: 1990, network: "mainnet" },
        tx: null,
        data: { hello: "agent" },
      });
    }, 1100);
    const w = await tool("wait_for_event", { hook_id: id, timeout_seconds: 10 });
    assert.equal(w.data.events.length, 1);
    assert.equal(w.data.events[0].data.hello, "agent");
    assert.equal((await tool("get_events", { hook_id: id })).data.length, 1);

    assert.equal((await tool("delete_alert", { id })).isError, false);
    assert.equal((await tool("list_alerts")).data.length, 0);
  });

  it("returns tool errors to the model instead of failing the request", async () => {
    const bad = await tool("create_payment_link", { amount: "lots" });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /amount/);
    const other = await tool("get_payment_link", { id: "inv_not_mine" });
    assert.equal(other.isError, true);
    assert.equal((await tool("resolve_qie_name", { name_or_address: "shop.qie" })).data.address, SHOP);
    const unknown = await rpc("tools/call", { name: "rm_rf" });
    assert.equal(unknown.json.error.code, -32602);
  });

  it("answers batches", async () => {
    const r = await post([
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]);
    assert.equal(r.json.length, 2);
  });
});
