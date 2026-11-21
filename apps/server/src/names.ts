import { getAddress, isAddress } from "viem";
import { errMsg, log } from "./util.ts";

/**
 * QIE ID (`yourname.qie`) lookups through the official QIE Wallet MCP server
 * (mcp.qie.digital). The MCP reads the QIE ID record contracts on chain and
 * checks reverse records resolve back to the same address, so we never guess.
 */
export type NameResolver = {
  resolve(name: string): Promise<`0x${string}` | null>;
  reverse(address: string): Promise<string | null>;
};

export function normalizeQieName(input: string): string | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  const name = s.endsWith(".qie") ? s : `${s}.qie`;
  return /^[a-z0-9][a-z0-9-_]{0,62}\.qie$/.test(name) ? name : null;
}

export function looksLikeQieName(input: string): boolean {
  return input.trim().toLowerCase().endsWith(".qie");
}

/** The resolver answered with an error: retrying would get the same answer. */
class ResolverAnswerError extends Error {}

type CacheEntry<T> = { value: T; expires: number };

export class McpNameResolver implements NameResolver {
  private url: string;
  private network: "mainnet" | "testnet";
  private forward = new Map<string, CacheEntry<`0x${string}` | null>>();
  private back = new Map<string, CacheEntry<string | null>>();
  private ttlMs: number;
  private nextId = 1;

  constructor(url: string, network: "mainnet" | "testnet", ttlMs = 10 * 60_000) {
    this.url = url;
    this.network = network;
    this.ttlMs = ttlMs;
  }

  /** One retry after a short pause: the resolver sits behind a CDN and occasionally drops a connection. */
  private async callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      return await this.callToolOnce(name, args);
    } catch (e) {
      if (e instanceof ResolverAnswerError) throw e;
      await new Promise((r) => setTimeout(r, 750));
      return this.callToolOnce(name, args);
    }
  }

  private async callToolOnce(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method: "tools/call", params: { name, arguments: args } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`QIE MCP HTTP ${res.status}`);
    const text = await res.text();
    // Streamable HTTP answers either as plain JSON or as an SSE stream of `data:` lines.
    const payload = text.trimStart().startsWith("{")
      ? text
      : text
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .pop() ?? "";
    const json = JSON.parse(payload) as { result?: { structuredContent?: Record<string, unknown>; isError?: boolean }; error?: { message: string } };
    if (json.error) throw new ResolverAnswerError(json.error.message);
    const sc = json.result?.structuredContent;
    if (!sc) throw new Error("QIE MCP returned no structured content");
    return sc;
  }

  async resolve(input: string): Promise<`0x${string}` | null> {
    const name = normalizeQieName(input);
    if (!name) return null;
    const hit = this.forward.get(name);
    if (hit && hit.expires > Date.now()) return hit.value;
    try {
      const sc = await this.callTool("qie_resolve_name", { name, network: this.network });
      const addr = typeof sc.address === "string" && isAddress(sc.address) ? getAddress(sc.address) : null;
      this.forward.set(name, { value: addr, expires: Date.now() + this.ttlMs });
      return addr;
    } catch (e) {
      log.warn("qie name resolve failed", { name, error: errMsg(e) });
      if (hit) return hit.value; // serve stale on outage
      throw e;
    }
  }

  async reverse(address: string): Promise<string | null> {
    const key = address.toLowerCase();
    const hit = this.back.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;
    try {
      const sc = await this.callTool("qie_reverse_lookup", { address: getAddress(address), network: this.network });
      // The name is shown in alerts as the sender's identity: accept only a well-formed QIE ID.
      const name = typeof sc.name === "string" ? normalizeQieName(sc.name) : null;
      this.back.set(key, { value: name, expires: Date.now() + this.ttlMs });
      return name;
    } catch (e) {
      log.debug("qie reverse lookup failed", { address, error: errMsg(e) });
      this.back.set(key, { value: hit?.value ?? null, expires: Date.now() + 60_000 });
      return hit?.value ?? null;
    }
  }
}

/** In-memory resolver for tests. */
export class StaticNameResolver implements NameResolver {
  private names: Map<string, `0x${string}`>;
  constructor(entries: Record<string, string>) {
    this.names = new Map(Object.entries(entries).map(([n, a]) => [n.toLowerCase(), getAddress(a)]));
  }
  async resolve(input: string) {
    const name = normalizeQieName(input);
    return name ? (this.names.get(name) ?? null) : null;
  }
  async reverse(address: string) {
    for (const [n, a] of this.names) if (a.toLowerCase() === address.toLowerCase()) return n;
    return null;
  }
}
