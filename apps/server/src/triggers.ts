import { decodeEventLog, getAddress, isAddress, parseAbiItem, parseUnits, toEventSelector, type AbiEvent } from "viem";
import { z } from "zod";
import { QIE_MAINNET, SWAP_EVENT, TOPIC, TRANSFER_EVENT, NATIVE_TOKEN, hexToNum, type RpcLog, type RpcTx, type TokenInfo } from "./chain.ts";
import { looksLikeQieName } from "./names.ts";

// ───────────────────────── Schemas ─────────────────────────

const addressOrName = z
  .string()
  .trim()
  .min(1)
  .refine((v) => isAddress(v) || looksLikeQieName(v), "Must be a 0x address or a name.qie");

const tokenRef = z
  .string()
  .trim()
  .refine((v) => isAddress(v) || ["QIE", "QUSDC", "WQIE"].includes(v.toUpperCase()), "Must be QIE, QUSDC, WQIE or a token address");

const decimalAmount = z
  .string()
  .trim()
  .regex(/^\d+(\.\d+)?$/, "Must be a positive decimal number like 25 or 0.5");

export const triggerSchemas = {
  payment: z.object({
    recipient: addressOrName,
    /** Assets that count as a payment. Default: native QIE and QUSDC. */
    assets: z.array(tokenRef).min(1).max(20).default(["QIE", "QUSDC"]),
    /** Count any ERC-20 sent to the recipient, not just the listed assets. */
    anyToken: z.boolean().default(false),
    minAmount: decimalAmount.optional(),
  }),
  token_transfer: z.object({
    token: tokenRef.refine((v) => v.toUpperCase() !== "QIE", "Use a payment hook for native QIE"),
    from: addressOrName.optional(),
    to: addressOrName.optional(),
    minAmount: decimalAmount.optional(),
  }),
  swap: z.object({
    pair: z.string().refine(isAddress, "Must be a QIEDEX pair address"),
    minValueUsd: z.number().nonnegative().optional(),
  }),
  contract_event: z
    .object({
      address: z.string().refine(isAddress, "Must be a contract address").optional(),
      /** Solidity event signature, e.g. `event Deposit(address indexed user, uint256 amount)`. */
      event: z.string().trim().min(5).max(500).optional(),
      /** Several signatures in one hook (e.g. all Safe events). Combined with `event`. */
      events: z.array(z.string().trim().min(5).max(500)).max(12).default([]),
      /** Only fire when decoded args equal these values (by argument name). Args an event lacks are ignored. */
      filters: z
        .record(z.string().max(64), z.string().max(200))
        .default({})
        .refine((f) => Object.keys(f).length <= 16, "At most 16 filters"),
    })
    .refine((c) => Boolean(c.event) || c.events.length > 0, "Give at least one event signature"),
  /** Everything that happens to one wallet or contract: QIE in/out, token transfers, contract calls, failed txs. */
  wallet: z.object({
    address: addressOrName,
    direction: z.enum(["in", "out", "both"]).default("both"),
    /** Include transactions that reverted (only ones sent by or to the address). */
    includeFailed: z.boolean().default(true),
    /** Include ERC-20 transfers in/out of the address. */
    includeTokens: z.boolean().default(true),
  }),
  /** Scheduled: fire when a balance crosses a threshold. */
  balance: z
    .object({
      address: addressOrName,
      asset: tokenRef.default("QIE"),
      below: decimalAmount.optional(),
      above: decimalAmount.optional(),
    })
    .refine((c) => Boolean(c.below) !== Boolean(c.above), "Set exactly one of below or above"),
  /** Scheduled: fire when a token's QIEDEX USD price crosses a threshold. */
  price: z
    .object({
      token: tokenRef,
      below: z.number().positive().optional(),
      above: z.number().positive().optional(),
    })
    .refine((c) => (c.below === undefined) !== (c.above === undefined), "Set exactly one of below or above"),
  /** Scheduled: fire when a QIE ID starts pointing to a different address (or stops resolving). */
  name_watch: z.object({
    name: z.string().trim().refine(looksLikeQieName, "Must be a name.qie"),
  }),
  /** Fires when any of your payment links is paid (`invoice.paid`). */
  invoice: z.object({}).default({}),
  /** Rug-pull radar: a QIEDEX pair's liquidity falls by this much from its 24-hour peak. */
  liquidity: z.object({
    pair: z.string().refine(isAddress, "Must be a QIEDEX pair address"),
    dropPercent: z.number().min(5).max(95).default(30),
  }),
  /** Scheduled: once a day, a summary of another hook's events over the last 24 hours. */
  daily_digest: z.object({
    sourceHookId: z.string().min(3),
    hourUtc: z.number().int().min(0).max(23).default(8),
  }),
} as const;

export type TriggerType = keyof typeof triggerSchemas;
export const TRIGGER_TYPES = Object.keys(triggerSchemas) as TriggerType[];
/** Triggers evaluated on a timer instead of per block. */
export const SCHEDULED_TYPES: TriggerType[] = ["balance", "price", "name_watch", "daily_digest"];

/** All event signatures of a contract_event config. */
export function eventSignatures(c: { event?: string; events?: string[] }): string[] {
  return [...(c.event ? [c.event] : []), ...(c.events ?? [])];
}
export type TriggerConfig = { [K in TriggerType]: z.infer<(typeof triggerSchemas)[K]> };

export const channelSchemas = {
  webhook: z.object({ url: z.string().max(2048).url().refine((u) => /^https?:\/\//.test(u), "Must be http(s)") }),
  telegram: z.object({ chatRef: z.string().min(1) }),
  discord: z.object({
    url: z.string().refine((u) => /^https:\/\/(?:ptb\.|canary\.)?(?:discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(u), "Must be a Discord webhook URL"),
  }),
} as const;
export type ChannelType = keyof typeof channelSchemas;
export const CHANNEL_TYPES = Object.keys(channelSchemas) as ChannelType[];

/** Parse an event signature; accepts it with or without the leading `event` keyword. */
export function parseEventSignature(sig: string): AbiEvent {
  const s = sig.trim().startsWith("event ") ? sig.trim() : `event ${sig.trim()}`;
  const item = parseAbiItem(s) as AbiEvent;
  if (item.type !== "event") throw new Error("Not an event signature");
  return item;
}

export function tokenAddressFor(ref: string): `0x${string}` | null {
  const up = ref.toUpperCase();
  if (up === "QIE") return null;
  if (up === "QUSDC") return QIE_MAINNET.QUSDC;
  if (up === "WQIE") return QIE_MAINNET.WQIE;
  return getAddress(ref);
}

// ───────────────────────── Compiled hooks ─────────────────────────

export type HookRow = {
  id: string;
  user_id: string;
  name: string;
  trigger_type: TriggerType;
  trigger_config: string;
  resolved: string;
  channel_type: ChannelType;
  channel_config: string;
  secret: string;
  active: number;
};

/** Addresses resolved from `.qie` names at create time and refreshed in the background. */
export type Resolved = { recipient?: string; from?: string; to?: string; address?: string };

type Compiled =
  | { kind: "payment"; hook: HookRow; recipient: string; native: boolean; tokens: Set<string>; anyToken: boolean; minAmount?: string }
  | { kind: "token_transfer"; hook: HookRow; token: string; from?: string; to?: string; minAmount?: string }
  | { kind: "swap"; hook: HookRow; pair: string; minValueUsd?: number }
  | { kind: "contract_event"; hook: HookRow; address?: string; event: AbiEvent; topic0: string; filters: Record<string, string> }
  | { kind: "wallet"; hook: HookRow; address: string; dirIn: boolean; dirOut: boolean; includeFailed: boolean; includeTokens: boolean };

export type MatchedEvent = {
  hook: HookRow;
  type: "payment.received" | "token.transfer" | "dex.swap" | "contract.event" | "wallet.activity" | "liquidity.drop";
  dedupeKey: string;
  blockNumber: number;
  txHash: `0x${string}`;
  logIndex: number | null;
  data: Record<string, unknown>;
};

export type TokenLookup = (address: string) => Promise<TokenInfo>;
export type PairLookup = (address: string) => Promise<{ token0: TokenInfo; token1: TokenInfo; priceUsd0: number | null; priceUsd1: number | null }>;

/**
 * In-memory index of active hooks, keyed for O(1) lookups per log / tx.
 * Rebuilt whenever hooks change.
 */
export class HookIndex {
  paymentsByRecipient = new Map<string, Extract<Compiled, { kind: "payment" }>[]>();
  tokenTransfersByToken = new Map<string, Extract<Compiled, { kind: "token_transfer" }>[]>();
  swapsByPair = new Map<string, Extract<Compiled, { kind: "swap" }>[]>();
  eventsByTopic = new Map<string, Extract<Compiled, { kind: "contract_event" }>[]>();
  walletsByAddress = new Map<string, Extract<Compiled, { kind: "wallet" }>[]>();
  /** pair (lowercase) → rug-pull radar hooks. Matched by the indexer, which keeps each hook's peak. */
  liquidityByPair = new Map<string, { hook: HookRow; dropPercent: number }[]>();
  errors: { hookId: string; error: string }[] = [];
  size = 0;

  static build(rows: HookRow[]): HookIndex {
    const idx = new HookIndex();
    for (const row of rows) {
      if (!row.active) continue;
      try {
        idx.add(row);
        idx.size++;
      } catch (e) {
        idx.errors.push({ hookId: row.id, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return idx;
  }

  private add(row: HookRow): void {
    const resolved = JSON.parse(row.resolved || "{}") as Resolved;
    const push = <T>(m: Map<string, T[]>, key: string, v: T) => {
      const arr = m.get(key) ?? [];
      arr.push(v);
      m.set(key, arr);
    };
    switch (row.trigger_type) {
      case "payment": {
        const c = triggerSchemas.payment.parse(JSON.parse(row.trigger_config));
        const recipient = (resolved.recipient ?? c.recipient).toLowerCase();
        if (!isAddress(recipient)) throw new Error(`Unresolved recipient ${c.recipient}`);
        const tokens = new Set<string>();
        let native = false;
        for (const a of c.assets) {
          const t = tokenAddressFor(a);
          if (t === null) native = true;
          else tokens.add(t.toLowerCase());
        }
        push(this.paymentsByRecipient, recipient, { kind: "payment", hook: row, recipient, native, tokens, anyToken: c.anyToken, minAmount: c.minAmount });
        break;
      }
      case "token_transfer": {
        const c = triggerSchemas.token_transfer.parse(JSON.parse(row.trigger_config));
        const token = tokenAddressFor(c.token)!.toLowerCase();
        const from = c.from ? (resolved.from ?? c.from).toLowerCase() : undefined;
        const to = c.to ? (resolved.to ?? c.to).toLowerCase() : undefined;
        if ((from && !isAddress(from)) || (to && !isAddress(to))) throw new Error("Unresolved from/to name");
        push(this.tokenTransfersByToken, token, { kind: "token_transfer", hook: row, token, from, to, minAmount: c.minAmount });
        break;
      }
      case "swap": {
        const c = triggerSchemas.swap.parse(JSON.parse(row.trigger_config));
        push(this.swapsByPair, c.pair.toLowerCase(), { kind: "swap", hook: row, pair: c.pair.toLowerCase(), minValueUsd: c.minValueUsd });
        break;
      }
      case "contract_event": {
        const c = triggerSchemas.contract_event.parse(JSON.parse(row.trigger_config));
        for (const sig of eventSignatures(c)) {
          const event = parseEventSignature(sig);
          const topic0 = toEventSelector(event).toLowerCase();
          push(this.eventsByTopic, topic0, { kind: "contract_event", hook: row, address: c.address?.toLowerCase(), event, topic0, filters: c.filters });
        }
        break;
      }
      case "wallet": {
        const c = triggerSchemas.wallet.parse(JSON.parse(row.trigger_config));
        const address = (resolved.address ?? c.address).toLowerCase();
        if (!isAddress(address)) throw new Error(`Unresolved address ${c.address}`);
        push(this.walletsByAddress, address, {
          kind: "wallet",
          hook: row,
          address,
          dirIn: c.direction !== "out",
          dirOut: c.direction !== "in",
          includeFailed: c.includeFailed,
          includeTokens: c.includeTokens,
        });
        break;
      }
      case "liquidity": {
        const c = triggerSchemas.liquidity.parse(JSON.parse(row.trigger_config));
        push(this.liquidityByPair, c.pair.toLowerCase(), { hook: row, dropPercent: c.dropPercent });
        break;
      }
      default:
        // Scheduled triggers (balance, price, name_watch, daily_digest) are handled by the Checks worker.
        return;
    }
  }

  /** topic0 values worth asking the RPC for. */
  topics(): string[] {
    const t = new Set<string>(this.eventsByTopic.keys());
    if (this.paymentsByRecipient.size || this.tokenTransfersByToken.size || this.walletsByAddress.size) t.add(TOPIC.TRANSFER);
    if (this.swapsByPair.size) t.add(TOPIC.SWAP);
    if (this.liquidityByPair.size) t.add(TOPIC.SYNC);
    return [...t];
  }

  needsNativeTxs(): boolean {
    if (this.walletsByAddress.size) return true;
    for (const list of this.paymentsByRecipient.values()) if (list.some((p) => p.native)) return true;
    return false;
  }
}

function meetsMin(raw: bigint, min: string | undefined, decimals: number): boolean {
  if (!min) return true;
  return raw >= parseUnits(min, decimals);
}

/** Convert decoded args (bigints, nested arrays) to JSON-safe values. */
function jsonArgs(args: unknown): Record<string, unknown> {
  const conv = (v: unknown): unknown => {
    if (typeof v === "bigint") return v.toString();
    if (Array.isArray(v)) return v.map(conv);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, conv(x)]));
    return v;
  };
  return (conv(args ?? {}) as Record<string, unknown>) ?? {};
}

/** Match one log against the index. */
export async function matchLog(log: RpcLog, idx: HookIndex, tokenOf: TokenLookup, pairOf: PairLookup): Promise<MatchedEvent[]> {
  if (log.removed) return [];
  const out: MatchedEvent[] = [];
  const topic0 = log.topics[0]?.toLowerCase();
  if (!topic0) return out;
  const base = {
    blockNumber: hexToNum(log.blockNumber),
    txHash: log.transactionHash,
    logIndex: hexToNum(log.logIndex),
    dedupeKey: `${log.transactionHash}:${hexToNum(log.logIndex)}`,
  };
  const emitter = log.address.toLowerCase();

  // ERC-20 Transfer: exactly 3 topics (ERC-721 Transfer has 4).
  if (topic0 === TOPIC.TRANSFER && log.topics.length === 3) {
    const { args } = decodeEventLog({ abi: [TRANSFER_EVENT], data: log.data, topics: log.topics as [`0x${string}`, ...`0x${string}`[]] });
    const from = args.from.toLowerCase();
    const to = args.to.toLowerCase();
    const value = args.value;

    const payments = idx.paymentsByRecipient.get(to) ?? [];
    const transfers = idx.tokenTransfersByToken.get(emitter) ?? [];
    if (payments.length || transfers.length) {
      const token = await tokenOf(emitter);
      for (const p of payments) {
        if (value === 0n) continue; // a payment of nothing is never a payment, only address-poisoning spam
        if (!(p.anyToken || p.tokens.has(emitter))) continue;
        if (!meetsMin(value, p.minAmount, token.decimals)) continue;
        out.push({ ...base, hook: p.hook, type: "payment.received", data: { from: getAddress(from), to: getAddress(to), token, amount: value } });
      }
      for (const t of transfers) {
        if (t.from && t.from !== from) continue;
        if (t.to && t.to !== to) continue;
        if (!meetsMin(value, t.minAmount, token.decimals)) continue;
        out.push({ ...base, hook: t.hook, type: "token.transfer", data: { from: getAddress(from), to: getAddress(to), token, amount: value } });
      }
    }

    const walletIn = (idx.walletsByAddress.get(to) ?? []).filter((w) => w.includeTokens && w.dirIn);
    const walletOut = from === to ? [] : (idx.walletsByAddress.get(from) ?? []).filter((w) => w.includeTokens && w.dirOut);
    if (walletIn.length || walletOut.length) {
      const token = await tokenOf(emitter);
      for (const [list, direction] of [[walletIn, "in"], [walletOut, "out"]] as const) {
        for (const w of list) {
          out.push({
            ...base,
            hook: w.hook,
            type: "wallet.activity",
            data: { kind: "token_transfer", direction, wallet: getAddress(w.address), from: getAddress(from), to: getAddress(to), token, amount: value, status: "success" },
          });
        }
      }
    }
  }

  if (topic0 === TOPIC.SWAP) {
    const swaps = idx.swapsByPair.get(emitter) ?? [];
    if (swaps.length) {
      const { args } = decodeEventLog({ abi: [SWAP_EVENT], data: log.data, topics: log.topics as [`0x${string}`, ...`0x${string}`[]] });
      const pair = await pairOf(emitter);
      const zeroIn = args.amount0In > 0n;
      const tokenIn = zeroIn ? pair.token0 : pair.token1;
      const tokenOut = zeroIn ? pair.token1 : pair.token0;
      const amountIn = zeroIn ? args.amount0In : args.amount1In;
      const amountOut = zeroIn ? args.amount1Out : args.amount0Out;
      const priceIn = zeroIn ? pair.priceUsd0 : pair.priceUsd1;
      const priceOut = zeroIn ? pair.priceUsd1 : pair.priceUsd0;
      const valueUsd =
        priceIn !== null ? (Number(amountIn) / 10 ** tokenIn.decimals) * priceIn : priceOut !== null ? (Number(amountOut) / 10 ** tokenOut.decimals) * priceOut : null;
      for (const s of swaps) {
        if (s.minValueUsd !== undefined && (valueUsd === null || valueUsd < s.minValueUsd)) continue;
        out.push({
          ...base,
          hook: s.hook,
          type: "dex.swap",
          data: { pair: getAddress(emitter), sender: args.sender, to: args.to, tokenIn, tokenOut, amountIn, amountOut, valueUsd },
        });
      }
    }
  }

  for (const c of idx.eventsByTopic.get(topic0) ?? []) {
    if (c.address && c.address !== emitter) continue;
    let args: Record<string, unknown>;
    try {
      const decoded = decodeEventLog({ abi: [c.event], data: log.data, topics: log.topics as [`0x${string}`, ...`0x${string}`[]] });
      args = jsonArgs(decoded.args);
    } catch {
      continue; // same selector, different indexed layout
    }
    const names = new Set(c.event.inputs.map((i) => i.name));
    const pass = Object.entries(c.filters).every(([k, want]) => {
      if (!names.has(k)) return true; // filter targets another event in the same hook
      const got = args[k];
      return got !== undefined && String(got).toLowerCase() === want.trim().toLowerCase();
    });
    if (!pass) continue;
    out.push({ ...base, hook: c.hook, type: "contract.event", data: { contract: getAddress(emitter), event: c.event.name, args } });
  }
  return out;
}

/** Match a native QIE transfer (tx with value > 0). Caller must only pass successful txs. */
export function matchNativeTx(tx: RpcTx, idx: HookIndex): MatchedEvent[] {
  if (!tx.to) return [];
  const value = BigInt(tx.value);
  if (value === 0n) return [];
  const out: MatchedEvent[] = [];
  for (const p of idx.paymentsByRecipient.get(tx.to.toLowerCase()) ?? []) {
    if (!p.native) continue;
    if (!meetsMin(value, p.minAmount, 18)) continue;
    out.push({
      hook: p.hook,
      type: "payment.received",
      dedupeKey: `${tx.hash}:native`,
      blockNumber: hexToNum(tx.blockNumber),
      txHash: tx.hash,
      logIndex: null,
      data: { from: getAddress(tx.from), to: getAddress(tx.to), token: NATIVE_TOKEN, amount: value },
    });
  }
  return out;
}

/**
 * Transaction-level wallet activity: QIE sent/received, contract calls made by
 * the wallet, calls into a watched contract, and (optionally) failed ones.
 * `status` comes from the receipt. Pure QIE-less outgoing calls are dropped by
 * the caller when the same tx already produced a token-transfer event for the hook.
 */
export function matchWalletTx(tx: RpcTx, status: "success" | "failed", idx: HookIndex): MatchedEvent[] {
  const out: MatchedEvent[] = [];
  const from = tx.from.toLowerCase();
  const to = tx.to?.toLowerCase() ?? null;
  const value = BigInt(tx.value);
  const emit = (w: Extract<Compiled, { kind: "wallet" }>, direction: "in" | "out") => {
    if (status === "failed" && !w.includeFailed) return;
    const kind = value > 0n ? "native_transfer" : tx.to === null ? "contract_deploy" : "contract_call";
    out.push({
      hook: w.hook,
      type: "wallet.activity",
      dedupeKey: `${tx.hash}:tx:${direction}`,
      blockNumber: hexToNum(tx.blockNumber),
      txHash: tx.hash,
      logIndex: null,
      data: {
        kind,
        direction,
        wallet: getAddress(w.address),
        from: getAddress(tx.from),
        to: tx.to ? getAddress(tx.to) : null,
        token: NATIVE_TOKEN,
        amount: value,
        status,
        method: tx.input && tx.input.length >= 10 ? tx.input.slice(0, 10) : null,
      },
    });
  };
  for (const w of idx.walletsByAddress.get(from) ?? []) if (w.dirOut) emit(w, "out");
  if (to && to !== from) for (const w of idx.walletsByAddress.get(to) ?? []) if (w.dirIn) emit(w, "in");
  return out;
}
