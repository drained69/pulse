import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { pad } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { QIE_MAINNET, TOPIC } from "../src/chain.ts";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { buildApp, buildServices } from "../src/main.ts";
import { StaticNameResolver } from "../src/names.ts";
import { verify } from "../src/signing.ts";

const SHOP = "0x172083F7f31f82e4B57bA8aCf9822C72BB35b174";
const BUYER = "0x5555555555555555555555555555555555555555";
const hex = (n: bigint | number) => `0x${n.toString(16)}`;

describe("payment links", () => {
  const account = privateKeyToAccount(generatePrivateKey());
  // What the fake chain returns for the next processRange call.
  let logs: unknown[] = [];
  let txs: unknown[] = [];
  const received: { headers: IncomingMessage["headers"]; body: string }[] = [];

  const transferLog = (token: string, to: string, value: bigint, hash: string) => ({
    address: token,
    topics: [TOPIC.TRANSFER, pad(BUYER as `0x${string}`), pad(to as `0x${string}`)],
    data: pad(hex(value) as `0x${string}`),
    blockNumber: "0x64",
    transactionHash: hash,
    transactionIndex: "0x0",
    logIndex: "0x0",
    blockHash: "0xbb",
  });

  const server = createServer((req, res) => {
    if (req.method === "GET") return void res.writeHead(404).end(); // QIEDEX price API: unavailable in tests
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url === "/hook") {
        received.push({ headers: req.headers, body });
        return res.writeHead(200).end("ok");
      }
      const reqs = JSON.parse(body);
      const one = (r: { id: number; method: string; params: unknown[] }) => {
        const result =
          r.method === "eth_getLogs"
            ? logs
            : r.method === "eth_getBlockByNumber"
              ? { number: r.params[0], hash: "0xbb", timestamp: hex(Math.floor(Date.now() / 1000)), transactions: txs }
              : r.method === "eth_getTransactionReceipt"
                ? { status: "0x1", transactionHash: r.params[0] }
                : r.method === "eth_blockNumber"
                  ? "0x64"
                  : null;
        return { jsonrpc: "2.0", id: r.id, result };
      };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(reqs) ? reqs.map(one) : one(reqs)));
    });
  });

  let s: ReturnType<typeof buildServices>;
  let app: ReturnType<typeof buildApp>;
  let base = "";
  let cookie = "";
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`/api${path}`, {
      method,
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json().catch(() => null)) as any };
  };

  before(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const cfg = loadConfig({ DB_PATH: ":memory:", PUBLIC_URL: "https://hooks.example", RPC_URLS: base, QIEDEX_API_URL: base, ALLOW_PRIVATE_WEBHOOKS: "true" } as NodeJS.ProcessEnv);
    s = buildServices(cfg, { db: openDb(":memory:"), names: new StaticNameResolver({ "shop.qie": SHOP, "buyer.qie": BUYER }) });
    app = buildApp(s);
    const n = await call("POST", "/auth/nonce", { address: account.address });
    const signature = await account.signMessage({ message: n.json.message });
    const v = await app.request("/api/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: account.address, signature, nonce: n.json.nonce }),
    });
    cookie = (v.headers.get("set-cookie") ?? "").split(";")[0]!;
  });
  after(() => {
    s.rpc.stop();
    server.close();
  });

  it("validates input", async () => {
    for (const body of [
      { amount: "abc" },
      { amount: "0" },
      { amount: "1.1234567" },
      { amount: "5", token: "DOGE" },
      { amount: "5", expiresInMinutes: 1 },
      { amount: "5", successUrl: "javascript:alert(1)" },
      { amount: "5", metadata: [1, 2] },
      { amount: "5", recipient: "nobody.qie" },
    ]) {
      const r = await call("POST", "/invoices", body);
      assert.equal(r.status, 400, JSON.stringify(body));
    }
  });

  let first: any, second: any, native: any;
  it("gives each open link for the same amount a unique amount", async () => {
    first = (await call("POST", "/invoices", { amount: "25", recipient: "shop.qie", description: "Order #1001", metadata: { orderId: "1001" }, successUrl: "https://shop.example/thanks" })).json.invoice;
    second = (await call("POST", "/invoices", { amount: "25", recipient: "shop.qie", description: "Order #1002" })).json.invoice;
    native = (await call("POST", "/invoices", { amount: "1.5", token: "QIE", recipient: "shop.qie" })).json.invoice;
    assert.equal(first.amount.formatted, "25");
    assert.equal(second.amount.formatted, "25.000001");
    assert.equal(native.amount.raw, "1500000000000000000");
    assert.equal(first.recipient.name, "shop.qie");
    assert.equal(first.status, "open");
    assert.equal(first.url, `https://hooks.example/#/pay/${first.id}`);
    assert.deepEqual(first.metadata, { orderId: "1001" });

    // The public checkout view hides merchant metadata.
    const pub = await call("GET", `/pay/${first.id}`);
    assert.equal(pub.status, 200);
    assert.equal(pub.json.invoice.metadata, undefined);
    assert.equal((await call("GET", "/pay/inv_nope")).status, 404);
  });

  it("marks links paid from on-chain transfers and fires invoice.paid", async () => {
    const hook = await call("POST", "/hooks", { name: "Shop checkout", trigger: { type: "invoice", config: {} }, channel: { type: "webhook", config: { url: `${base}/hook` } } });
    assert.equal(hook.status, 201, JSON.stringify(hook.json));

    logs = [
      transferLog(QIE_MAINNET.QUSDC, SHOP, 25_000_001n, "0xa1"), // pays the second link exactly
      transferLog(QIE_MAINNET.QUSDC, SHOP, 24_000_000n, "0xa2"), // wrong amount: ignored
      transferLog(QIE_MAINNET.WQIE, SHOP, 25_000_000n, "0xa3"), // right number, wrong token: ignored
    ];
    txs = [{ hash: "0xn1", from: BUYER, to: SHOP, value: hex(1_500_000_000_000_000_000n), input: "0x", transactionIndex: "0x1", blockNumber: "0x64" }];
    await s.indexer.processRange(100, 100);
    await s.indexer.processRange(100, 100); // a replay must not pay twice

    const a = (await call("GET", `/pay/${first.id}`)).json.invoice;
    const b = (await call("GET", `/pay/${second.id}`)).json.invoice;
    const c = (await call("GET", `/pay/${native.id}`)).json.invoice;
    assert.equal(a.status, "open");
    assert.equal(b.status, "paid");
    assert.equal(b.payment.txHash, "0xa1");
    assert.equal(b.payment.from, BUYER);
    assert.equal(c.status, "paid");
    assert.equal(c.payment.txHash, "0xn1");

    await s.delivery.drain();
    assert.equal(received.length, 2, "one event per paid link");
    const ev = received.map((r) => JSON.parse(r.body)).find((e) => e.data.invoice.id === second.id);
    assert.equal(ev.type, "invoice.paid");
    assert.equal(ev.data.amount.display, "25.000001 QUSDC");
    assert.equal(ev.data.from.name, "buyer.qie");
    assert.equal(ev.data.to.name, "shop.qie");
    assert.equal(ev.tx.hash, "0xa1");
    const r = received.find((x) => JSON.parse(x.body).data.invoice.id === second.id)!;
    assert.ok(verify(hook.json.hook.secret, String(r.headers["qiehooks-signature"]), Number(r.headers["qiehooks-timestamp"]), r.body));
  });

  it("credits a payment that arrives after the link expired", async () => {
    s.db.prepare("UPDATE invoices SET expires_at = ? WHERE id = ?").run(Math.floor(Date.now() / 1000) - 60, first.id);
    assert.equal((await call("GET", `/pay/${first.id}`)).json.invoice.status, "expired");
    // A new link for the same amount must not reuse the expired link's amount.
    const third = (await call("POST", "/invoices", { amount: "25", recipient: "shop.qie" })).json.invoice;
    assert.notEqual(third.amount.raw, first.amount.raw);

    logs = [transferLog(QIE_MAINNET.QUSDC, SHOP, 25_000_000n, "0xa4")];
    txs = [];
    await s.indexer.processRange(101, 101);
    const a = (await call("GET", `/pay/${first.id}`)).json.invoice;
    assert.equal(a.status, "paid");
    assert.equal(a.payment.late, true);
  });

  it("lists, totals and cancels links", async () => {
    const list = (await call("GET", "/invoices")).json;
    assert.equal(list.invoices.length, 4);
    assert.ok(list.totals.find((t: { symbol: string }) => t.symbol === "QUSDC"));
    const open = list.invoices.find((i: { status: string }) => i.status === "open");
    assert.equal((await call("POST", `/invoices/${open.id}/cancel`)).json.invoice.status, "cancelled");
    assert.equal((await call("POST", `/invoices/${second.id}/cancel`)).status, 409, "paid links can't be cancelled");
    cookie = "";
    assert.equal((await call("GET", "/invoices")).status, 401);
  });
});
