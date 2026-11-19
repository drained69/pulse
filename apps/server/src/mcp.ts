import { Hono } from "hono";
import type { Services } from "./api.ts";
import type { UserRow } from "./billing.ts";
import { HttpError } from "./hooks.ts";
import { normalizeQieName } from "./names.ts";
import type { EventPayload } from "./payload.ts";
import { errMsg, nowSec, sleep } from "./util.ts";

/**
 * MCP server (Model Context Protocol, Streamable HTTP transport, stateless JSON
 * responses) so AI agents can watch QIE: create alerts, take payments through
 * payment links and wait for them to settle, and read on-chain traction.
 *
 *   claude mcp add --transport http qiepulse https://<host>/api/mcp --header "Authorization: Bearer qh_live_…"
 */

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_WAIT_SEC = 90;

type Json = Record<string, unknown>;
type Tool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Json;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  run: (args: Json, user: UserRow, s: Services) => Promise<unknown> | unknown;
};

const str = (description: string, extra: Json = {}) => ({ type: "string", description, ...extra });
const num = (description: string, extra: Json = {}) => ({ type: "number", description, ...extra });
const obj = (properties: Json, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });

function eventsFor(s: Services, userId: string, hookId: string, opts: { after?: number; limit?: number }) {
  s.hooks.get(userId, hookId); // ownership check
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 20) || 20, 1), 100);
  const rows = s.db
    .prepare("SELECT payload, created_at FROM events WHERE hook_id = ? AND created_at > ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
    .all(hookId, opts.after ?? 0, limit) as { payload: string; created_at: number }[];
  return rows.map((r) => ({ receivedAt: r.created_at, ...(JSON.parse(r.payload) as EventPayload) }));
}

const TOOLS: Tool[] = [
  {
    name: "resolve_qie_name",
    title: "Resolve a QIE ID",
    description: "Look up the wallet address a .qie name (QIE ID) points to, or the .qie name of an address.",
    inputSchema: obj({ name_or_address: str("A name like shop.qie, or a 0x address for a reverse lookup") }, ["name_or_address"]),
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: async (a, _u, s) => {
      const v = String(a.name_or_address ?? "").trim();
      if (/^0x[0-9a-fA-F]{40}$/.test(v)) return { address: v, name: await s.names.reverse(v) };
      const name = normalizeQieName(v);
      if (!name) throw new HttpError(400, "Give a name.qie or a 0x address");
      return { name, address: await s.names.resolve(name) };
    },
  },
  {
    name: "create_payment_link",
    title: "Create a payment link",
    description:
      "Create a hosted checkout link for an exact amount of QUSDC (stablecoin, default), QIE or WQIE on QIE Blockchain. Give the returned url to the payer. " +
      "Funds go straight to the recipient wallet. Use wait_for_payment or get_payment_link to know when it is paid. The amount may get a few extra millionths so the payment can be identified; tell the payer to pay the exact `amount.formatted`.",
    inputSchema: obj(
      {
        amount: str("Amount, e.g. \"25\" or \"9.99\" (up to 6 decimals)"),
        token: str("QUSDC (default), QIE or WQIE", { enum: ["QUSDC", "QIE", "WQIE"] }),
        description: str("What the payment is for; shown to the payer"),
        recipient: str("name.qie or 0x address to receive the funds. Defaults to the account's own wallet"),
        expires_in_minutes: num("Minutes until the link expires (5–43200, default 60)"),
        metadata: { type: "object", description: "Your own data (e.g. order id), returned with the paid event" },
      },
      ["amount"],
    ),
    annotations: { openWorldHint: false },
    run: (a, u, s) =>
      s.invoices.create(u, {
        amount: a.amount,
        token: a.token,
        description: a.description,
        recipient: a.recipient,
        expiresInMinutes: a.expires_in_minutes,
        metadata: a.metadata,
      }),
  },
  {
    name: "get_payment_link",
    title: "Check a payment link",
    description: "Status of a payment link: open, paid (with the transaction and payer), expired or cancelled.",
    inputSchema: obj({ id: str("Payment link id, e.g. inv_…") }, ["id"]),
    annotations: { readOnlyHint: true },
    run: (a, u, s) => s.invoices.get(u.id, String(a.id ?? "")),
  },
  {
    name: "wait_for_payment",
    title: "Wait for a payment link to be paid",
    description: `Block until a payment link is paid, expires or the timeout passes (max ${MAX_WAIT_SEC} s; call again to keep waiting). QIE confirms payments in seconds.`,
    inputSchema: obj({ id: str("Payment link id"), timeout_seconds: num(`How long to wait, 1–${MAX_WAIT_SEC} (default 60)`) }, ["id"]),
    annotations: { readOnlyHint: true },
    run: async (a, u, s) => {
      const id = String(a.id ?? "");
      const until = Date.now() + Math.min(Math.max(Number(a.timeout_seconds ?? 60) || 60, 1), MAX_WAIT_SEC) * 1000;
      for (;;) {
        const inv = s.invoices.get(u.id, id);
        if (inv.status !== "open" || Date.now() >= until) return { ...inv, waitedUntil: inv.status === "open" ? "timeout" : inv.status };
        await sleep(1000);
      }
    },
  },
  {
    name: "list_payment_links",
    title: "List payment links",
    description: "The account's most recent payment links, optionally filtered by status.",
    inputSchema: obj({ status: str("open, paid, expired or cancelled", { enum: ["open", "paid", "expired", "cancelled"] }), limit: num("Max results (default 20)") }),
    annotations: { readOnlyHint: true },
    run: (a, u, s) => s.invoices.list(u.id, { status: a.status as string | undefined, limit: Number(a.limit ?? 20) }),
  },
  {
    name: "create_alert",
    title: "Create an alert (hook)",
    description:
      "Watch QIE Blockchain and deliver events to a webhook URL, a linked Telegram chat or a Discord webhook. Trigger types and their config:\n" +
      "- payment: {recipient: name.qie|0x, assets?: [\"QIE\",\"QUSDC\"], minAmount?: \"1\"}\n" +
      "- token_transfer: {token: QUSDC|WQIE|0x, from?, to?, minAmount?}\n" +
      "- swap: {pair: 0x QIEDEX pair, minValueUsd?}\n" +
      "- contract_event: {address?: 0x, events: [\"event Transfer(address indexed from, address indexed to, uint256 value)\"], filters?: {argName: value}}\n" +
      "- wallet: {address: name.qie|0x, direction?: in|out|both, includeFailed?: true}\n" +
      "- balance: {address, asset: QIE|QUSDC|0x, below?: \"5\" | above?: \"5\"}\n" +
      "- price: {token: WQIE|0x, below?: 0.1 | above?: 0.2}\n" +
      "- name_watch: {name: shop.qie}\n" +
      "- invoice: {} (any of the account's payment links is paid)\n" +
      "Channels: {type: \"webhook\", config: {url}} | {type: \"discord\", config: {url}} | {type: \"telegram\", config: {chatRef}} (chatRef from list_telegram_chats). " +
      "If the agent has no endpoint, use a webhook anyway or poll with get_events.",
    inputSchema: obj(
      {
        name: str("Short name for the alert"),
        trigger: obj({ type: str("Trigger type"), config: { type: "object", description: "Trigger config, see the tool description" } }, ["type"]),
        channel: obj({ type: str("webhook, telegram or discord"), config: { type: "object" } }, ["type", "config"]),
      },
      ["name", "trigger", "channel"],
    ),
    run: (a, u, s) => s.hooks.create(u, a as never),
  },
  {
    name: "list_alerts",
    title: "List alerts",
    description: "The account's hooks with their trigger, channel, active state and delivery counts.",
    inputSchema: obj({}),
    annotations: { readOnlyHint: true },
    run: (_a, u, s) =>
      s.hooks.list(u.id).map((h) => ({ id: h.id, name: h.name, active: h.active, trigger: h.trigger, channel: h.channel.type, fireCount: h.fireCount, lastFiredAt: h.lastFiredAt, stats: h.stats })),
  },
  {
    name: "set_alert_active",
    title: "Pause or resume an alert",
    description: "Pause (active=false) or resume (active=true) a hook.",
    inputSchema: obj({ id: str("Hook id"), active: { type: "boolean" } }, ["id", "active"]),
    annotations: { idempotentHint: true },
    run: (a, u, s) => s.hooks.update(u.id, String(a.id ?? ""), { active: Boolean(a.active) } as never),
  },
  {
    name: "delete_alert",
    title: "Delete an alert",
    description: "Delete a hook and its event history.",
    inputSchema: obj({ id: str("Hook id") }, ["id"]),
    annotations: { destructiveHint: true, idempotentHint: true },
    run: (a, u, s) => {
      s.hooks.remove(u.id, String(a.id ?? ""));
      return { deleted: a.id };
    },
  },
  {
    name: "get_events",
    title: "Get recent events of an alert",
    description: "Recent decoded events of a hook, newest first (payments, transfers, swaps, contract events…). Pass `after` (unix seconds) to get only newer ones.",
    inputSchema: obj({ hook_id: str("Hook id"), after: num("Only events received after this unix time"), limit: num("Max events (default 20, max 100)") }, ["hook_id"]),
    annotations: { readOnlyHint: true },
    run: (a, u, s) => eventsFor(s, u.id, String(a.hook_id ?? ""), { after: Number(a.after ?? 0), limit: Number(a.limit ?? 20) }),
  },
  {
    name: "wait_for_event",
    title: "Wait for the next event of an alert",
    description: `Block until a hook records a new event or the timeout passes (max ${MAX_WAIT_SEC} s). Use it to wait for a deposit, an escrow being funded, a contract call…`,
    inputSchema: obj({ hook_id: str("Hook id"), timeout_seconds: num(`1–${MAX_WAIT_SEC} (default 60)`) }, ["hook_id"]),
    annotations: { readOnlyHint: true },
    run: async (a, u, s) => {
      const hookId = String(a.hook_id ?? "");
      const since = nowSec() - 1;
      const until = Date.now() + Math.min(Math.max(Number(a.timeout_seconds ?? 60) || 60, 1), MAX_WAIT_SEC) * 1000;
      for (;;) {
        const ev = eventsFor(s, u.id, hookId, { after: since, limit: 10 });
        if (ev.length) return { events: ev.reverse() };
        if (Date.now() >= until) return { events: [], timedOut: true };
        await sleep(1000);
      }
    },
  },
  {
    name: "list_telegram_chats",
    title: "List linked Telegram chats",
    description: "Telegram chats linked to the account (use their id as chatRef in create_alert). Link new chats from the dashboard.",
    inputSchema: obj({}),
    annotations: { readOnlyHint: true },
    run: (_a, u, s) => s.db.prepare("SELECT id, title, chat_type AS chatType FROM telegram_chats WHERE user_id = ?").all(u.id),
  },
  {
    name: "get_traction",
    title: "On-chain traction of a project",
    description: "Live usage of a project that has a QIE Pulse traction page: transactions, distinct wallets, returning wallets, 30-day series. Without a slug, returns the leaderboard.",
    inputSchema: obj({ slug: str("Traction page slug, e.g. qiedex. Omit for the leaderboard") }),
    annotations: { readOnlyHint: true },
    run: (a, _u, s) => {
      if (!a.slug) return s.projects.leaderboard(50);
      const p = s.projects.bySlug(String(a.slug));
      if (!p) throw new HttpError(404, "No traction page with that slug");
      const st = s.projects.stats(p.id);
      return { name: p.name, contracts: JSON.parse(p.contracts), verifiedBy: p.verified_by, ...st, series: st.series.slice(-14) };
    },
  },
  {
    name: "network_status",
    title: "QIE network status",
    description: "Health of the public QIE RPC nodes and how far the QIE Pulse indexer is behind the chain head.",
    inputSchema: obj({}),
    annotations: { readOnlyHint: true },
    run: (_a, _u, s) => ({
      chainId: s.cfg.chainId,
      network: s.cfg.network,
      indexer: { head: s.indexer.status.head, cursor: s.indexer.status.cursor, lagBlocks: s.indexer.status.lagBlocks },
      rpc: s.rpc.endpoints.map((e) => ({ url: e.url, healthy: e.healthy, latencyMs: e.latencyMs, lastBlock: e.lastBlock })),
    }),
  },
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));

type RpcReq = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Json };

async function handle(s: Services, user: UserRow, m: RpcReq): Promise<Json | null> {
  const isNotification = m.id === undefined || m.id === null;
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id: m.id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: m.id ?? null, error: { code, message } });
  if (m.jsonrpc !== "2.0" || typeof m.method !== "string") return fail(-32600, "Invalid request");
  if (isNotification) return null; // notifications/initialized, notifications/cancelled…

  switch (m.method) {
    case "initialize": {
      const asked = String(m.params?.protocolVersion ?? "");
      return ok({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "qiepulse", title: "QIE Pulse", version: "1.0.0" },
        instructions:
          "QIE Pulse watches QIE Blockchain (EVM, chain 1990, 1–2 s finality). Use payment links to get paid in QUSDC/QIE and wait_for_payment to know when the money arrived. " +
          "Use create_alert + wait_for_event / get_events to react to on-chain activity. Names ending in .qie are QIE IDs and can be used wherever an address is accepted.",
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS.map(({ run: _r, ...t }) => t) });
    case "tools/call": {
      const tool = byName.get(String(m.params?.name ?? ""));
      if (!tool) return fail(-32602, `Unknown tool ${String(m.params?.name)}`);
      try {
        const out = await tool.run((m.params?.arguments as Json) ?? {}, user, s);
        return ok({ content: [{ type: "text", text: JSON.stringify(out, null, 2) }], isError: false });
      } catch (e) {
        // Tool errors go back to the model so it can correct itself.
        return ok({ content: [{ type: "text", text: e instanceof HttpError ? e.message : `Error: ${errMsg(e)}` }], isError: true });
      }
    }
    case "resources/list":
      return ok({ resources: [] });
    case "prompts/list":
      return ok({ prompts: [] });
    default:
      return fail(-32601, `Method not found: ${m.method}`);
  }
}

export function createMcp(s: Services): Hono {
  const app = new Hono();
  app.get("/", (c) => c.json({ error: "This MCP server answers POST requests (Streamable HTTP, JSON responses)." }, 405, { allow: "POST" }));
  app.delete("/", (c) => c.body(null, 405));
  app.post("/", async (c) => {
    const key = c.req.header("authorization")?.match(/^Bearer\s+(qh_\S+)$/)?.[1];
    const user = key ? s.auth.userForApiKey(key) : null;
    if (!user) {
      c.header("www-authenticate", 'Bearer realm="qiepulse", error="invalid_token"');
      return c.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Send Authorization: Bearer qh_live_… (create an API key in the QIE Pulse dashboard)" } }, 401);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
    }
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => handle(s, user, m as RpcReq)))).filter(Boolean);
      return out.length ? c.json(out) : c.body(null, 202);
    }
    const out = await handle(s, user, body as RpcReq);
    return out ? c.json(out) : c.body(null, 202);
  });
  return app;
}
