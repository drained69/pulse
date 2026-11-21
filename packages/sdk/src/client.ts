import type { Channel, Hook, HookEvent, HookInput, Invoice, InvoiceInput, TractionStats, Trigger } from "./types.ts";

export class QPulseError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "QPulseError";
    this.status = status;
  }
}

/** The hosted Q-Pulse server on QIE mainnet. */
export const DEFAULT_BASE_URL = "https://qpulse-production.up.railway.app";

export type ClientOptions = {
  /** API key from the dashboard (Settings → API keys), starts with `qp_live_`. */
  apiKey: string;
  /** Your Q-Pulse server. Defaults to the hosted one. */
  baseUrl?: string;
  fetch?: typeof fetch;
};

/**
 * Q-Pulse API client.
 *
 * ```ts
 * const qp = new QPulse({ apiKey: process.env.QPULSE_KEY! }); // or baseUrl: "https://your-own-server"
 * const hook = await qp.onPayment("shop.qie", { url: "https://shop.example.com/qie-webhook" });
 * ```
 */
export class QPulse {
  private apiKey: string;
  private baseUrl: string;
  private f: typeof fetch;

  constructor(opts: ClientOptions) {
    if (!opts.apiKey?.startsWith("qp_")) throw new Error("apiKey must be a Q-Pulse API key (qp_live_…)");
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.f = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.f(`${this.baseUrl}/api${path}`, {
      method,
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new QPulseError(res.status, json.error ?? `HTTP ${res.status}`);
    return json;
  }

  readonly hooks = {
    list: async (): Promise<Hook[]> => (await this.req<{ hooks: Hook[] }>("GET", "/hooks")).hooks,
    get: async (id: string): Promise<Hook> => (await this.req<{ hook: Hook }>("GET", `/hooks/${id}`)).hook,
    create: async (input: HookInput): Promise<Hook> => (await this.req<{ hook: Hook }>("POST", "/hooks", input)).hook,
    update: async (id: string, input: Partial<HookInput>): Promise<Hook> => (await this.req<{ hook: Hook }>("PATCH", `/hooks/${id}`, input)).hook,
    pause: async (id: string): Promise<Hook> => (await this.req<{ hook: Hook }>("PATCH", `/hooks/${id}`, { active: false })).hook,
    resume: async (id: string): Promise<Hook> => (await this.req<{ hook: Hook }>("PATCH", `/hooks/${id}`, { active: true })).hook,
    delete: async (id: string): Promise<void> => {
      await this.req("DELETE", `/hooks/${id}`);
    },
    rotateSecret: async (id: string): Promise<Hook> => (await this.req<{ hook: Hook }>("POST", `/hooks/${id}/rotate-secret`)).hook,
    test: async (id: string): Promise<{ ok: boolean; code: number | null; error: string | null }> =>
      (await this.req<{ result: { ok: boolean; code: number | null; error: string | null } }>("POST", `/hooks/${id}/test`)).result,
    events: async (id: string, limit = 50): Promise<HookEvent[]> => (await this.req<{ events: HookEvent[] }>("GET", `/hooks/${id}/events?limit=${limit}`)).events,
  };

  readonly events = {
    replay: async (eventId: string): Promise<{ deliveryId: string }> => this.req("POST", `/events/${eventId}/replay`),
  };

  /** Payment links: hosted checkout for an exact amount of QUSDC, QIE or WQIE. */
  readonly invoices = {
    create: async (input: InvoiceInput): Promise<Invoice> => (await this.req<{ invoice: Invoice }>("POST", "/invoices", input)).invoice,
    get: async (id: string): Promise<Invoice> => (await this.req<{ invoice: Invoice }>("GET", `/invoices/${id}`)).invoice,
    list: async (opts: { status?: Invoice["status"]; limit?: number } = {}): Promise<Invoice[]> => {
      const q = new URLSearchParams();
      if (opts.status) q.set("status", opts.status);
      if (opts.limit) q.set("limit", String(opts.limit));
      return (await this.req<{ invoices: Invoice[] }>("GET", `/invoices?${q}`)).invoices;
    },
    cancel: async (id: string): Promise<Invoice> => (await this.req<{ invoice: Invoice }>("POST", `/invoices/${id}/cancel`)).invoice,
    /** Poll until the link is paid, expired or cancelled (or `timeoutMs` passes). QIE confirms in seconds. */
    waitForPayment: async (id: string, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<Invoice> => {
      const until = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
      for (;;) {
        const inv = await this.invoices.get(id);
        if (inv.status !== "open" || Date.now() >= until) return inv;
        await new Promise((r) => setTimeout(r, opts.intervalMs ?? 2000));
      }
    },
  };

  /** Public traction pages (no API key needed for these, but the client sends it anyway). */
  readonly traction = {
    get: async (slug: string): Promise<{ project: { slug: string; name: string; contracts: string[]; verifiedBy: string | null }; stats: TractionStats }> =>
      this.req("GET", `/projects/${encodeURIComponent(slug)}`),
    leaderboard: async (): Promise<{ rank: number; slug: string; name: string; wallets7d: number; txs7d: number; wallets: number; txs: number }[]> =>
      (await this.req<{ projects: never[] }>("GET", "/projects")).projects,
  };

  /** Resolve a QIE ID like `shop.qie` to its address. */
  async resolve(name: string): Promise<string | null> {
    return (await this.req<{ address: string | null }>("GET", `/resolve?name=${encodeURIComponent(name)}`)).address;
  }

  /** Shortcut: get notified when `recipient` (a name.qie or address) is paid in QIE or QUSDC. */
  async onPayment(
    recipient: string,
    destination: { url: string } | { discordUrl: string } | { telegramChatRef: string },
    opts: { name?: string; assets?: string[]; minAmount?: string } = {},
  ): Promise<Hook> {
    const channel: Channel =
      "url" in destination
        ? { type: "webhook", config: { url: destination.url } }
        : "discordUrl" in destination
          ? { type: "discord", config: { url: destination.discordUrl } }
          : { type: "telegram", config: { chatRef: destination.telegramChatRef } };
    const trigger: Trigger = { type: "payment", config: { recipient, assets: opts.assets, minAmount: opts.minAmount } };
    return this.hooks.create({ name: opts.name ?? `Payments to ${recipient}`, trigger, channel });
  }

  /** Shortcut: everything in and out of a wallet or contract, failed transactions included. */
  async watchWallet(address: string, destination: { url: string }, opts: { name?: string; direction?: "in" | "out" | "both" } = {}): Promise<Hook> {
    return this.hooks.create({
      name: opts.name ?? `Activity of ${address}`,
      trigger: { type: "wallet", config: { address, direction: opts.direction } },
      channel: { type: "webhook", config: { url: destination.url } },
    });
  }
}
