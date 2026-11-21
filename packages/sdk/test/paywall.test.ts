import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkPayment, paywall, QPulse, type Invoice } from "../src/index.ts";

/** A tiny fake Q-Pulse API: creates links, lets the test mark them paid, redeems each once. */
function fakeServer() {
  const invoices = new Map<string, Invoice & { redeemed?: boolean }>();
  let n = 0;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const f = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname.replace(/^\/api/, "");
    const method = init.method ?? "GET";
    if (method === "POST" && path === "/invoices") {
      const b = JSON.parse(String(init.body));
      const id = `inv_${(++n).toString(16).padStart(20, "0")}`;
      const inv = {
        id,
        url: `https://hooks.example/#/pay/${id}`,
        status: "open",
        description: b.description,
        recipient: { address: "0x172083F7f31f82e4B57bA8aCf9822C72BB35b174", name: null },
        token: { symbol: b.token, address: "0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5", decimals: 6 },
        amount: { raw: "50001", formatted: "0.050001", display: "0.050001 QUSDC" },
        baseAmount: { raw: "50000", formatted: b.amount },
        expiresAt: 2_000_000_000,
        createdAt: 1_900_000_000,
        successUrl: null,
        payment: null,
        metadata: b.metadata,
        chainId: 1990,
      } as Invoice;
      invoices.set(id, inv);
      return json(201, { invoice: inv });
    }
    const m = path.match(/^\/invoices\/(inv_[0-9a-f]+)(\/redeem)?$/);
    const inv = m && invoices.get(m[1]!);
    if (!inv) return json(404, { error: "Payment link not found" });
    if (m![2]) {
      if (inv.status !== "paid") return json(402, { error: "not paid" });
      if (inv.redeemed) return json(409, { error: "This payment was already used" });
      inv.redeemed = true;
      return json(200, { invoice: { ...inv, redeemedAt: 1_900_000_100 } });
    }
    return json(200, { invoice: inv });
  }) as unknown as typeof fetch;
  return { f, invoices, pay: (id: string) => (invoices.get(id)!.status = "paid") };
}

describe("paywall (HTTP 402)", () => {
  it("asks for payment, then lets exactly one request through per payment", async () => {
    const srv = fakeServer();
    const client = new QPulse({ apiKey: "qp_live_x", baseUrl: "https://hooks.example", fetch: srv.f });
    const opts = { client, id: "forecast", amount: "0.05" };

    const first = await checkPayment(opts, undefined);
    assert.equal(first.paid, false);
    if (first.paid) return;
    assert.equal(first.status, 402);
    const id = first.body.retry.value;
    assert.match(first.body.message, /X-QPulse-Payment/);
    assert.equal(first.headers["x-qpulse-payment-url"], first.body.payment.url);

    const unpaid = await checkPayment(opts, id);
    assert.equal(unpaid.paid, false, "not paid yet");
    if (!unpaid.paid) assert.equal(unpaid.body.payment.id, id, "same link while it's open");

    srv.pay(id);
    const ok = await checkPayment(opts, id);
    assert.equal(ok.paid, true);

    const again = await checkPayment(opts, id);
    assert.equal(again.paid, false, "a payment can't be used twice");
    if (!again.paid) {
      assert.notEqual(again.body.payment.id, id, "a fresh link is offered");
      assert.match(again.body.message, /already used/);
    }
  });

  it("refuses a paid link that was made for another paywall or price", async () => {
    const srv = fakeServer();
    const client = new QPulse({ apiKey: "qp_live_x", baseUrl: "https://hooks.example", fetch: srv.f });
    const cheap = await checkPayment({ client, id: "cheap-thing", amount: "0.01" }, undefined);
    assert.ok(!cheap.paid);
    if (cheap.paid) return;
    srv.pay(cheap.body.retry.value);
    const r = await checkPayment({ client, id: "forecast", amount: "0.05" }, cheap.body.retry.value);
    assert.equal(r.paid, false);
    if (!r.paid) assert.match(r.body.message, /something else/);
    assert.equal(srv.invoices.get(cheap.body.retry.value)!.redeemed, undefined, "the other link is not used up");
  });

  it("works as Express/Node middleware", async () => {
    const srv = fakeServer();
    const client = new QPulse({ apiKey: "qp_live_x", baseUrl: "https://hooks.example", fetch: srv.f });
    const mw = paywall({ client, id: "forecast", amount: "0.05" });
    const res = { statusCode: 200, headers: {} as Record<string, string>, body: "", setHeader(k: string, v: string) { this.headers[k] = v; }, end(b?: string) { this.body = b ?? ""; } };
    let nexted = false;
    await mw({ headers: {} }, res, () => (nexted = true));
    assert.equal(res.statusCode, 402);
    assert.equal(nexted, false);
    const id = JSON.parse(res.body).retry.value as string;
    srv.pay(id);
    const req: { headers: Record<string, string>; qpulsePayment?: Invoice } = { headers: { "x-qpulse-payment": id } };
    await mw(req, res, () => (nexted = true));
    assert.equal(nexted, true);
    assert.equal(req.qpulsePayment?.id, id);
  });
});
