import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { QIE_MAINNET } from "./chain.ts";
import { SESSION_COOKIE, type AuthService } from "./auth.ts";
import { planFor, usageThisMonth, type UserRow } from "./billing.ts";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import type { DeliveryWorker } from "./delivery.ts";
import { HttpError, type HookService } from "./hooks.ts";
import type { Checks } from "./checks.ts";
import type { Indexer } from "./indexer.ts";
import type { InvoiceService } from "./invoices.ts";
import { createMcp } from "./mcp.ts";
import type { ProjectService } from "./projects.ts";
import { normalizeQieName, type NameResolver } from "./names.ts";
import { testPayload, type EventPayload } from "./payload.ts";
import type { Metrics } from "./metrics.ts";
import type { RpcPool } from "./rpc.ts";
import type { IpLimiter, RpcGateway, StreamHub } from "./stream.ts";
import type { Telegram } from "./telegram.ts";
import type { TokenService } from "./tokens.ts";
import { errMsg, log, newId, nowSec, toJson } from "./util.ts";

export type Services = {
  cfg: Config;
  db: Db;
  rpc: RpcPool;
  auth: AuthService;
  hooks: HookService;
  indexer: Indexer;
  checks: Checks;
  delivery: DeliveryWorker;
  telegram: Telegram;
  names: NameResolver;
  tokens: TokenService;
  projects: ProjectService;
  invoices: InvoiceService;
  metrics: Metrics;
  stream: StreamHub;
  gateway: RpcGateway;
  rpcLimiter: IpLimiter;
  /** Set once the HTTP server is listening (WebSocket connections are counted there). */
  wsConnections?: () => number;
};

type Env = { Variables: { user: UserRow; authKind: "session" | "apikey" } };

/** Tiny fixed-window rate limiter keyed by IP + route group. */
function rateLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (key: string): boolean => {
    const now = Date.now();
    const h = hits.get(key);
    if (!h || h.reset < now) {
      hits.set(key, { n: 1, reset: now + windowMs });
      if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
      return true;
    }
    h.n++;
    return h.n <= limit;
  };
}

/** Client IP for rate limiting. Proxy headers are trusted only when configured (they are client-settable otherwise). */
function clientIp(c: Context, header: string): string {
  if (header) {
    // For X-Forwarded-For style lists the last hop is the one our own proxy appended.
    const v = c.req.header(header)?.split(",").at(-1)?.trim();
    if (v) return v;
  }
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? "local";
}

async function body<T = Record<string, unknown>>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new HttpError(400, "Body must be valid JSON");
  }
}

export function createApi(s: Services): Hono<Env> {
  const { cfg, db } = s;
  const app = new Hono<Env>();
  const authLimit = rateLimiter(30, 60_000);
  const apiLimit = rateLimiter(300, 60_000);
  const allowedOrigins = new Set([new URL(cfg.publicUrl).origin, ...(process.env.DEV_ORIGINS ?? "http://localhost:5173").split(",").map((o) => o.trim())]);

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
    log.error("api error", { path: c.req.path, error: errMsg(err) });
    return c.json({ error: "Internal error" }, 500);
  });

  app.use("*", bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: "Request body too large" }, 413) }));

  app.use("*", async (c, next) => {
    if (!apiLimit(`api:${clientIp(c, cfg.clientIpHeader)}`)) return c.json({ error: "Too many requests" }, 429);
    await next();
  });

  // ───────── public ─────────

  app.get("/health", (c) => c.json({ ok: true }));

  app.get("/config", (c) =>
    c.json({
      chainId: cfg.chainId,
      network: cfg.network,
      explorerUrl: cfg.explorerUrl,
      rpcUrl: cfg.rpcUrls[0],
      qusdc: QIE_MAINNET.QUSDC,
      dexRouter: QIE_MAINNET.QIEDEX_ROUTER,
      billingContract: cfg.billingContract,
      proPriceQusdc: cfg.proPriceQusdc,
      proPeriodDays: cfg.proPeriodDays,
      plans: cfg.plans,
      telegram: { enabled: s.telegram.enabled, botUsername: cfg.telegramBotUsername || null },
    }),
  );

  app.get("/status", (c) => {
    const st = s.indexer.status;
    const since = nowSec() - 86400;
    const d = db
      .prepare("SELECT status, COUNT(*) AS n, AVG(latency_ms) AS lat FROM deliveries WHERE created_at > ? GROUP BY status")
      .all(since) as { status: string; n: number; lat: number | null }[];
    const by = Object.fromEntries(d.map((r) => [r.status, r.n]));
    const succ = d.find((r) => r.status === "success");
    const totals = db.prepare("SELECT (SELECT COUNT(*) FROM hooks WHERE active = 1) AS hooks, (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM events) AS events").get() as Record<string, number>;
    const done = (by.success ?? 0) + (by.failed ?? 0);
    return c.json({
      chainId: cfg.chainId,
      network: cfg.network,
      indexer: { ...st, uptimeSec: Math.round((Date.now() - st.startedAt) / 1000) },
      checks: { lastRunAt: s.checks.lastRunAt, intervalMs: cfg.checkIntervalMs },
      rpc: s.rpc.endpoints.map((e) => ({ url: e.url, healthy: e.healthy, latencyMs: e.latencyMs, lastBlock: e.lastBlock, lastError: e.lastError, lastCheckedAt: e.lastCheckedAt })),
      deliveries24h: { ...by, successRate: done ? Math.round(((by.success ?? 0) / done) * 1000) / 10 : null, avgLatencyMs: succ?.lat ? Math.round(succ.lat) : null },
      totals,
      telegram: s.telegram.enabled,
      /** Milliseconds from the block's on-chain timestamp, last 24 h (upper bounds: timestamps have 1 s resolution). */
      latency: s.metrics.all(),
      stream: { ...s.stream.status, connections: s.wsConnections?.() ?? 0, filters: s.gateway.filterCount },
    });
  });

  app.get("/resolve", async (c) => {
    const name = normalizeQieName(c.req.query("name") ?? "");
    if (!name) throw new HttpError(400, "name must look like yourname.qie");
    const address = await s.names.resolve(name).catch((e) => {
      throw new HttpError(502, `QIE ID lookup failed: ${errMsg(e)}`);
    });
    return c.json({ name, address });
  });

  app.get("/pairs", async (c) => {
    await s.tokens.refreshPairs();
    return c.json({ pairs: s.tokens.listPairs() });
  });

  // ───────── traction pages (public) ─────────

  app.get("/projects", (c) => c.json({ projects: s.projects.leaderboard() }));

  app.get("/projects/:slug", (c) => {
    const p = s.projects.bySlug(c.req.param("slug"));
    if (!p) throw new HttpError(404, "No traction page with that name");
    const owner = db.prepare("SELECT address, qie_name FROM users WHERE id = ?").get(p.user_id) as { address: string; qie_name: string | null };
    return c.json({
      project: {
        slug: p.slug,
        name: p.name,
        description: p.description,
        website: p.website,
        contracts: JSON.parse(p.contracts) as string[],
        verifiedBy: p.verified_by,
        listed: p.public === 1,
        backfill: { status: p.backfill_status, error: p.backfill_error },
        createdAt: p.created_at,
      },
      owner: { address: owner.address, qieName: owner.qie_name },
      stats: s.projects.stats(p.id),
      indexedBlock: s.indexer.status.cursor,
      backfillDays: cfg.backfillDays,
    });
  });

  app.get("/projects/:slug/badge.svg", (c) => {
    const p = s.projects.bySlug(c.req.param("slug"));
    if (!p) throw new HttpError(404, "No traction page with that name");
    c.header("content-type", "image/svg+xml; charset=utf-8");
    c.header("cache-control", "public, max-age=300");
    return c.body(s.projects.badge(p));
  });

  // ───────── payment links (public checkout) ─────────

  app.get("/pay/:id", (c) => {
    c.header("cache-control", "no-store");
    return c.json({ invoice: s.invoices.getPublic(c.req.param("id")) });
  });

  // ───────── MCP server for AI agents (API-key auth) ─────────
  app.route("/mcp", createMcp(s));

  // ───────── auth ─────────

  app.post("/auth/nonce", async (c) => {
    if (!authLimit(`auth:${clientIp(c, cfg.clientIpHeader)}`)) return c.json({ error: "Too many requests" }, 429);
    const b = await body<{ address?: string }>(c);
    return c.json(s.auth.createNonce(String(b.address ?? "")));
  });

  app.post("/auth/verify", async (c) => {
    if (!authLimit(`auth:${clientIp(c, cfg.clientIpHeader)}`)) return c.json({ error: "Too many requests" }, 429);
    const b = await body<{ address?: string; signature?: string; nonce?: string }>(c);
    const { token, user } = await s.auth.verify(String(b.address ?? ""), String(b.signature ?? ""), String(b.nonce ?? ""));
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      secure: cfg.secureCookies,
      sameSite: "Lax",
      path: "/",
      maxAge: cfg.sessionDays * 86400,
    });
    return c.json({ user: { id: user.id, address: user.address, qieName: user.qie_name } });
  });

  app.post("/auth/logout", (c) => {
    s.auth.logout(getCookie(c, SESSION_COOKIE));
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  // ───────── authenticated ─────────

  const authed = new Hono<Env>();
  authed.use("*", async (c, next) => {
    const bearer = c.req.header("authorization")?.match(/^Bearer\s+(qh_\S+)$/)?.[1];
    if (bearer) {
      const user = s.auth.userForApiKey(bearer);
      if (!user) throw new HttpError(401, "Invalid API key");
      c.set("user", user);
      c.set("authKind", "apikey");
      return next();
    }
    const user = s.auth.userForSession(getCookie(c, SESSION_COOKIE));
    if (!user) throw new HttpError(401, "Sign in first");
    // Cookie auth: block cross-site writes.
    if (c.req.method !== "GET") {
      const origin = c.req.header("origin");
      if (origin && !allowedOrigins.has(origin)) {
        let sameHost = false;
        try {
          sameHost = new URL(origin).host === (c.req.header("x-forwarded-host") ?? c.req.header("host"));
        } catch {
          /* malformed Origin */
        }
        if (!sameHost) throw new HttpError(403, "Cross-origin request blocked");
      }
    }
    c.set("user", user);
    c.set("authKind", "session");
    return next();
  });

  authed.get("/me", (c) => {
    const u = c.get("user");
    const plan = planFor(cfg, u);
    const hooks = (db.prepare("SELECT COUNT(*) AS n FROM hooks WHERE user_id = ?").get(u.id) as { n: number }).n;
    return c.json({
      user: { id: u.id, address: u.address, qieName: u.qie_name, createdAt: u.created_at },
      plan: { ...plan, expiresAt: plan.id === "pro" ? u.plan_expires_at : null },
      usage: { hooks, eventsThisMonth: usageThisMonth(db, u.id) },
    });
  });

  authed.get("/hooks", (c) => c.json({ hooks: s.hooks.list(c.get("user").id) }));
  authed.post("/hooks", async (c) => c.json({ hook: await s.hooks.create(c.get("user"), await body(c)) }, 201));
  authed.get("/hooks/:id", (c) => c.json({ hook: s.hooks.get(c.get("user").id, c.req.param("id")) }));
  authed.patch("/hooks/:id", async (c) => c.json({ hook: await s.hooks.update(c.get("user").id, c.req.param("id"), await body(c)) }));
  authed.delete("/hooks/:id", (c) => {
    s.hooks.remove(c.get("user").id, c.req.param("id"));
    return c.json({ ok: true });
  });
  authed.post("/hooks/:id/rotate-secret", (c) => c.json({ hook: s.hooks.rotateSecret(c.get("user").id, c.req.param("id")) }));

  /** Send a sample event straight to the hook's destination and report the result (not stored). */
  authed.post("/hooks/:id/test", async (c) => {
    const user = c.get("user");
    const hook = s.hooks.get(user.id, c.req.param("id"));
    const p = testPayload({ id: hook.id, name: hook.name }, cfg);
    const bodyText = toJson(p);
    const r = await s.delivery.attempt(hook.channel.type, hook.channel.config as Record<string, string>, p, bodyText, hook.secret, user.id);
    return c.json({ result: r, payload: p });
  });

  authed.get("/hooks/:id/events", (c) => {
    const user = c.get("user");
    s.hooks.get(user.id, c.req.param("id"));
    const n = Math.floor(Number(c.req.query("limit") ?? 50));
    const limit = Number.isFinite(n) ? Math.min(Math.max(n, 1), 200) : 50;
    const rows = db
      .prepare(
        `SELECT e.id, e.event_type, e.payload, e.created_at, d.id AS delivery_id, d.status, d.attempts, d.response_code, d.last_error, d.latency_ms, d.delivered_at, d.next_attempt_at
         FROM events e LEFT JOIN deliveries d ON d.id = (SELECT id FROM deliveries WHERE event_id = e.id ORDER BY created_at DESC LIMIT 1)
         WHERE e.hook_id = ? ORDER BY e.created_at DESC, e.rowid DESC LIMIT ?`,
      )
      .all(c.req.param("id"), limit) as Record<string, unknown>[];
    return c.json({
      events: rows.map((r) => ({
        id: r.id,
        type: r.event_type,
        createdAt: r.created_at,
        payload: JSON.parse(r.payload as string) as EventPayload,
        delivery: r.delivery_id
          ? {
              id: r.delivery_id,
              status: r.status,
              attempts: r.attempts,
              responseCode: r.response_code,
              error: r.last_error,
              latencyMs: r.latency_ms,
              deliveredAt: r.delivered_at,
              nextAttemptAt: r.next_attempt_at,
            }
          : null,
      })),
    });
  });

  authed.post("/events/:id/replay", (c) => {
    const user = c.get("user");
    const ev = db
      .prepare("SELECT e.id, e.hook_id FROM events e JOIN hooks h ON h.id = e.hook_id WHERE e.id = ? AND h.user_id = ?")
      .get(c.req.param("id"), user.id) as { id: string; hook_id: string } | undefined;
    if (!ev) throw new HttpError(404, "Event not found");
    const pending = db.prepare("SELECT 1 FROM deliveries WHERE event_id = ? AND status = 'pending'").get(ev.id);
    if (pending) throw new HttpError(409, "This event already has a delivery waiting to be sent");
    const id = newId("dlv");
    db.prepare("INSERT INTO deliveries (id, event_id, hook_id, status, attempts, next_attempt_at, created_at) VALUES (?, ?, ?, 'pending', 0, ?, ?)").run(
      id,
      ev.id,
      ev.hook_id,
      nowSec(),
      nowSec(),
    );
    s.delivery.notify();
    return c.json({ deliveryId: id });
  });

  authed.get("/keys", (c) =>
    c.json({
      keys: db
        .prepare("SELECT id, name, prefix, created_at AS createdAt, last_used_at AS lastUsedAt FROM api_keys WHERE user_id = ? ORDER BY created_at DESC")
        .all(c.get("user").id),
    }),
  );
  authed.post("/keys", async (c) => {
    if (c.get("authKind") !== "session") throw new HttpError(403, "Create API keys from the dashboard");
    const b = await body<{ name?: string }>(c);
    return c.json(s.auth.createApiKey(c.get("user").id, String(b.name ?? "API key")), 201);
  });
  authed.delete("/keys/:id", (c) => {
    db.prepare("DELETE FROM api_keys WHERE id = ? AND user_id = ?").run(c.req.param("id"), c.get("user").id);
    return c.json({ ok: true });
  });

  authed.post("/telegram/link", (c) => {
    if (!s.telegram.enabled) throw new HttpError(503, "Telegram is not configured on this server");
    return c.json(s.telegram.createLinkCode(c.get("user").id));
  });
  authed.get("/telegram/chats", (c) =>
    c.json({
      chats: db
        .prepare("SELECT id, title, chat_type AS chatType, created_at AS createdAt FROM telegram_chats WHERE user_id = ? ORDER BY created_at DESC")
        .all(c.get("user").id),
    }),
  );
  authed.delete("/telegram/chats/:id", (c) => {
    db.prepare("DELETE FROM telegram_chats WHERE id = ? AND user_id = ?").run(c.req.param("id"), c.get("user").id);
    return c.json({ ok: true });
  });

  authed.get("/my/projects", (c) => c.json({ projects: s.projects.list(c.get("user").id) }));
  authed.post("/my/projects", async (c) => c.json({ project: await s.projects.create(c.get("user"), await body(c)) }, 201));
  authed.get("/my/projects/:id", (c) => c.json({ project: s.projects.get(c.get("user").id, c.req.param("id")) }));
  authed.patch("/my/projects/:id", async (c) => c.json({ project: await s.projects.update(c.get("user"), c.req.param("id"), await body(c)) }));
  authed.delete("/my/projects/:id", (c) => {
    s.projects.remove(c.get("user").id, c.req.param("id"));
    return c.json({ ok: true });
  });
  authed.post("/projects/:slug/claim", async (c) => c.json({ project: await s.projects.claim(c.get("user"), c.req.param("slug")) }));
  authed.post("/my/projects/:id/backfill", (c) => {
    const p = s.projects.get(c.get("user").id, c.req.param("id"));
    void s.projects.backfill(p.id);
    return c.json({ ok: true });
  });

  authed.post("/invoices", async (c) => c.json({ invoice: await s.invoices.create(c.get("user"), await body(c)) }, 201));
  authed.get("/invoices", (c) =>
    c.json({ invoices: s.invoices.list(c.get("user").id, { status: c.req.query("status"), limit: Number(c.req.query("limit") ?? 50) }), totals: s.invoices.stats(c.get("user").id) }),
  );
  authed.get("/invoices/:id", (c) => c.json({ invoice: s.invoices.get(c.get("user").id, c.req.param("id")) }));
  authed.post("/invoices/:id/cancel", (c) => c.json({ invoice: s.invoices.cancel(c.get("user").id, c.req.param("id")) }));

  authed.get("/billing", (c) => {
    const u = c.get("user");
    const subs = db
      .prepare("SELECT tx_hash AS txHash, periods, amount, paid_until AS paidUntil, created_at AS createdAt FROM subscriptions WHERE address = ? ORDER BY created_at DESC LIMIT 20")
      .all(u.address);
    return c.json({ plan: planFor(cfg, u), paidUntil: u.plan_expires_at, subscriptions: subs });
  });

  app.route("/", authed);
  return app;
}
