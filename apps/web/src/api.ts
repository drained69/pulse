export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (json as { error?: string }).error ?? `HTTP ${res.status}`);
  return json as T;
}

export type AppConfig = {
  chainId: number;
  network: string;
  explorerUrl: string;
  rpcUrl: string;
  qusdc: `0x${string}`;
  oracleFeeds: string[];
  dexRouter: string;
  billingContract: `0x${string}` | null;
  proPriceQusdc: string;
  proPeriodDays: number;
  plans: Record<"free" | "pro", { id: string; label: string; maxHooks: number; monthlyEvents: number }>;
  telegram: { enabled: boolean; botUsername: string | null };
};

export type Me = {
  user: { id: string; address: string; qieName: string | null; createdAt: number };
  plan: { id: "free" | "pro"; label: string; maxHooks: number; monthlyEvents: number; expiresAt: number | null };
  usage: { hooks: number; eventsThisMonth: number };
};

export type Hook = {
  id: string;
  name: string;
  active: boolean;
  trigger: { type: "payment" | "token_transfer" | "swap" | "contract_event" | "wallet" | "balance" | "price" | "oracle_price" | "name_watch" | "daily_digest"; config: Record<string, any>; resolved: Record<string, string> };
  channel: { type: "webhook" | "telegram" | "discord"; config: Record<string, any> };
  secret: string;
  fireCount: number;
  lastFiredAt: number | null;
  createdAt: number;
  stats?: { success: number; failed: number; pending: number };
};

export type Delivery = {
  id: string;
  status: "pending" | "success" | "failed" | "skipped";
  attempts: number;
  responseCode: number | null;
  error: string | null;
  latencyMs: number | null;
  deliveredAt: number | null;
  nextAttemptAt: number;
};

export type HookEvent = { id: string; type: string; createdAt: number; payload: any; delivery: Delivery | null };
export type TgChat = { id: string; title: string; chatType: string; createdAt: number };
export type Pair = { address: string; token0: { symbol: string; address: string }; token1: { symbol: string; address: string }; liquidityUsd: number | null };

export type OraclePrice = { feed: string; address: string; price: number | null; decimals: number; roundId: string | null; updatedAt: number | null; stale: boolean };

export type Status = {
  oracles: OraclePrice[];
  chainId: number;
  network: string;
  indexer: { head: number | null; cursor: number | null; lagBlocks: number | null; lastTickAt: number | null; lastError: string | null; eventsMatched: number; blocksProcessed: number; uptimeSec: number };
  rpc: { url: string; healthy: boolean; latencyMs: number | null; lastBlock: number | null; lastError: string | null; lastCheckedAt: number | null }[];
  deliveries24h: { success?: number; failed?: number; pending?: number; skipped?: number; successRate: number | null; avgLatencyMs: number | null };
  totals: { hooks: number; users: number; events: number };
  telegram: boolean;
  latency: Record<"stream" | "detect" | "deliver", LatencyStats>;
  stream: { subscribers: number; connections: number; filters: number; head: number | null; lastBlock: number | null; blocksStreamed: number; notifications: number; lastError: string | null };
};

export type LatencyStats = { count: number; p50: number | null; p95: number | null; p99: number | null; max: number | null };
