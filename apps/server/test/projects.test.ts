import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { buildApp, buildServices } from "../src/main.ts";
import { StaticNameResolver } from "../src/names.ts";
import { compact, slugify } from "../src/projects.ts";

const C1 = "0x1111111111111111111111111111111111111111";
const C2 = "0x2222222222222222222222222222222222222222";
const EOA = "0x3333333333333333333333333333333333333333";
const W = (n: number) => `0x${n.toString(16).padStart(40, "a")}`;
const hex = (n: number) => `0x${n.toString(16)}`;

/** Fake QIE RPC + Blockscout explorer in one HTTP server. */
function fakeChain(deployer: string) {
  const now = Math.floor(Date.now() / 1000);
  const iso = (t: number) => new Date(t * 1000).toISOString();
  const etx = (hash: string, from: string, to: string, ago: number, status = "ok") => ({
    hash,
    block_number: 50,
    timestamp: iso(now - ago),
    status,
    value: "1000000000000000000",
    method: "0xa9059cbb",
    from: { hash: from },
    to: { hash: to },
  });
  const pages: Record<string, unknown> = {
    "1": {
      items: [
        etx("0xb1", W(1), C1, 3600),
        etx("0xb2", W(1), C1, 2 * 86400), // same wallet, another day: returning
        etx("0xb3", W(2), C1, 3 * 86400, "error"),
        etx("0xb4", W(3), EOA, 3 * 86400), // not sent to the contract: ignored
      ],
      next_page_params: { block_number: 49, index: 0 },
    },
    "2": { items: [etx("0xb5", W(4), C1, 10 * 86400), etx("0xb6", W(5), C1, 200 * 86400)], next_page_params: { block_number: 1, index: 0 } },
  };
  let explorerCalls = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    if (req.method === "GET") {
      explorerCalls++;
      const m = url.pathname.match(/^\/api\/v2\/addresses\/(0x[0-9a-fA-F]{40})(\/transactions)?$/);
      if (!m) return res.writeHead(404).end();
      if (!m[2]) return res.end(JSON.stringify({ creator_address_hash: m[1]!.toLowerCase() === C1 ? deployer : EOA }));
      if (m[1]!.toLowerCase() !== C1) return res.end(JSON.stringify({ items: [], next_page_params: null }));
      assert.equal(url.searchParams.get("filter"), "to");
      return res.end(JSON.stringify(pages[url.searchParams.get("block_number") === "49" ? "2" : "1"]));
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const reqs = JSON.parse(body);
      const one = (r: { id: number; method: string; params: unknown[] }) => {
        const result = (() => {
          switch (r.method) {
            case "eth_getCode":
              return (r.params[0] as string).toLowerCase() === EOA ? "0x" : "0x6080";
            case "eth_call":
              return "0x" + "0".repeat(64);
            case "eth_blockNumber":
              return hex(101);
            case "eth_getLogs":
              return [];
            case "eth_getBlockByNumber":
              return {
                number: r.params[0],
                hash: "0xbb",
                timestamp: hex(now),
                transactions: [
                  { hash: "0xc1", from: W(6), to: C1, value: "0x0", input: "0x12345678", transactionIndex: "0x0", blockNumber: r.params[0] },
                  { hash: "0xc2", from: W(7), to: EOA, value: "0x0", input: "0x", transactionIndex: "0x1", blockNumber: r.params[0] },
                ],
              };
            case "eth_getTransactionReceipt":
              return { status: "0x1", transactionHash: (r.params[0] as string) };
            default:
              return null;
          }
        })();
        return { jsonrpc: "2.0", id: r.id, result };
      };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(reqs) ? reqs.map(one) : one(reqs)));
    });
  });
  return { server, explorerCalls: () => explorerCalls };
}

describe("traction pages", () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const chain = fakeChain(account.address.toLowerCase());
  let s: ReturnType<typeof buildServices>;
  let app: ReturnType<typeof buildApp>;
  let cookie = "";
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`/api${path}`, {
      method,
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* svg */
    }
    return { status: res.status, json, text, res };
  };
  const waitBackfill = async (slug: string) => {
    for (let i = 0; i < 100; i++) {
      const r = await call("GET", `/projects/${slug}`);
      if (r.json.project.backfill.status === "done" || r.json.project.backfill.status === "failed") return r;
      await new Promise((ok) => setTimeout(ok, 20));
    }
    throw new Error("backfill did not finish");
  };

  before(async () => {
    await new Promise<void>((r) => chain.server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(chain.server.address() as AddressInfo).port}`;
    const cfg = loadConfig({ DB_PATH: ":memory:", PUBLIC_URL: "http://localhost:8787", RPC_URLS: base, EXPLORER_API_URL: base, QIEDEX_API_URL: base, MAX_PROJECTS_PER_USER: "2" } as NodeJS.ProcessEnv);
    s = buildServices(cfg, { db: openDb(":memory:"), names: new StaticNameResolver({}) });
    app = buildApp(s);
    const n = await call("POST", "/auth/nonce", { address: account.address });
    const signature = await account.signMessage({ message: n.json.message });
    const v = await call("POST", "/auth/verify", { address: account.address, signature, nonce: n.json.nonce });
    cookie = (v.res.headers.get("set-cookie") ?? "").split(";")[0]!;
  });
  after(() => {
    s.rpc.stop();
    chain.server.close();
  });

  it("makes slugs and compact numbers", () => {
    assert.equal(slugify("  Patungan: Split Bills! "), "patungan-split-bills");
    assert.equal(compact(999), "999");
    assert.equal(compact(1200), "1.2k");
    assert.equal(compact(45_000), "45k");
    assert.equal(compact(3_400_000), "3.4M");
  });

  it("validates input", async () => {
    assert.equal((await call("POST", "/my/projects", { name: "x", contracts: [] })).status, 400);
    const eoa = await call("POST", "/my/projects", { name: "Not a contract", contracts: [EOA] });
    assert.equal(eoa.status, 400);
    assert.match(eoa.json.error, /not a contract/);
    assert.equal((await call("POST", "/my/projects", { name: "Bad slug", slug: "A!", contracts: [C1] })).status, 400);
    assert.equal((await call("POST", "/my/projects", { name: "Reserved", slug: "explore", contracts: [C1] })).status, 400);
  });

  it("creates a page, verifies the deployer and backfills from the explorer", async () => {
    const r = await call("POST", "/my/projects", { name: "Demo Shop", description: "Pay with QIE", website: "demo.example", contracts: [C1, C1.toUpperCase().replace("0X", "0x")] });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.project.slug, "demo-shop");
    assert.equal(r.json.project.website, "https://demo.example/");
    assert.equal(r.json.project.contracts.length, 1, "duplicates removed");
    assert.equal(r.json.project.verifiedBy, "deployer");

    const p = await waitBackfill("demo-shop");
    assert.equal(p.json.project.backfill.status, "done");
    const t = p.json.stats.totals;
    assert.equal(t.txs, 3, "b1, b2, b5 (b3 failed, b4 not to the contract, b6 older than 90 days)");
    assert.equal(t.failedTxs, 1);
    assert.equal(t.wallets, 2);
    assert.equal(t.returningWallets, 1);
    assert.equal(t.qieValue, 3);
    assert.equal(p.json.stats.last7d.txs, 2);
    assert.equal(p.json.stats.series.length, 30);
    assert.equal(p.json.owner.address, account.address);

    // Slug collision.
    const dup = await call("POST", "/my/projects", { name: "Demo Shop", contracts: [C2] });
    assert.equal(dup.status, 409);
  });

  it("counts live transactions from the indexer, once", async () => {
    await s.indexer.processRange(100, 100);
    await s.indexer.processRange(100, 100); // replay after a crash
    const p = await call("GET", "/projects/demo-shop");
    assert.equal(p.json.stats.totals.txs, 4);
    assert.equal(p.json.stats.totals.wallets, 3);
    assert.equal(p.json.stats.last24h.txs, 2);
    assert.equal(p.json.stats.recent[0].method, "0x12345678");
  });

  it("ranks pages and serves a badge", async () => {
    const other = await call("POST", "/my/projects", { name: "Quiet One", contracts: [C2], public: true });
    assert.equal(other.status, 201);
    assert.equal(other.json.project.verifiedBy, null, "deployer is someone else");
    await waitBackfill("quiet-one");
    const lb = (await call("GET", "/projects")).json.projects;
    assert.deepEqual(lb.map((x: { slug: string }) => x.slug), ["demo-shop", "quiet-one"]);
    assert.equal(lb[0].verified, true);
    assert.equal(lb[0].wallets7d, 2, "W1 and W6; W4 was 10 days ago");

    const badge = await call("GET", "/projects/demo-shop/badge.svg");
    assert.equal(badge.res.headers.get("content-type"), "image/svg+xml; charset=utf-8");
    assert.match(badge.text, /4 tx · 3 wallets/);

    // Plan limit (2 in this test).
    assert.equal((await call("POST", "/my/projects", { name: "Third", contracts: [C2] })).status, 402);
  });

  it("lets the contract's deployer claim a page someone else created", async () => {
    // A second user creates a page for C1 (deployed by `account`).
    const other = privateKeyToAccount(generatePrivateKey());
    const saved = cookie;
    const n = await call("POST", "/auth/nonce", { address: other.address });
    const v = await app.request("/api/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: other.address, signature: await other.signMessage({ message: n.json.message }), nonce: n.json.nonce }),
    });
    cookie = (v.headers.get("set-cookie") ?? "").split(";")[0]!;
    const made = await call("POST", "/my/projects", { name: "Made For Them", contracts: [C1] });
    assert.equal(made.status, 201);
    assert.equal(made.json.project.verifiedBy, null);
    // The creator can't "claim" what they don't deploy… (already theirs: no-op)
    assert.equal((await call("POST", "/projects/made-for-them/claim")).status, 200);
    cookie = saved;
    // …the deployer can, and the page becomes theirs and verified.
    const claimed = await call("POST", "/projects/made-for-them/claim");
    assert.equal(claimed.status, 200, JSON.stringify(claimed.json));
    assert.equal(claimed.json.project.verifiedBy, "deployer");
    const mine = (await call("GET", "/my/projects")).json.projects.map((p: { slug: string }) => p.slug);
    assert.ok(mine.includes("made-for-them"));
    await call("DELETE", `/my/projects/${claimed.json.project.id}`);
  });

  it("hides unlisted pages from the leaderboard and lets the owner edit and delete", async () => {
    const mine = (await call("GET", "/my/projects")).json.projects;
    const quiet = mine.find((p: { slug: string }) => p.slug === "quiet-one");
    assert.equal((await call("PATCH", `/my/projects/${quiet.id}`, { public: false, name: "Quiet" })).status, 200);
    const lb = (await call("GET", "/projects")).json.projects;
    assert.equal(lb.length, 1);
    assert.equal((await call("GET", "/projects/quiet-one")).json.project.name, "Quiet", "still reachable by link");

    const saved = cookie;
    cookie = "";
    assert.equal((await call("DELETE", `/my/projects/${quiet.id}`)).status, 401);
    cookie = saved;
    assert.equal((await call("DELETE", `/my/projects/${quiet.id}`)).status, 200);
    assert.equal((await call("GET", "/projects/quiet-one")).status, 404);
  });
});
