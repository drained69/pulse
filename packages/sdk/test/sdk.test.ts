import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { QieHooks, QieHooksError, signWebhook, verifyWebhook, WebhookVerificationError } from "../src/index.ts";

const body = JSON.stringify({ id: "evt_1", type: "payment.received", data: { amount: { display: "25 QUSDC" } } });

describe("verifyWebhook", () => {
  it("accepts a valid signature with any header casing and returns the event", () => {
    const h = signWebhook("whsec_x", body, 1_800_000_000);
    const lower = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
    const ev = verifyWebhook({ body, headers: lower, secret: "whsec_x", now: 1_800_000_010 });
    assert.equal(ev.type, "payment.received");
    assert.ok(verifyWebhook({ body: Buffer.from(body), headers: new Headers(h), secret: "whsec_x", now: 1_800_000_010 }));
  });

  it("rejects bad secret, tampered body, old timestamp and missing headers", () => {
    const h = signWebhook("whsec_x", body, 1_800_000_000);
    const now = 1_800_000_000;
    assert.throws(() => verifyWebhook({ body, headers: h, secret: "whsec_y", now }), WebhookVerificationError);
    assert.throws(() => verifyWebhook({ body: body + " ", headers: h, secret: "whsec_x", now }), WebhookVerificationError);
    assert.throws(() => verifyWebhook({ body, headers: h, secret: "whsec_x", now: now + 301 }), /too old/);
    assert.throws(() => verifyWebhook({ body, headers: {}, secret: "whsec_x", now }), /Missing/);
  });
});

describe("QieHooks client", () => {
  it("sends the API key and builds a payment hook", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ hook: { id: "hk_1", name: "Payments to shop.qie" } }), { status: 201 });
    }) as unknown as typeof fetch;
    const qh = new QieHooks({ apiKey: "qh_live_abc", baseUrl: "https://hooks.example.com/", fetch: fakeFetch });
    const hook = await qh.onPayment("shop.qie", { url: "https://shop.example.com/hook" }, { minAmount: "5" });
    assert.equal(hook.id, "hk_1");
    assert.equal(calls[0]!.url, "https://hooks.example.com/api/hooks");
    assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, "Bearer qh_live_abc");
    const sent = JSON.parse(String(calls[0]!.init.body));
    assert.deepEqual(sent.trigger, { type: "payment", config: { recipient: "shop.qie", minAmount: "5" } });
    assert.deepEqual(sent.channel, { type: "webhook", config: { url: "https://shop.example.com/hook" } });
  });

  it("raises QieHooksError with the server message", async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ error: "recipient: nobody.qie is not registered" }), { status: 400 })) as unknown as typeof fetch;
    const qh = new QieHooks({ apiKey: "qh_live_abc", fetch: fakeFetch });
    await assert.rejects(qh.hooks.list(), (e: unknown) => e instanceof QieHooksError && e.status === 400 && /not registered/.test(e.message));
  });

  it("rejects keys that are not QIE Hooks keys", () => {
    assert.throws(() => new QieHooks({ apiKey: "sk_123" }));
  });
});

describe("payment links", () => {
  it("creates a link and waits until it is paid", async () => {
    let gets = 0;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      if (init.method === "POST") {
        assert.equal(url, "https://hooks.example.com/api/invoices");
        assert.deepEqual(JSON.parse(String(init.body)), { amount: "25", description: "Order #1", metadata: { orderId: 1 } });
        return new Response(JSON.stringify({ invoice: { id: "inv_1", status: "open", url: "https://hooks.example.com/#/pay/inv_1" } }), { status: 201 });
      }
      gets++;
      return new Response(JSON.stringify({ invoice: { id: "inv_1", status: gets >= 3 ? "paid" : "open" } }));
    }) as unknown as typeof fetch;
    const qh = new QieHooks({ apiKey: "qh_live_abc", baseUrl: "https://hooks.example.com", fetch: fakeFetch });
    const inv = await qh.invoices.create({ amount: "25", description: "Order #1", metadata: { orderId: 1 } });
    assert.equal(inv.url, "https://hooks.example.com/#/pay/inv_1");
    const paid = await qh.invoices.waitForPayment(inv.id, { intervalMs: 5 });
    assert.equal(paid.status, "paid");
    assert.equal(gets, 3);
  });
});
