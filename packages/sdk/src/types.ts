/** A wallet on QIE, with its QIE ID when it has one. */
export type Party = { address: string; name: string | null };

export type Amount = {
  /** Integer amount in the token's smallest unit, as a decimal string. */
  raw: string;
  /** Decimal amount, e.g. "25.5". */
  formatted: string;
  /** Human-readable amount with symbol, e.g. "25.5 QUSDC". */
  display: string;
  symbol: string;
  /** USD value from QIEDEX prices, when known. */
  valueUsd: number | null;
};

export type Token = {
  /** Contract address, or null for native QIE. */
  address: string | null;
  symbol: string;
  decimals: number;
  /** True for native QIE and official QIE tokens (QUSDC, WQIE, WETH). */
  official: boolean;
  /** Set when an unofficial token copies an official symbol. */
  warning?: string;
};

type Envelope<T extends string, D> = {
  id: string;
  type: T;
  createdAt: string;
  hook: { id: string; name: string };
  chain: { id: number; network: string };
  tx: { hash: string; blockNumber: number; logIndex: number | null; timestamp: number | null; explorerUrl: string };
  data: D;
};

export type PaymentReceivedEvent = Envelope<"payment.received", { from: Party; to: Party; token: Token; amount: Amount }>;
export type TokenTransferEvent = Envelope<"token.transfer", { from: Party; to: Party; token: Token; amount: Amount }>;
export type DexSwapEvent = Envelope<
  "dex.swap",
  { pair: string; trader: Party; sender: string; tokenIn: Token; tokenOut: Token; amountIn: Amount; amountOut: Amount; valueUsd: number | null }
>;
export type ContractEvent = Envelope<"contract.event", { contract: string; event: string; args: Record<string, unknown> }>;
export type WalletActivityEvent = Envelope<
  "wallet.activity",
  {
    kind: "native_transfer" | "token_transfer" | "contract_call" | "contract_deploy";
    direction: "in" | "out";
    status: "success" | "failed";
    wallet: Party;
    from: Party;
    to: Party | null;
    token: Token;
    amount: Amount;
    /** 4-byte selector of the called function, for contract calls. */
    method: string | null;
  }
>;

/** Scheduled events have no transaction: `tx` is null and `link` points somewhere useful. */
type Scheduled<T extends string, D> = Omit<Envelope<T, D>, "tx"> & { tx: null; link?: string };
export type BalanceThresholdEvent = Scheduled<
  "balance.threshold",
  { wallet: Party; symbol: string; direction: "below" | "above"; threshold: string; balance: Amount }
>;
export type PriceThresholdEvent = Scheduled<"price.threshold", { symbol: string; direction: "below" | "above"; threshold: number; priceUsd: number; source: "QIEDEX" }>;
export type NameChangedEvent = Scheduled<"name.changed", { name: string; from: string | null; to: string | null }>;
export type DailyDigestEvent = Scheduled<
  "digest.daily",
  {
    sourceHookId: string;
    sourceHookName: string;
    count: number;
    periodHours: 24;
    totals: { symbol: string; raw: string; formatted: string; display: string }[];
    top: { label: string; count: number }[];
  }
>;
export type TestEvent = Envelope<"test", Record<string, unknown>>;
/** A payment link was paid. `invoice.metadata` is what you passed when creating it (e.g. your order id). */
export type InvoicePaidEvent = Envelope<
  "invoice.paid",
  {
    invoice: { id: string; url: string; description: string; metadata: Record<string, unknown>; expiresAt: number; late: boolean };
    amount: Amount;
    token: { symbol: string; address: string | null; decimals: number };
    from: Party;
    to: Party;
  }
>;

export type QiePulseEvent =
  | PaymentReceivedEvent
  | TokenTransferEvent
  | DexSwapEvent
  | ContractEvent
  | WalletActivityEvent
  | BalanceThresholdEvent
  | PriceThresholdEvent
  | NameChangedEvent
  | DailyDigestEvent
  | InvoicePaidEvent
  | TestEvent;

// ───────── hook definitions ─────────

export type PaymentTrigger = {
  type: "payment";
  config: {
    /** `shop.qie` or a 0x address. */
    recipient: string;
    /** "QIE", "QUSDC", "WQIE" or token addresses. Default ["QIE", "QUSDC"]. */
    assets?: string[];
    /** Count any ERC-20 sent to the recipient. */
    anyToken?: boolean;
    /** Minimum amount in token units, e.g. "10". */
    minAmount?: string;
  };
};
export type TokenTransferTrigger = {
  type: "token_transfer";
  config: { token: string; from?: string; to?: string; minAmount?: string };
};
export type SwapTrigger = { type: "swap"; config: { pair: string; minValueUsd?: number } };
export type ContractEventTrigger = {
  type: "contract_event";
  /** Give `event`, `events` (up to 12), or both. */
  config: { address?: string; event?: string; events?: string[]; filters?: Record<string, string> };
};
export type WalletTrigger = {
  type: "wallet";
  config: { address: string; direction?: "in" | "out" | "both"; includeFailed?: boolean; includeTokens?: boolean };
};
/** Set exactly one of `below` / `above`. Amounts in token units, e.g. "5". */
export type BalanceTrigger = { type: "balance"; config: { address: string; asset?: string; below?: string; above?: string } };
/** Set exactly one of `below` / `above`, in USD. */
export type PriceTrigger = { type: "price"; config: { token: string; below?: number; above?: number } };
export type NameWatchTrigger = { type: "name_watch"; config: { name: string } };
export type DailyDigestTrigger = { type: "daily_digest"; config: { sourceHookId: string; hourUtc?: number } };
/** Fires `invoice.paid` when any of your payment links is paid. */
export type InvoiceTrigger = { type: "invoice"; config: Record<string, never> };
export type Trigger =
  | PaymentTrigger
  | TokenTransferTrigger
  | SwapTrigger
  | ContractEventTrigger
  | WalletTrigger
  | BalanceTrigger
  | PriceTrigger
  | NameWatchTrigger
  | DailyDigestTrigger
  | InvoiceTrigger;

export type Channel =
  | { type: "webhook"; config: { url: string } }
  | { type: "telegram"; config: { chatRef: string } }
  | { type: "discord"; config: { url: string } };

export type HookInput = { name: string; trigger: Trigger; channel: Channel; active?: boolean };

export type Hook = {
  id: string;
  name: string;
  active: boolean;
  trigger: { type: Trigger["type"]; config: Record<string, unknown>; resolved: Record<string, string> };
  channel: { type: Channel["type"]; config: Record<string, unknown> };
  /** Signing secret for webhook deliveries. */
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

export type HookEvent = { id: string; type: QiePulseEvent["type"]; createdAt: number; payload: QiePulseEvent; delivery: Delivery | null };

// ───────── payment links ─────────

export type InvoiceToken = "QUSDC" | "QIE" | "WQIE";
export type InvoiceInput = {
  /** Decimal string, e.g. "25" or "9.99". */
  amount: string;
  token?: InvoiceToken;
  /** Shown to the payer. */
  description?: string;
  /** name.qie or address that receives the funds. Defaults to your account's wallet. */
  recipient?: string;
  /** 5 to 43200 (30 days). Default 60. */
  expiresInMinutes?: number;
  /** Returned in the `invoice.paid` event. Up to 2 KB of JSON. */
  metadata?: Record<string, unknown>;
  /** The payer is sent here after paying, with `?invoice=…&tx=…`. https only. */
  successUrl?: string;
};
export type Invoice = {
  id: string;
  /** Hosted checkout page. Send the payer here. */
  url: string;
  status: "open" | "paid" | "expired" | "cancelled";
  description: string;
  recipient: { address: string; name: string | null };
  token: { symbol: string; address: string | null; decimals: number };
  /** The exact amount to pay. May be a few millionths above the base amount so the payment can be identified. */
  amount: { raw: string; formatted: string; display: string };
  baseAmount: { raw: string; formatted: string };
  expiresAt: number;
  createdAt: number;
  successUrl: string | null;
  payment: { txHash: string; from: string; blockNumber: number; paidAt: number; late: boolean; explorerUrl: string } | null;
  metadata?: Record<string, unknown>;
  chainId: number;
};

// ───────── traction pages ─────────

export type TractionStats = {
  totals: { txs: number; wallets: number; failedTxs: number; returningWallets: number; topWalletsShare: number; qieValue: number; since: number | null };
  last24h: { txs: number; wallets: number };
  last7d: { txs: number; wallets: number };
  last30d: { txs: number; wallets: number };
  series: { date: string; txs: number; wallets: number; newWallets: number }[];
  recent: { txHash: string; wallet: string; contract: string; ts: number; ok: boolean; method: string | null }[];
};
