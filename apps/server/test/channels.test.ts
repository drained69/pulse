import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { QIE_MAINNET } from "../src/chain.ts";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { buildServices } from "../src/main.ts";
import { StaticNameResolver, type NameResolver } from "../src/names.ts";
import { buildPayload, REVERSE_LOOKUP_BUDGET_MS, testPayload } from "../src/payload.ts";
import type { UserRow } from "../src/billing.ts";

const SHOP = "0x172083F7f31f82e4B57bA8aCf9822C72BB35b174";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A tiny stand-in for api.telegram.org: getMe, long-polled getUpdates, sendMessage. */
function fakeTelegram() {
  const sent: Record<string, any>[] = [];
  const queue: unknown[] = [];
  let failWith: { status: number; description: string } | null = null;
  let nextId = 1;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const method = req.url!.split("/").pop();
      const json = body ? JSON.parse(body) : {};
      const reply = (status: number, payload: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload));
      if (!req.url!.startsWith("/bot123:TEST/")) return reply(401, { ok: false, description: "Unauthorized" });
      if (method === "getMe") return reply(200, { ok: true, result: { id: 1, is_bot: true, username: "QieHooksTestBot" } });
      if (method === "getUpdates") {
        for (let i = 0; i < 10 && queue.length === 0; i++) await sleep(50);
        const updates = queue.splice(0).map((u) => ({ update_id: nextId++, ...(u as object) }));
        return reply(200, { ok: true, result: updates });
      }
      if (method === "sendMessage") {
        if (failWith) return reply(failWith.status, { ok: false, error_code: failWith.status, description: failWith.description });
        sent.push(json);
        return reply(200, { ok: true, result: { message_id: sent.length } });
      }
      reply(404, { ok: false, description: "Not Found" });
    });
  });
  return {
    server,
    sent,
    push: (u: unknown) => queue.push(u),
    fail: (f: { status: number; description: string } | null) => (failWith = f),
  };
}

describe("Telegram channel (against a fake Bot API)", () => {
  const tg = fakeTelegram();
  let s: ReturnType<typeof buildServices>;
  let user: UserRow;

  before(async () => {
    await new Promise<void>((r) => tg.server.listen(0, "127.0.0.1", r));
    const cfg = loadConfig({
      DB_PATH: ":memory:",
      RPC_URLS: "http://127.0.0.1:1",
      TELEGRAM_BOT_TOKEN: "123:TEST",
      TELEGRAM_API_BASE: `http://127.0.0.1:${(tg.server.address() as AddressInfo).port}`,
    } as NodeJS.ProcessEnv);
    s = buildServices(cfg, { db: openDb(":memory:"), names: new StaticNameResolver({ "shop.qie": SHOP }) });
    s.db.prepare("INSERT INTO users (id, address, plan, created_at) VALUES ('usr_1', ?, 'free', 0)").run(SHOP);
    user = s.db.prepare("SELECT * FROM users WHERE id = 'usr_1'").get() as UserRow;
    void s.telegram.run();
  });
  after(() => {
    s.telegram.stop();
    tg.server.close();
  });

  let chatRef = "";
  it("links a group chat when someone posts /link CODE there", async () => {
    const { code, deepLink } = s.telegram.createLinkCode(user.id);
    tg.push({ message: { chat: { id: -100555, type: "supergroup", title: "Shop staff" }, text: `/link@QieHooksTestBot ${code}` } });
    for (let i = 0; i < 60 && !tg.sent.some((m) => /Linked/.test(m.text)); i++) await sleep(50);
    const confirm = tg.sent.find((m) => /Linked/.test(m.text));
    assert.ok(confirm, "bot confirmed in the chat");
    assert.equal(confirm.chat_id, "-100555");
    const chat = s.db.prepare("SELECT * FROM telegram_chats WHERE user_id = 'usr_1'").get() as { id: string; title: string; chat_type: string };
    assert.equal(chat.title, "Shop staff");
    assert.equal(chat.chat_type, "supergroup");
    chatRef = chat.id;
    // The bot learned its username from getMe, so deep links work for codes made after startup.
    assert.match(s.telegram.createLinkCode(user.id).deepLink ?? "", /^https:\/\/t\.me\/QieHooksTestBot\?start=/);
    assert.equal(deepLink === null || deepLink.startsWith("https://t.me/"), true);
  });

  it("delivers an event as a formatted message with an explorer button", async () => {
    const hook = await s.hooks.create(user, {
      name: "Shop payments",
      trigger: { type: "payment", config: { recipient: "shop.qie" } },
      channel: { type: "telegram", config: { chatRef } },
    });
    const p = { ...testPayload({ id: hook.id, name: hook.name }, s.cfg), type: "payment.received" as const };
    p.tx = { hash: `0x${"ab".repeat(32)}`, blockNumber: 1, logIndex: 0, timestamp: 1, explorerUrl: "https://mainnet.qie.digital/tx/0xabab" };
    s.hooks.recordEvent({ id: hook.id, user_id: user.id }, "k1", p);
    const before = tg.sent.length;
    await s.delivery.drain();
    const msg = tg.sent[before]!;
    assert.equal(msg.chat_id, "-100555");
    assert.equal(msg.parse_mode, "HTML");
    assert.match(msg.text, /💸 <b>shop\.qie received 25 QUSDC \(~\$25\)<\/b>/);
    assert.match(msg.text, /From: alice\.qie/);
    assert.equal(msg.reply_markup.inline_keyboard[0][0].url, "https://mainnet.qie.digital/tx/0xabab");
    const d = s.db.prepare("SELECT status, attempts FROM deliveries ORDER BY rowid DESC LIMIT 1").get() as { status: string; attempts: number };
    assert.deepEqual({ ...d }, { status: "success", attempts: 1 });
  });

  it("escapes HTML in user-controlled text", async () => {
    const hook = await s.hooks.create(user, {
      name: "<script>alert(1)</script>",
      trigger: { type: "payment", config: { recipient: "shop.qie" } },
      channel: { type: "telegram", config: { chatRef } },
    });
    s.hooks.recordEvent({ id: hook.id, user_id: user.id }, "k-html", testPayload({ id: hook.id, name: hook.name }, s.cfg));
    const before = tg.sent.length;
    await s.delivery.drain();
    assert.match(tg.sent[before]!.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(tg.sent[before]!.text, /<script>/);
  });

  it("stops retrying when the bot was removed from the chat", async () => {
    const hook = s.hooks.list(user.id).find((h) => h.name === "Shop payments")!;
    tg.fail({ status: 403, description: "Forbidden: bot was kicked from the supergroup chat" });
    s.hooks.recordEvent({ id: hook.id, user_id: user.id }, "k2", testPayload({ id: hook.id, name: hook.name }, s.cfg));
    await s.delivery.drain();
    tg.fail(null);
    const d = s.db.prepare("SELECT status, attempts, last_error FROM deliveries ORDER BY rowid DESC LIMIT 1").get() as { status: string; attempts: number; last_error: string };
    assert.equal(d.status, "failed", "permanent: no point retrying for 8 hours");
    assert.equal(d.attempts, 1);
    assert.match(d.last_error, /kicked/);
  });
});

describe("Discord channel", () => {
  it("posts an embed and gives up on a deleted webhook", async () => {
    const cfg = loadConfig({ DB_PATH: ":memory:", RPC_URLS: "http://127.0.0.1:1" } as NodeJS.ProcessEnv);
    const s = buildServices(cfg, { db: openDb(":memory:"), names: new StaticNameResolver({}) });
    s.db.prepare("INSERT INTO users (id, address, plan, created_at) VALUES ('usr_1', ?, 'free', 0)").run(SHOP);
    const user = s.db.prepare("SELECT * FROM users").get() as UserRow;
    const url = "https://discord.com/api/webhooks/123456/abc-DEF_ghi";
    const hook = await s.hooks.create(user, { name: "Whales", trigger: { type: "token_transfer", config: { token: "QUSDC", minAmount: "1000" } }, channel: { type: "discord", config: { url } } });

    const realFetch = globalThis.fetch;
    const posts: { url: string; body: any }[] = [];
    let status = 204;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const u = String(input);
      if (!u.startsWith("https://discord.com/")) return realFetch(input, init);
      posts.push({ url: u, body: JSON.parse(String(init?.body)) });
      return new Response(status === 204 ? null : "{}", { status });
    }) as typeof fetch;
    try {
      s.hooks.recordEvent({ id: hook.id, user_id: user.id }, "d1", testPayload({ id: hook.id, name: hook.name }, cfg));
      await s.delivery.drain();
      assert.equal(posts[0]!.url, `${url}?wait=true`);
      assert.equal(posts[0]!.body.username, "QIE Hooks");
      assert.match(posts[0]!.body.embeds[0].title, /Test event/);
      assert.equal(posts[0]!.body.embeds[0].footer.text, "Whales");

      status = 404;
      s.hooks.recordEvent({ id: hook.id, user_id: user.id }, "d2", testPayload({ id: hook.id, name: hook.name }, cfg));
      await s.delivery.drain();
      const d = s.db.prepare("SELECT status, attempts FROM deliveries ORDER BY rowid DESC LIMIT 1").get() as { status: string; attempts: number };
      assert.deepEqual({ ...d }, { status: "failed", attempts: 1 });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("alert latency and housekeeping", () => {
  it("never holds an alert longer than the reverse-lookup budget", async () => {
    const slow: NameResolver = { resolve: async () => null, reverse: () => new Promise((r) => setTimeout(() => r("late.qie"), 5000).unref()) };
    const cfg = loadConfig({ DB_PATH: ":memory:", RPC_URLS: "http://127.0.0.1:1" } as NodeJS.ProcessEnv);
    const s = buildServices(cfg, { db: openDb(":memory:"), names: slow });
    const hookRow = { id: "hk_1", name: "x" } as never;
    const started = Date.now();
    const p = await buildPayload(
      {
        hook: hookRow,
        type: "payment.received",
        dedupeKey: "k",
        blockNumber: 1,
        txHash: `0x${"11".repeat(32)}`,
        logIndex: 0,
        data: { from: SHOP, to: SHOP, token: { address: QIE_MAINNET.QUSDC, symbol: "QUSDC", decimals: 6 }, amount: 1_000_000n },
      },
      1,
      { chainId: 1990, network: "mainnet", explorerUrl: "https://mainnet.qie.digital", names: slow, tokens: s.tokens },
    );
    const took = Date.now() - started;
    assert.ok(took < REVERSE_LOOKUP_BUDGET_MS + 400, `took ${took} ms`);
    assert.equal((p.data.from as { name: string | null }).name, null);
    assert.equal((p.data.amount as { display: string }).display, "1 QUSDC");
  });

  it("prunes events past retention together with their deliveries", () => {
    const cfg = loadConfig({ DB_PATH: ":memory:", RPC_URLS: "http://127.0.0.1:1", EVENT_RETENTION_DAYS: "30" } as NodeJS.ProcessEnv);
    const s = buildServices(cfg, { db: openDb(":memory:"), names: new StaticNameResolver({}) });
    const db = s.db;
    db.prepare("INSERT INTO users (id, address, plan, created_at) VALUES ('usr_1', ?, 'free', 0)").run(SHOP);
    db.prepare(
      `INSERT INTO hooks (id, user_id, name, trigger_type, trigger_config, channel_type, channel_config, secret, created_at, updated_at)
       VALUES ('hk_1', 'usr_1', 'h', 'payment', '{}', 'webhook', '{}', 's', 0, 0)`,
    ).run();
    const now = Math.floor(Date.now() / 1000);
    for (const [id, age] of [["old", 40], ["new", 1]] as const) {
      db.prepare("INSERT INTO events (id, hook_id, dedupe_key, event_type, payload, created_at) VALUES (?, 'hk_1', ?, 'test', '{}', ?)").run(id, id, now - age * 86400);
      db.prepare("INSERT INTO deliveries (id, event_id, hook_id, status, next_attempt_at, created_at) VALUES (?, ?, 'hk_1', 'success', 0, 0)").run(`d_${id}`, id);
    }
    assert.equal(s.checks.prune(now).events, 1);
    assert.deepEqual(
      (db.prepare("SELECT id FROM events").all() as { id: string }[]).map((r) => r.id),
      ["new"],
    );
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM deliveries").get() as { n: number }).n, 1);
  });
});
