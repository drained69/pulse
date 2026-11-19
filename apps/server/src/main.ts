import { existsSync } from "node:fs";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { createApi, type Services } from "./api.ts";
import { AuthService } from "./auth.ts";
import { Checks } from "./checks.ts";
import { QIE_MAINNET } from "./chain.ts";
import { loadConfig, type Config } from "./config.ts";
import { openDb, type Db } from "./db.ts";
import { DeliveryWorker } from "./delivery.ts";
import { HookService } from "./hooks.ts";
import { Indexer } from "./indexer.ts";
import { InvoiceService } from "./invoices.ts";
import { McpNameResolver, type NameResolver } from "./names.ts";
import { ProjectService } from "./projects.ts";
import { RpcPool } from "./rpc.ts";
import { Telegram } from "./telegram.ts";
import { TokenService } from "./tokens.ts";
import { errMsg, log, nowSec, randomToken } from "./util.ts";

export function buildServices(cfg: Config, overrides: { db?: Db; names?: NameResolver } = {}): Services {
  const db = overrides.db ?? openDb(cfg.dbPath);
  const rpc = new RpcPool(cfg.rpcUrls);
  const names = overrides.names ?? new McpNameResolver(cfg.mcpUrl, cfg.network);
  const tokens = new TokenService(rpc, cfg.dexApiUrl);
  const telegram = new Telegram(cfg, db);
  const hooks = new HookService(cfg, db, names);
  const delivery = new DeliveryWorker(cfg, db, telegram);
  hooks.onDeliveriesQueued = () => delivery.notify();
  const indexer = new Indexer(cfg, db, rpc, hooks, names, tokens);
  const projects = new ProjectService(cfg, db, rpc);
  indexer.projects = projects;
  const invoices = new InvoiceService(cfg, db, hooks, names, tokens);
  indexer.invoices = invoices;
  const auth = new AuthService(cfg, db, names);
  const checks = new Checks(cfg, db, rpc, hooks, names, tokens);
  return { cfg, db, rpc, names, tokens, telegram, hooks, delivery, indexer, auth, checks, projects, invoices };
}

/**
 * Optional public feed: a system-owned hook that posts every large QUSDC
 * transfer to PUBLIC_ALERTS_CHAT_ID (a Telegram channel the bot can post in).
 */
export function ensurePublicAlerts(s: Services): void {
  const { cfg, db } = s;
  if (!cfg.publicAlertsChatId) return;
  const sysAddr = "0x0000000000000000000000000000000000000001";
  let sys = db.prepare("SELECT id FROM users WHERE address = ?").get(sysAddr) as { id: string } | undefined;
  if (!sys) {
    sys = { id: "usr_system" };
    db.prepare("INSERT INTO users (id, address, plan, created_at) VALUES (?, ?, 'system', ?)").run(sys.id, sysAddr, nowSec());
  }
  db.prepare(
    `INSERT INTO telegram_chats (id, user_id, chat_id, title, chat_type, created_at) VALUES ('tgc_public', ?, ?, 'Public alerts', 'channel', ?)
     ON CONFLICT(id) DO UPDATE SET chat_id = excluded.chat_id`,
  ).run(sys.id, cfg.publicAlertsChatId, nowSec());
  const config = JSON.stringify({ token: QIE_MAINNET.QUSDC, minAmount: cfg.publicAlertsMinQusdc });
  const existing = db.prepare("SELECT id FROM hooks WHERE id = 'hk_public_qusdc'").get();
  if (existing) {
    db.prepare("UPDATE hooks SET trigger_config = ?, active = 1 WHERE id = 'hk_public_qusdc'").run(config);
  } else {
    db.prepare(
      `INSERT INTO hooks (id, user_id, name, trigger_type, trigger_config, resolved, channel_type, channel_config, secret, active, created_at, updated_at)
       VALUES ('hk_public_qusdc', ?, 'Large QUSDC transfers', 'token_transfer', ?, '{}', 'telegram', '{"chatRef":"tgc_public"}', ?, 1, ?, ?)`,
    ).run(sys.id, config, `whsec_${randomToken(24)}`, nowSec(), nowSec());
  }
  // Second public feed: every new QIEDEX pair (PairCreated on the official factory).
  const pairsConfig = JSON.stringify({
    address: QIE_MAINNET.QIEDEX_FACTORY,
    event: "event PairCreated(address indexed token0, address indexed token1, address pair, uint256 index)",
    events: [],
    filters: {},
  });
  if (db.prepare("SELECT id FROM hooks WHERE id = 'hk_public_pairs'").get()) {
    db.prepare("UPDATE hooks SET trigger_config = ?, active = 1 WHERE id = 'hk_public_pairs'").run(pairsConfig);
  } else {
    db.prepare(
      `INSERT INTO hooks (id, user_id, name, trigger_type, trigger_config, resolved, channel_type, channel_config, secret, active, created_at, updated_at)
       VALUES ('hk_public_pairs', ?, 'New QIEDEX pairs', 'contract_event', ?, '{}', 'telegram', '{"chatRef":"tgc_public"}', ?, 1, ?, ?)`,
    ).run(sys.id, pairsConfig, `whsec_${randomToken(24)}`, nowSec(), nowSec());
  }
  s.hooks.invalidate();
  log.info("public alerts enabled", { chat: cfg.publicAlertsChatId, minQusdc: cfg.publicAlertsMinQusdc });
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: https:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

export function buildApp(s: Services): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    await next();
    c.header("x-content-type-options", "nosniff");
    c.header("referrer-policy", "strict-origin-when-cross-origin");
    c.header("x-frame-options", "DENY");
    if (c.res.headers.get("content-type")?.includes("text/html")) c.header("content-security-policy", CSP);
    if (s.cfg.secureCookies) c.header("strict-transport-security", "max-age=31536000");
  });
  app.route("/api", createApi(s));
  if (existsSync(s.cfg.webDist)) {
    // Hashed assets never change; index.html must always be revalidated so deploys show up.
    app.use("/*", async (c, next) => {
      await next();
      if (c.req.path.startsWith("/assets/")) c.header("cache-control", "public, max-age=31536000, immutable");
      else if (c.res.headers.get("content-type")?.includes("text/html")) c.header("cache-control", "no-cache");
    });
    app.use("/*", serveStatic({ root: s.cfg.webDist, rewriteRequestPath: (p) => p }));
    // SPA fallback
    app.get("*", serveStatic({ root: s.cfg.webDist, path: "index.html" }));
  } else {
    app.get("/", (c) => c.text("QIE Pulse API is running. Build the dashboard with `pnpm --filter @qiepulse/web build`."));
  }
  return app;
}

export async function start(cfg = loadConfig()) {
  const s = buildServices(cfg);
  ensurePublicAlerts(s);
  const app = buildApp(s);
  s.rpc.startProbing();
  void s.tokens.refreshPairs(true);
  s.projects.resumeBackfills();

  const tasks: Promise<void>[] = [s.delivery.run(), s.telegram.run(), s.checks.run()];
  if (!cfg.disableIndexer) tasks.push(s.indexer.run());

  const nameTimer = setInterval(() => void s.hooks.refreshNames().catch((e) => log.warn("name refresh failed", { error: errMsg(e) })), 10 * 60_000);
  nameTimer.unref();

  const server = serve({ fetch: app.fetch, port: cfg.port }, (info) =>
    log.info("QIE Pulse listening", { port: info.port, network: cfg.network, chainId: cfg.chainId, rpcs: cfg.rpcUrls.length }),
  );

  const shutdown = () => {
    log.info("shutting down");
    s.indexer.stop();
    s.delivery.stop();
    s.checks.stop();
    s.telegram.stop();
    s.rpc.stop();
    server.close();
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  void Promise.all(tasks).catch((e) => log.error("background task crashed", { error: errMsg(e) }));
  return { s, app, server };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start().catch((e) => {
    log.error("fatal", { error: errMsg(e) });
    process.exit(1);
  });
}

