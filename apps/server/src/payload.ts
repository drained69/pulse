import { formatUnits } from "viem";
import { KNOWN_TOKENS, type TokenInfo } from "./chain.ts";
import type { NameResolver } from "./names.ts";
import type { TokenService } from "./tokens.ts";
import type { MatchedEvent } from "./triggers.ts";
import { newId, prettyAmount, shortAddr } from "./util.ts";

export type Party = { address: string; name: string | null };
export type Amount = { raw: string; formatted: string; display: string; symbol: string; valueUsd: number | null };
export type TokenOut = { address: string | null; symbol: string; decimals: number; official: boolean; warning?: string };

export type ScheduledType = "balance.threshold" | "price.threshold" | "name.changed" | "digest.daily";

export type EventPayload = {
  id: string;
  type: MatchedEvent["type"] | ScheduledType | "invoice.paid" | "test";
  createdAt: string;
  hook: { id: string; name: string };
  chain: { id: number; network: string };
  /** The transaction that caused the event. Null for scheduled events (balance, price, name, digest). */
  tx: { hash: string; blockNumber: number; logIndex: number | null; timestamp: number | null; explorerUrl: string } | null;
  /** Link to look at, for events without a transaction. */
  link?: string;
  data: Record<string, unknown>;
};

const OFFICIAL_SYMBOLS = new Set(Object.values(KNOWN_TOKENS).map((t) => t.symbol));

export function tokenOut(t: TokenInfo): TokenOut {
  const official = t.address === null || Boolean(KNOWN_TOKENS[t.address.toLowerCase()]?.official);
  const out: TokenOut = { address: t.address, symbol: t.symbol, decimals: t.decimals, official };
  if (!official && OFFICIAL_SYMBOLS.has(t.symbol.toUpperCase())) {
    out.warning = `Unofficial token using the ${t.symbol} symbol. The official ${t.symbol} is ${
      Object.values(KNOWN_TOKENS).find((k) => k.symbol === t.symbol.toUpperCase())?.address
    }.`;
  }
  return out;
}

export function amount(raw: bigint, t: TokenInfo, priceUsd: number | null): Amount {
  const formatted = formatUnits(raw, t.decimals);
  const valueUsd = priceUsd === null ? null : Math.round(Number(formatted) * priceUsd * 100) / 100;
  return { raw: raw.toString(), formatted, display: `${prettyAmount(formatted)} ${t.symbol}`, symbol: t.symbol, valueUsd };
}

/**
 * How long an alert may wait for a QIE ID reverse lookup. The lookup keeps
 * running after this and fills the cache, so the next alert for the same
 * address shows the name. Alerts are never held back by a slow resolver.
 */
export const REVERSE_LOOKUP_BUDGET_MS = 1500;

async function party(address: string, names: NameResolver, knownName?: string | null): Promise<Party> {
  if (knownName) return { address, name: knownName };
  const lookup = names.reverse(address).catch(() => null);
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<null>((r) => {
    timer = setTimeout(() => r(null), REVERSE_LOOKUP_BUDGET_MS);
    timer.unref();
  });
  const name = await Promise.race([lookup, budget]);
  clearTimeout(timer);
  return { address, name };
}

export type PayloadCtx = {
  chainId: number;
  network: string;
  explorerUrl: string;
  names: NameResolver;
  tokens: TokenService;
  /** QIE ID the hook was configured with (e.g. "shop.qie"), shown for the recipient. */
  configuredNames?: { recipient?: string; from?: string; to?: string };
};

export async function buildPayload(m: MatchedEvent, timestamp: number | null, ctx: PayloadCtx): Promise<EventPayload> {
  const d = m.data;
  let data: Record<string, unknown>;
  switch (m.type) {
    case "payment.received":
    case "token.transfer": {
      const t = d.token as TokenInfo;
      const price = ctx.tokens.priceUsd(t.address);
      const toName = m.type === "payment.received" ? ctx.configuredNames?.recipient : ctx.configuredNames?.to;
      const [from, to] = await Promise.all([party(d.from as string, ctx.names, null), party(d.to as string, ctx.names, toName ?? null)]);
      data = {
        from,
        to,
        token: tokenOut(t),
        amount: amount(d.amount as bigint, t, tokenOut(t).official ? price : null),
      };
      break;
    }
    case "dex.swap": {
      const tin = d.tokenIn as TokenInfo;
      const tout = d.tokenOut as TokenInfo;
      data = {
        pair: d.pair,
        trader: await party(d.to as string, ctx.names),
        sender: d.sender,
        tokenIn: tokenOut(tin),
        tokenOut: tokenOut(tout),
        amountIn: amount(d.amountIn as bigint, tin, ctx.tokens.priceUsd(tin.address)),
        amountOut: amount(d.amountOut as bigint, tout, ctx.tokens.priceUsd(tout.address)),
        valueUsd: d.valueUsd === null ? null : Math.round((d.valueUsd as number) * 100) / 100,
      };
      break;
    }
    case "contract.event":
      data = { contract: d.contract, event: d.event, args: d.args };
      break;
    case "wallet.activity": {
      const t = d.token as TokenInfo;
      const watched = d.wallet as string;
      const knownName = ctx.configuredNames?.recipient ?? null;
      const p = async (a: string | null) => (a === null ? null : await party(a, ctx.names, a === watched ? knownName : null));
      data = {
        kind: d.kind,
        direction: d.direction,
        status: d.status,
        wallet: await p(watched),
        from: await p(d.from as string),
        to: await p(d.to as string | null),
        token: tokenOut(t),
        amount: amount(d.amount as bigint, t, tokenOut(t).official ? ctx.tokens.priceUsd(t.address) : null),
        method: d.method ?? null,
      };
      break;
    }
  }
  return {
    id: newId("evt"),
    type: m.type,
    createdAt: new Date().toISOString(),
    hook: { id: m.hook.id, name: m.hook.name },
    chain: { id: ctx.chainId, network: ctx.network },
    tx: {
      hash: m.txHash,
      blockNumber: m.blockNumber,
      logIndex: m.logIndex,
      timestamp,
      explorerUrl: `${ctx.explorerUrl}/tx/${m.txHash}`,
    },
    data,
  };
}

/** Payload for a scheduled (timer-driven) event that has no transaction. */
export function scheduledPayload(
  hook: { id: string; name: string },
  type: ScheduledType,
  data: Record<string, unknown>,
  ctx: { chainId: number; network: string },
  link?: string,
): EventPayload {
  return {
    id: newId("evt"),
    type,
    createdAt: new Date().toISOString(),
    hook,
    chain: { id: ctx.chainId, network: ctx.network },
    tx: null,
    link,
    data,
  };
}

/** A sample event for the "Send test" button. */
export function testPayload(hook: { id: string; name: string }, ctx: { chainId: number; network: string; explorerUrl: string }): EventPayload {
  const hash = `0x${"0".repeat(63)}1`;
  return {
    id: newId("evt"),
    type: "test",
    createdAt: new Date().toISOString(),
    hook,
    chain: { id: ctx.chainId, network: ctx.network },
    tx: { hash, blockNumber: 0, logIndex: null, timestamp: Math.floor(Date.now() / 1000), explorerUrl: `${ctx.explorerUrl}/tx/${hash}` },
    data: {
      message: "This is a test event from QIE Pulse. Real events have the same envelope.",
      from: { address: "0x000000000000000000000000000000000000dEaD", name: "alice.qie" },
      to: { address: "0x000000000000000000000000000000000000bEEF", name: "shop.qie" },
      token: { address: null, symbol: "QUSDC", decimals: 6, official: true },
      amount: { raw: "25000000", formatted: "25", display: "25 QUSDC", symbol: "QUSDC", valueUsd: 25 },
    },
  };
}

const partyLabel = (p: Party | undefined): string => (p ? (p.name ?? shortAddr(p.address)) : "?");

/** Human-readable summary used by Telegram and Discord. */
export function describe(p: EventPayload): { title: string; lines: string[]; emoji: string } {
  const d = p.data as Record<string, any>;
  const usd = (a: Amount | undefined) => (a?.valueUsd != null ? ` (~$${a.valueUsd.toLocaleString("en-US")})` : "");
  switch (p.type) {
    case "payment.received":
      return {
        emoji: "💸",
        title: `${partyLabel(d.to)} received ${d.amount.display}${usd(d.amount)}`,
        lines: [`From: ${partyLabel(d.from)}`, ...(d.token.warning ? [`⚠️ ${d.token.warning}`] : [])],
      };
    case "token.transfer":
      return {
        emoji: "🔁",
        title: `${d.amount.display}${usd(d.amount)} transferred`,
        lines: [`From: ${partyLabel(d.from)}`, `To: ${partyLabel(d.to)}`, ...(d.token.warning ? [`⚠️ ${d.token.warning}`] : [])],
      };
    case "dex.swap":
      return {
        emoji: "🔄",
        title: `Swap ${d.amountIn.display} → ${d.amountOut.display}${d.valueUsd != null ? ` (~$${d.valueUsd.toLocaleString("en-US")})` : ""}`,
        lines: [`Trader: ${partyLabel(d.trader)}`, "QIEDEX"],
      };
    case "wallet.activity": {
      const w = partyLabel(d.wallet);
      const failed = d.status === "failed" ? "❌ FAILED · " : "";
      const verb =
        d.kind === "contract_call"
          ? `${w} ${d.direction === "out" ? "called" : "was called by"} ${partyLabel(d.direction === "out" ? d.to : d.from)}`
          : d.kind === "contract_deploy"
            ? `${w} deployed a contract`
            : d.direction === "in"
              ? `${w} received ${d.amount.display}${usd(d.amount)}`
              : `${w} sent ${d.amount.display}${usd(d.amount)}`;
      const other = d.direction === "in" ? `From: ${partyLabel(d.from)}` : d.to ? `To: ${partyLabel(d.to)}` : "";
      return {
        emoji: d.status === "failed" ? "⛔" : d.direction === "in" ? "📥" : "📤",
        title: `${failed}${verb}`,
        lines: [other, ...(d.method && d.kind === "contract_call" ? [`Method: ${d.method}`] : []), ...(d.token?.warning ? [`⚠️ ${d.token.warning}`] : [])].filter(Boolean),
      };
    }
    case "balance.threshold":
      return {
        emoji: d.direction === "below" ? "🪫" : "💰",
        title: `${partyLabel(d.wallet)} balance is ${d.direction} ${d.threshold} ${d.symbol}`,
        lines: [`Now: ${d.balance.display}`],
      };
    case "price.threshold":
      return {
        emoji: d.direction === "above" ? "📈" : "📉",
        title: `${d.symbol} is ${d.direction} $${d.threshold}`,
        lines: [`Price now: $${Number(d.priceUsd).toPrecision(4)} on QIEDEX`],
      };
    case "name.changed":
      return {
        emoji: "🪪",
        title: `${d.name} now points to ${d.to ? shortAddr(d.to) : "nothing"}`,
        lines: [`Before: ${d.from ? shortAddr(d.from) : "not registered"}`, "If you did not do this, check the name's owner now."],
      };
    case "invoice.paid": {
      const inv = d.invoice as { description: string; id: string; late: boolean };
      return {
        emoji: "🧾",
        title: `Payment link paid: ${d.amount.display}${usd(d.amount)}`,
        lines: [
          ...(inv.description ? [inv.description] : []),
          `From: ${partyLabel(d.from)}`,
          `Link: ${inv.id}${inv.late ? " (paid after it expired)" : ""}`,
        ],
      };
    }
    case "digest.daily": {
      const totals = (d.totals as { symbol: string; display: string }[]) ?? [];
      return {
        emoji: "🗓️",
        title: `Daily summary: ${d.sourceHookName}`,
        lines: [
          `${d.count} event${d.count === 1 ? "" : "s"} in the last 24 hours`,
          ...totals.map((t) => `Total: ${t.display}`),
          ...((d.top as { label: string; count: number }[]) ?? []).slice(0, 3).map((t, i) => `${i + 1}. ${t.label} (${t.count})`),
        ],
      };
    }
    case "contract.event":
      return {
        emoji: "📣",
        title: `${d.event} on ${shortAddr(d.contract)}`,
        lines: Object.entries(d.args ?? {})
          .slice(0, 8)
          .map(([k, v]) => `${k}: ${typeof v === "string" && v.length > 42 ? `${v.slice(0, 40)}…` : String(v)}`),
      };
    default:
      return { emoji: "🧪", title: `Test event for “${p.hook.name}”`, lines: [`${partyLabel(d.to)} received ${d.amount?.display ?? ""}`, "Your hook is connected."] };
  }
}
