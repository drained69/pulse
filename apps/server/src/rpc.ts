import { errMsg, log } from "./util.ts";

export type EndpointHealth = {
  url: string;
  healthy: boolean;
  latencyMs: number | null;
  lastBlock: number | null;
  errors: number;
  lastError: string | null;
  lastCheckedAt: number | null;
};

type JsonRpcResponse = { id: number; result?: unknown; error?: { code: number; message: string } };

export class RpcError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * JSON-RPC client over several QIE endpoints. Requests go to the healthiest,
 * fastest endpoint and fail over to the next one on error or timeout.
 * QIE's public RPCs answer batch requests and reject eth_subscribe, so we poll.
 */
export class RpcPool {
  readonly endpoints: EndpointHealth[];
  private nextId = 1;
  private timeoutMs: number;
  private probeTimer: NodeJS.Timeout | null = null;

  constructor(urls: string[], opts: { timeoutMs?: number } = {}) {
    this.endpoints = urls.map((url) => ({
      url,
      healthy: true,
      latencyMs: null,
      lastBlock: null,
      errors: 0,
      lastError: null,
      lastCheckedAt: null,
    }));
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  /** Healthy endpoints first, then by latency. Unhealthy ones stay as a last resort. */
  private ordered(): EndpointHealth[] {
    return [...this.endpoints].sort((a, b) => {
      if (a.healthy !== b.healthy) return a.healthy ? -1 : 1;
      return (a.latencyMs ?? 1e9) - (b.latencyMs ?? 1e9);
    });
  }

  private async post(ep: EndpointHealth, body: unknown): Promise<unknown> {
    const started = performance.now();
    const res = await fetch(ep.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const ms = Math.round(performance.now() - started);
    ep.latencyMs = ep.latencyMs === null ? ms : Math.round(ep.latencyMs * 0.7 + ms * 0.3);
    return json;
  }

  private markFailure(ep: EndpointHealth, e: unknown): void {
    ep.errors++;
    ep.lastError = errMsg(e);
    ep.healthy = false;
    log.warn("rpc endpoint failed", { url: ep.url, error: ep.lastError });
  }

  async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    let lastErr: unknown = null;
    for (const ep of this.ordered()) {
      try {
        const json = (await this.post(ep, { jsonrpc: "2.0", id: this.nextId++, method, params })) as JsonRpcResponse;
        if (json.error) {
          // A JSON-RPC error is an answer, not an outage: do not fail over (the next node would say the same).
          throw new RpcError(json.error.code, json.error.message);
        }
        return json.result as T;
      } catch (e) {
        if (e instanceof RpcError) throw e;
        this.markFailure(ep, e);
        lastErr = e;
      }
    }
    throw new Error(`All RPC endpoints failed for ${method}: ${errMsg(lastErr)}`);
  }

  /**
   * Batch call. Results are returned in request order. Any per-item error throws.
   * `meta.url` is set to the endpoint that answered the last chunk, so a caller that finds the
   * answer incomplete (a node that is behind) can `demote` that node and retry elsewhere.
   */
  async batch<T = unknown>(calls: { method: string; params: unknown[] }[], chunk = 50, meta?: { url?: string }): Promise<T[]> {
    const out: T[] = [];
    for (let i = 0; i < calls.length; i += chunk) {
      const part = calls.slice(i, i + chunk);
      out.push(...(await this.batchOnce<T>(part, meta)));
    }
    return out;
  }

  /**
   * Take a node out of rotation until the next health probe (every 15 s) sees it answer again.
   * Used when a node answers but its data is incomplete (e.g. it has a block but not its logs yet).
   */
  demote(url: string | undefined, reason: string): void {
    const ep = this.endpoints.find((e) => e.url === url);
    if (!ep || this.endpoints.filter((e) => e.healthy).length <= 1) return; // never empty the pool
    ep.healthy = false;
    ep.lastError = reason;
    log.warn("rpc endpoint demoted", { url: ep.url, reason });
  }

  private async batchOnce<T>(calls: { method: string; params: unknown[] }[], meta?: { url?: string }): Promise<T[]> {
    if (calls.length === 0) return [];
    let lastErr: unknown = null;
    for (const ep of this.ordered()) {
      try {
        const base = this.nextId;
        this.nextId += calls.length;
        const body = calls.map((c, i) => ({ jsonrpc: "2.0", id: base + i, method: c.method, params: c.params }));
        const json = (await this.post(ep, body)) as JsonRpcResponse[];
        if (!Array.isArray(json)) throw new Error("batch not supported");
        if (meta) meta.url = ep.url;
        const byId = new Map(json.map((r) => [r.id, r]));
        return calls.map((c, i) => {
          const r = byId.get(base + i);
          if (!r) throw new Error(`missing batch response for ${c.method}`);
          if (r.error) throw new RpcError(r.error.code, r.error.message);
          return r.result as T;
        });
      } catch (e) {
        if (e instanceof RpcError) throw e;
        this.markFailure(ep, e);
        lastErr = e;
      }
    }
    throw new Error(`All RPC endpoints failed for batch: ${errMsg(lastErr)}`);
  }

  /** Check every endpoint's head block and latency. Endpoints more than `maxLag` blocks behind are unhealthy. */
  async probe(maxLag = 5): Promise<void> {
    await Promise.all(
      this.endpoints.map(async (ep) => {
        try {
          const json = (await this.post(ep, { jsonrpc: "2.0", id: this.nextId++, method: "eth_blockNumber", params: [] })) as JsonRpcResponse;
          if (json.error || typeof json.result !== "string") throw new Error(json.error?.message ?? "bad response");
          ep.lastBlock = Number.parseInt(json.result, 16);
          ep.lastError = null;
          ep.healthy = true;
        } catch (e) {
          ep.errors++;
          ep.lastError = errMsg(e);
          ep.healthy = false;
        } finally {
          ep.lastCheckedAt = Date.now();
        }
      }),
    );
    const best = Math.max(...this.endpoints.map((e) => e.lastBlock ?? 0));
    for (const ep of this.endpoints) {
      if (ep.healthy && ep.lastBlock !== null && best - ep.lastBlock > maxLag) {
        ep.healthy = false;
        ep.lastError = `lagging ${best - ep.lastBlock} blocks behind`;
      }
    }
  }

  startProbing(intervalMs = 15_000): void {
    void this.probe();
    this.probeTimer = setInterval(() => void this.probe(), intervalMs);
    this.probeTimer.unref();
  }

  stop(): void {
    if (this.probeTimer) clearInterval(this.probeTimer);
  }
}
