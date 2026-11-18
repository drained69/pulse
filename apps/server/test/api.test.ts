import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { encodeAbiParameters, encodeEventTopics, toEventSelector } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { SUBSCRIBED_EVENT, type RpcLog } from "../src/chain.ts";
import { applySubscriptionLog } from "../src/billing.ts";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { buildApp, buildServices } from "../src/main.ts";
import { StaticNameResolver } from "../src/names.ts";
import { testPayload } from "../src/payload.ts";
import { verify } from "../src/signing.ts";

const SHOP = "0x172083F7f31f82e4B57bA8aCf9822C72BB35b174";

type Received = { headers: IncomingMessage["headers"]; body: string };

describe("API", () => {
  const received: Received[] = [];
  let failNext = 0;
  const sink = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      if (failNext > 0) {
        failNext--;
        res.writeHead(500).end("nope");
      } else res.writeHead(200).end("ok");
    });
  });
  let sinkUrl = "";

  const cfg = loadConfig({
    DB_PATH: ":memory:",
    PUBLIC_URL: "http://localhost:8787",
    ALLOW_PRIVATE_WEBHOOKS: "true",
    FREE_MAX_HOOKS: "3",
    FREE_MONTHLY_EVENTS: "2",
    RPC_URLS: "http://127.0.0.1:1",
    TELEGRAM_BOT_TOKEN: "",
  } as NodeJS.ProcessEnv);
  const db = openDb(":memory:");
  const s = buildServices(cfg, { db, names: new StaticNameResolver({ "shop.qie": SHOP }) });
  const app = buildApp(s);
  const account = privateKeyToAccount(generatePrivateKey());
  let cookie = "";

  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(`/api${path}`, {
      method,
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as any;
    return { status: res.status, json, res };
  };

  before(async () => {
    await new Promise<void>((r) => sink.listen(0, "127.0.0.1", r));
    sinkUrl = `http://127.0.0.1:${(sink.address() as AddressInfo).port}/hook`;
  });
  after(() => sink.close());

  it("rejects unauthenticated requests", async () => {
    assert.equal((await call("GET", "/hooks")).status, 401);
  });

  it("signs in with a wallet signature (single-use nonce)", async () => {
    const n = await call("POST", "/auth/nonce", { address: account.address });
    assert.equal(n.status, 200);
    assert.match(n.json.message, /Chain ID: 1990/);
    const signature = await account.signMessage({ message: n.json.message });
    const bad = await call("POST", "/auth/verify", { address: SHOP, signature, nonce: n.json.nonce });
    assert.equal(bad.status, 401);
    const n2 = await call("POST", "/auth/nonce", { address: account.address });
    const sig2 = await account.signMessage({ message: n2.json.message });
    const v = await call("POST", "/auth/verify", { address: account.address, signature: sig2, nonce: n2.json.nonce });
    assert.equal(v.status, 200);
    cookie = (v.res.headers.get("set-cookie") ?? "").split(";")[0]!;
    assert.match(cookie, /^qh_session=/);
    const replay = await call("POST", "/auth/verify", { address: account.address, signature: sig2, nonce: n2.json.nonce });
    assert.equal(replay.status, 401);
    const me = await call("GET", "/me");
    assert.equal(me.json.user.address, account.address);
    assert.equal(me.json.plan.id, "free");
  });

  let hookId = "";
  it("creates a payment hook to a .qie name and resolves it", async () => {
    const r = await call("POST", "/hooks", {
      name: "Shop payments",
      trigger: { type: "payment", config: { recipient: "shop.qie", minAmount: "1" } },
      channel: { type: "webhook", config: { url: sinkUrl } },
    });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    hookId = r.json.hook.id;
    assert.equal(r.json.hook.trigger.resolved.recipient, SHOP);
    assert.deepEqual(r.json.hook.trigger.config.assets, ["QIE", "QUSDC"]);
    assert.match(r.json.hook.secret, /^whsec_/);
    assert.equal(s.hooks.getIndex().paymentsByRecipient.get(SHOP.toLowerCase())?.length, 1);
  });

  it("validates input with useful errors", async () => {
    const unknown = await call("POST", "/hooks", {
      name: "x",
      trigger: { type: "payment", config: { recipient: "nobody.qie" } },
      channel: { type: "webhook", config: { url: sinkUrl } },
    });
    assert.equal(unknown.status, 400);
    assert.match(unknown.json.error, /not registered/);
    const badEvent = await call("POST", "/hooks", {
      name: "x",
      trigger: { type: "contract_event", config: { event: "not an event" } },
      channel: { type: "webhook", config: { url: sinkUrl } },
    });
    assert.equal(badEvent.status, 400);
    const badDiscord = await call("POST", "/hooks", {
      name: "x",
      trigger: { type: "swap", config: { pair: "0x73a3ccf7da7e473ed2e9994ae764f0e30f4e4dfe" } },
      channel: { type: "discord", config: { url: "https://evil.example/api/webhooks/1/abc" } },
    });
    assert.equal(badDiscord.status, 400);
  });

  it("blocks cross-origin writes with a session cookie", async () => {
    const r = await call("POST", "/hooks", {}, { origin: "https://evil.example" });
    assert.equal(r.status, 403);
  });

  it("sends a signed test event", async () => {
    const r = await call("POST", `/hooks/${hookId}/test`);
    assert.equal(r.status, 200);
    assert.equal(r.json.result.ok, true);
    const got = received.at(-1)!;
    const hook = (await call("GET", `/hooks/${hookId}`)).json.hook;
    assert.ok(verify(hook.secret, String(got.headers["qiehooks-signature"]), Number(got.headers["qiehooks-timestamp"]), got.body));
    assert.equal(got.headers["qiehooks-event-type"], "test");
  });

  it("records events idempotently, retries failed deliveries and enforces the quota", async () => {
    const user = db.prepare("SELECT id FROM users WHERE address = ?").get(account.address) as { id: string };
    const hook = { id: hookId, user_id: user.id };
    const p1 = { ...testPayload({ id: hookId, name: "Shop payments" }, cfg), type: "payment.received" as const };
    assert.equal(s.hooks.recordEvent(hook, "0xaa:1", p1), true);
    assert.equal(s.hooks.recordEvent(hook, "0xaa:1", { ...p1, id: "evt_dupe" }), false, "duplicate ignored");

    failNext = 1;
    const before = received.length;
    await s.delivery.drain();
    assert.equal(received.length, before + 1);
    let events = (await call("GET", `/hooks/${hookId}/events`)).json.events;
    assert.equal(events[0].delivery.status, "pending");
    assert.equal(events[0].delivery.attempts, 1);
    assert.equal(events[0].delivery.responseCode, 500);

    db.prepare("UPDATE deliveries SET next_attempt_at = 0").run();
    await s.delivery.drain();
    events = (await call("GET", `/hooks/${hookId}/events`)).json.events;
    assert.equal(events[0].delivery.status, "success");
    assert.equal(events[0].delivery.attempts, 2);

    // Replay creates a fresh delivery.
    const rp = await call("POST", `/events/${events[0].id}/replay`);
    assert.equal(rp.status, 200);
    // A second replay while the first is still queued is refused (no delivery spam).
    assert.equal((await call("POST", `/events/${events[0].id}/replay`)).status, 409);
    await s.delivery.drain();
    assert.equal(JSON.parse(received.at(-1)!.body).id, p1.id);

    // Free quota in this test is 2 events/month.
    assert.equal(s.hooks.recordEvent(hook, "0xbb:1", { ...p1, id: "evt_2" }), true);
    assert.equal(s.hooks.recordEvent(hook, "0xcc:1", { ...p1, id: "evt_3" }), true);
    events = (await call("GET", `/hooks/${hookId}/events`)).json.events;
    assert.equal(events[0].delivery.status, "skipped");
    assert.equal((await call("GET", "/me")).json.usage.eventsThisMonth, 2);

    // Out-of-range limits are clamped instead of returning everything or erroring.
    for (const q of ["-1", "abc", "0", "99999"]) {
      const r = await call("GET", `/hooks/${hookId}/events?limit=${q}`);
      assert.equal(r.status, 200, q);
      assert.ok(r.json.events.length >= 1 && r.json.events.length <= 200, q);
    }
  });

  it("rejects oversized bodies and unbounded filters", async () => {
    const big = await call("POST", "/hooks", { name: "x", pad: "a".repeat(70_000) });
    assert.equal(big.status, 413);
    const filters = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`a${i}`, "1"]));
    const r = await call("POST", "/hooks", {
      name: "Too many filters",
      trigger: { type: "contract_event", config: { event: "event Paused(address account)", filters } },
      channel: { type: "webhook", config: { url: sinkUrl } },
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /16 filters/);
  });

  it("ignores spoofable proxy headers unless configured", async () => {
    // 30 auth calls per minute per client; rotating X-Forwarded-For must not reset the counter.
    let limited = false;
    for (let i = 0; i < 40 && !limited; i++) {
      const r = await call("POST", "/auth/nonce", { address: account.address }, { "x-forwarded-for": `203.0.113.${i}` });
      limited = r.status === 429;
    }
    assert.ok(limited, "rate limit applies despite rotating X-Forwarded-For");
  });

  it("sends security headers with the dashboard", async () => {
    const res = await app.request("/api/health");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  });

  it("enforces the hook limit and lifts it after an on-chain subscription", async () => {
    for (let i = 0; i < 2; i++) {
      const r = await call("POST", "/hooks", {
        name: `Swap ${i}`,
        trigger: { type: "swap", config: { pair: "0x73a3ccf7da7e473ed2e9994ae764f0e30f4e4dfe" } },
        channel: { type: "webhook", config: { url: sinkUrl } },
      });
      assert.equal(r.status, 201);
    }
    const over = await call("POST", "/hooks", {
      name: "One too many",
      trigger: { type: "swap", config: { pair: "0x73a3ccf7da7e473ed2e9994ae764f0e30f4e4dfe" } },
      channel: { type: "webhook", config: { url: sinkUrl } },
    });
    assert.equal(over.status, 402);

    const paidUntil = BigInt(Math.floor(Date.now() / 1000) + 30 * 86400);
    const log: RpcLog = {
      address: "0x9999999999999999999999999999999999999999",
      topics: encodeEventTopics({ abi: [SUBSCRIBED_EVENT], args: { account: account.address, planId: 1 } }) as `0x${string}`[],
      data: encodeAbiParameters([{ type: "uint32" }, { type: "uint256" }, { type: "uint64" }], [1, 9_000_000n, paidUntil]),
      blockNumber: "0x1",
      transactionHash: `0x${"ef".repeat(32)}`,
      transactionIndex: "0x0",
      logIndex: "0x0",
      blockHash: `0x${"00".repeat(32)}`,
    };
    assert.equal(log.topics[0], toEventSelector(SUBSCRIBED_EVENT));
    assert.ok(applySubscriptionLog(db, log));
    assert.equal(applySubscriptionLog(db, log), null, "same log applied once");
    const me = (await call("GET", "/me")).json;
    assert.equal(me.plan.id, "pro");
    assert.equal(me.plan.expiresAt, Number(paidUntil));
    const ok = await call("POST", "/hooks", {
      name: "Now allowed",
      trigger: { type: "swap", config: { pair: "0x73a3ccf7da7e473ed2e9994ae764f0e30f4e4dfe" } },
      channel: { type: "webhook", config: { url: sinkUrl } },
    });
    assert.equal(ok.status, 201);
  });

  it("issues API keys that work as Bearer tokens", async () => {
    const k = await call("POST", "/keys", { name: "ci" });
    assert.equal(k.status, 201);
    const saved = cookie;
    cookie = "";
    const r = await call("GET", "/hooks", undefined, { authorization: `Bearer ${k.json.key}` });
    assert.equal(r.status, 200);
    assert.ok(r.json.hooks.length >= 1);
    const noKeyMinting = await call("POST", "/keys", { name: "x" }, { authorization: `Bearer ${k.json.key}` });
    assert.equal(noKeyMinting.status, 403);
    assert.equal((await call("GET", "/hooks", undefined, { authorization: "Bearer qh_live_nope" })).status, 401);
    cookie = saved;
  });

  it("links a Telegram chat with a one-time code", () => {
    const user = db.prepare("SELECT id FROM users WHERE address = ?").get(account.address) as { id: string };
    const { code } = s.telegram.createLinkCode(user.id);
    const reply = s.telegram.handleText({ id: -100123, type: "supergroup", title: "Shop staff" }, `/link ${code}`);
    assert.match(reply ?? "", /Linked/);
    assert.match(s.telegram.handleText({ id: 5, type: "private" }, `/start ${code}`) ?? "", /invalid or expired/);
    const chats = db.prepare("SELECT * FROM telegram_chats WHERE user_id = ?").all(user.id);
    assert.equal(chats.length, 1);
  });

  it("validates and resolves the new trigger types", async () => {
    const ch = { type: "webhook", config: { url: sinkUrl } };
    const w = await call("POST", "/hooks", { name: "Watch shop", trigger: { type: "wallet", config: { address: "shop.qie" } }, channel: ch });
    assert.equal(w.status, 201, JSON.stringify(w.json));
    assert.equal(w.json.hook.trigger.resolved.address, SHOP);
    assert.equal(s.hooks.getIndex().walletsByAddress.get(SHOP.toLowerCase())?.length, 1);

    const both = await call("POST", "/hooks", { name: "x", trigger: { type: "balance", config: { address: SHOP, below: "1", above: "2" } }, channel: ch });
    assert.equal(both.status, 400);
    const price = await call("POST", "/hooks", { name: "x", trigger: { type: "price", config: { token: "WQIE" } }, channel: ch });
    assert.equal(price.status, 400);
    const digestBad = await call("POST", "/hooks", { name: "x", trigger: { type: "daily_digest", config: { sourceHookId: "hk_someone_else" } }, channel: ch });
    assert.equal(digestBad.status, 400);
    const digest = await call("POST", "/hooks", { name: "Daily", trigger: { type: "daily_digest", config: { sourceHookId: w.json.hook.id, hourUtc: 7 } }, channel: ch });
    assert.equal(digest.status, 201, JSON.stringify(digest.json));
    const nameWatch = await call("POST", "/hooks", { name: "Name", trigger: { type: "name_watch", config: { name: "Shop.QIE" } }, channel: ch });
    assert.equal(nameWatch.json.hook.trigger.config.name, "shop.qie");
    const multi = await call("POST", "/hooks", {
      name: "Safe",
      trigger: { type: "contract_event", config: { address: SHOP, events: ["event AddedOwner(address indexed owner)", "garbage"] } },
      channel: ch,
    });
    assert.equal(multi.status, 400);
    assert.match(multi.json.error, /garbage/);
    for (const id of [w.json.hook.id, digest.json.hook.id, nameWatch.json.hook.id]) await call("DELETE", `/hooks/${id}`);
  });

  it("deletes hooks and only the owner's", async () => {
    const other = await call("DELETE", "/hooks/hk_doesnotexist");
    assert.equal(other.status, 404);
    const d = await call("DELETE", `/hooks/${hookId}`);
    assert.equal(d.status, 200);
    assert.equal(s.hooks.getIndex().paymentsByRecipient.size, 0);
  });

  it("serves public config and status", async () => {
    cookie = "";
    const c = await call("GET", "/config");
    assert.equal(c.json.chainId, 1990);
    const st = await call("GET", "/status");
    assert.equal(st.json.rpc.length, 1);
    assert.ok(st.json.totals.users >= 1);
  });
});
