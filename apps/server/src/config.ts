import { dirname, join } from "node:path";
import { getAddress, isAddress } from "viem";

function list(v: string | undefined, fallback: string[]): string[] {
  if (!v) return fallback;
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

function int(v: string | undefined, fallback: number): number {
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Invalid number in env: ${v}`);
  return n;
}

function bool(v: string | undefined, fallback = false): boolean {
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function optAddress(v: string | undefined, name: string): `0x${string}` | null {
  if (!v) return null;
  if (!isAddress(v)) throw new Error(`${name} is not a valid address: ${v}`);
  return getAddress(v);
}

function optKey(v: string | undefined): `0x${string}` | null {
  if (!v) return null;
  const k = v.startsWith("0x") ? v : `0x${v}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error("ATTESTER_PRIVATE_KEY must be 32 bytes of hex");
  return k as `0x${string}`;
}

export type Plan = {
  id: "free" | "pro";
  label: string;
  maxHooks: number;
  monthlyEvents: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const network = (env.QIE_NETWORK ?? "mainnet") as "mainnet" | "testnet";
  const defaultRpcs =
    network === "mainnet"
      ? [1, 2, 3, 4, 5].map((i) => `https://rpc${i}mainnet.qie.digital`)
      : [1, 2, 3, 4, 5].map((i) => `https://rpc${i}testnet.qie.digital`);

  const cfg = {
    network,
    chainId: int(env.CHAIN_ID, network === "mainnet" ? 1990 : 1983),
    rpcUrls: list(env.RPC_URLS, defaultRpcs),
    explorerUrl: env.EXPLORER_URL ?? (network === "mainnet" ? "https://mainnet.qie.digital" : "https://testnet.qie.digital"),
    mcpUrl: env.QIE_MCP_URL ?? "https://mcp.qie.digital/mcp",
    dexApiUrl: env.QIEDEX_API_URL ?? "https://api.dex.qie.digital",

    port: int(env.PORT, 8787),
    publicUrl: (env.PUBLIC_URL ?? "http://localhost:8787").replace(/\/$/, ""),
    dbPath: env.DB_PATH ?? "./qpulse.db",
    /** Daily database snapshots (VACUUM INTO). Empty = off. Defaults to backups/ next to the database. */
    backupDir: env.BACKUP_DIR ?? ((env.DB_PATH ?? "./qpulse.db") === ":memory:" ? "" : join(dirname(env.DB_PATH ?? "./qpulse.db"), "backups")),
    backupKeep: int(env.BACKUP_KEEP, 7),
    webDist: env.WEB_DIST ?? new URL("../../web/dist", import.meta.url).pathname,

    /**
     * Blocks to wait after the head before processing. QIE uses CometBFT (instant finality: no
     * reorgs), and the indexer proves the answering node has the whole range, so 0 is safe.
     */
    confirmations: int(env.CONFIRMATIONS, 0),
    /** Where the indexer starts on a fresh database. "latest" or a block number. */
    startBlock: env.START_BLOCK ?? "latest",
    /** Blocks per indexer request: every header plus all logs of the range, in one batch to one node (QIE nodes take ~0.1-0.3 s per header). */
    maxBlocksPerBatch: int(env.MAX_BLOCKS_PER_BATCH, 25),
    pollIntervalMs: int(env.POLL_INTERVAL_MS, 1500),
    /** How often scheduled triggers (balance, price, name watch, daily summary) are evaluated. */
    checkIntervalMs: int(env.CHECK_INTERVAL_MS, 60_000),
    /** Events (and their delivery log) older than this are deleted. */
    eventRetentionDays: int(env.EVENT_RETENTION_DAYS, 30),

    deliveryConcurrency: int(env.DELIVERY_CONCURRENCY, 8),
    deliveryTimeoutMs: int(env.DELIVERY_TIMEOUT_MS, 10_000),
    /** Allow webhooks to localhost / private IPs. Only for local development and tests. */
    allowPrivateWebhooks: bool(env.ALLOW_PRIVATE_WEBHOOKS, false),

    telegramBotToken: env.TELEGRAM_BOT_TOKEN ?? "",
    telegramBotUsername: env.TELEGRAM_BOT_USERNAME ?? "",
    telegramApiBase: env.TELEGRAM_API_BASE ?? "https://api.telegram.org",

    /** Optional public alert feed: posts every QUSDC transfer >= threshold to this Telegram chat. */
    publicAlertsChatId: env.PUBLIC_ALERTS_CHAT_ID ?? "",
    publicAlertsMinQusdc: env.PUBLIC_ALERTS_MIN_QUSDC ?? "1000",

    billingContract: optAddress(env.BILLING_CONTRACT, "BILLING_CONTRACT"),
    /** PulseAttestations contract. With ATTESTER_PRIVATE_KEY, daily traction roots are posted to it. */
    attestationContract: optAddress(env.ATTESTATION_CONTRACT, "ATTESTATION_CONTRACT"),
    /** Key of the attester address set in the contract. Only needs a little QIE for gas; never holds funds. */
    attesterKey: optKey(env.ATTESTER_PRIVATE_KEY),
    attestIntervalMs: int(env.ATTEST_INTERVAL_MS, 10 * 60_000),
    billingStartBlock: env.BILLING_START_BLOCK ?? "",
    proPriceQusdc: env.PRO_PRICE_QUSDC ?? "9",
    proPeriodDays: int(env.PRO_PERIOD_DAYS, 30),

    plans: {
      free: { id: "free", label: "Free", maxHooks: int(env.FREE_MAX_HOOKS, 10), monthlyEvents: int(env.FREE_MONTHLY_EVENTS, 5000) },
      pro: { id: "pro", label: "Pro", maxHooks: int(env.PRO_MAX_HOOKS, 100), monthlyEvents: int(env.PRO_MONTHLY_EVENTS, 200_000) },
    } satisfies Record<string, Plan>,

    /** Blockscout API used to backfill a new project's history and find contract deployers. */
    explorerApiUrl: env.EXPLORER_API_URL ?? env.EXPLORER_URL ?? (network === "mainnet" ? "https://mainnet.qie.digital" : "https://testnet.qie.digital"),
    backfillDays: int(env.BACKFILL_DAYS, 90),
    backfillMaxTxs: int(env.BACKFILL_MAX_TXS, 5000),
    maxProjects: int(env.MAX_PROJECTS_PER_USER, 10),

    sessionDays: int(env.SESSION_DAYS, 14),
    /**
     * Header your reverse proxy sets to the real client IP (used for rate limits). Only set
     * this behind a proxy that overwrites it; otherwise clients could spoof it. On Fly.io it
     * defaults to `fly-client-ip`, on Railway to `x-real-ip`. Empty = use the TCP peer address.
     */
    clientIpHeader: (env.CLIENT_IP_HEADER ?? (env.FLY_APP_NAME ? "fly-client-ip" : env.RAILWAY_PROJECT_ID ? "x-real-ip" : "")).toLowerCase(),
    secureCookies: bool(env.SECURE_COOKIES, (env.PUBLIC_URL ?? "").startsWith("https://")),
    disableIndexer: bool(env.DISABLE_INDEXER, false),
  };
  if (cfg.rpcUrls.length === 0) throw new Error("RPC_URLS must list at least one endpoint");
  return cfg;
}

export type Config = ReturnType<typeof loadConfig>;
