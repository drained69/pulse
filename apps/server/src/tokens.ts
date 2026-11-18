import { decodeFunctionResult, encodeFunctionData, getAddress } from "viem";
import { ERC20_ABI, KNOWN_TOKENS, PAIR_ABI, QIE_MAINNET, type TokenInfo } from "./chain.ts";
import type { RpcPool } from "./rpc.ts";
import { errMsg, log } from "./util.ts";

export type PairInfo = {
  address: `0x${string}`;
  token0: TokenInfo;
  token1: TokenInfo;
  priceUsd0: number | null;
  priceUsd1: number | null;
  liquidityUsd: number | null;
};

/** Token metadata (symbol/decimals) and QIEDEX pairs + USD prices, cached. */
export class TokenService {
  private rpc: RpcPool;
  private dexApi: string;
  private tokens = new Map<string, TokenInfo>(Object.entries(KNOWN_TOKENS));
  private pairs = new Map<string, PairInfo>();
  private usd = new Map<string, number>();
  private pairsFetchedAt = 0;

  constructor(rpc: RpcPool, dexApiUrl: string) {
    this.rpc = rpc;
    this.dexApi = dexApiUrl.replace(/\/$/, "");
    this.usd.set(QIE_MAINNET.QUSDC.toLowerCase(), 1);
  }

  async token(address: string): Promise<TokenInfo> {
    const key = address.toLowerCase();
    const hit = this.tokens.get(key);
    if (hit) return hit;
    const addr = getAddress(address);
    let symbol = "TOKEN";
    let decimals = 18;
    try {
      const [s, d] = await this.rpc.batch<`0x${string}`>([
        { method: "eth_call", params: [{ to: addr, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "symbol" }) }, "latest"] },
        { method: "eth_call", params: [{ to: addr, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "decimals" }) }, "latest"] },
      ]);
      symbol = decodeFunctionResult({ abi: ERC20_ABI, functionName: "symbol", data: s! });
      decimals = Number(decodeFunctionResult({ abi: ERC20_ABI, functionName: "decimals", data: d! }));
    } catch (e) {
      log.debug("token metadata lookup failed", { address: addr, error: errMsg(e) });
    }
    const info: TokenInfo = { address: addr, symbol, decimals };
    this.tokens.set(key, info);
    return info;
  }

  /** Refresh QIEDEX pairs and prices from the official QIEDEX API (at most once a minute, matching the price checks). */
  async refreshPairs(force = false): Promise<void> {
    if (!force && Date.now() - this.pairsFetchedAt < 60_000) return;
    try {
      const res = await fetch(`${this.dexApi}/pairs`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { pairs?: DexPair[] } | DexPair[];
      const list = Array.isArray(json) ? json : (json.pairs ?? []);
      for (const p of list) {
        const t0: TokenInfo = { address: getAddress(p.token0.address), symbol: p.token0.symbol, decimals: p.token0.decimals };
        const t1: TokenInfo = { address: getAddress(p.token1.address), symbol: p.token1.symbol, decimals: p.token1.decimals };
        if (!this.tokens.has(t0.address!.toLowerCase())) this.tokens.set(t0.address!.toLowerCase(), t0);
        if (!this.tokens.has(t1.address!.toLowerCase())) this.tokens.set(t1.address!.toLowerCase(), t1);
        if (typeof p.token0.priceUsd === "number") this.usd.set(t0.address!.toLowerCase(), p.token0.priceUsd);
        if (typeof p.token1.priceUsd === "number") this.usd.set(t1.address!.toLowerCase(), p.token1.priceUsd);
        this.pairs.set(p.address.toLowerCase(), {
          address: getAddress(p.address),
          token0: t0,
          token1: t1,
          priceUsd0: p.token0.priceUsd ?? null,
          priceUsd1: p.token1.priceUsd ?? null,
          liquidityUsd: p.liquidityUsd ?? null,
        });
      }
      this.pairsFetchedAt = Date.now();
    } catch (e) {
      log.warn("QIEDEX pairs refresh failed", { error: errMsg(e) });
    }
  }

  listPairs(): PairInfo[] {
    return [...this.pairs.values()].sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0));
  }

  /** Pair metadata from cache, falling back to reading token0/token1 on chain (pairs not listed by the API). */
  async pair(address: string): Promise<PairInfo> {
    const key = address.toLowerCase();
    const hit = this.pairs.get(key);
    if (hit) return hit;
    const addr = getAddress(address);
    const [a0, a1] = await this.rpc.batch<`0x${string}`>([
      { method: "eth_call", params: [{ to: addr, data: encodeFunctionData({ abi: PAIR_ABI, functionName: "token0" }) }, "latest"] },
      { method: "eth_call", params: [{ to: addr, data: encodeFunctionData({ abi: PAIR_ABI, functionName: "token1" }) }, "latest"] },
    ]);
    const t0 = await this.token(decodeFunctionResult({ abi: PAIR_ABI, functionName: "token0", data: a0! }));
    const t1 = await this.token(decodeFunctionResult({ abi: PAIR_ABI, functionName: "token1", data: a1! }));
    const info: PairInfo = { address: addr, token0: t0, token1: t1, priceUsd0: this.priceUsd(t0.address), priceUsd1: this.priceUsd(t1.address), liquidityUsd: null };
    this.pairs.set(key, info);
    return info;
  }

  /** USD price for a token (null address = native QIE, priced as WQIE). */
  priceUsd(address: string | null): number | null {
    const key = (address ?? QIE_MAINNET.WQIE).toLowerCase();
    return this.usd.get(key) ?? null;
  }

  setPriceForTest(address: string, price: number): void {
    this.usd.set(address.toLowerCase(), price);
  }
}

type DexPair = {
  address: string;
  token0: { address: string; symbol: string; decimals: number; priceUsd?: number };
  token1: { address: string; symbol: string; decimals: number; priceUsd?: number };
  liquidityUsd?: number;
};
