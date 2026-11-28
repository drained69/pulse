import { decodeFunctionResult, encodeFunctionData, formatUnits, parseAbi, type Hex } from "viem";
import { ORACLE_FEED_NAMES, QIE_ORACLES, type OracleFeed } from "./chain.ts";
import type { Config } from "./config.ts";
import type { RpcPool } from "./rpc.ts";

export const AGGREGATOR_V3_ABI = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

export type OraclePrice = {
  feed: OracleFeed;
  address: Hex;
  price: number | null;
  decimals: number;
  roundId: string | null;
  updatedAt: number | null;
  stale: boolean;
};

/** Read-only mainnet feeds. Coalesce callers and cache even failures for 60 seconds. */
export class OracleService {
  private cached: OraclePrice[] = [];
  private fetchedAt = -Infinity;
  private pending: Promise<void> | null = null;

  private cfg: Config;
  private rpc: Pick<RpcPool, "batch">;
  private clock: () => number;

  constructor(cfg: Config, rpc: Pick<RpcPool, "batch">, clock = Date.now) {
    this.cfg = cfg;
    this.rpc = rpc;
    this.clock = clock;
  }

  async prices(): Promise<OraclePrice[]> {
    // These addresses are mainnet contracts; never read them against a different chain.
    if (this.cfg.chainId !== 1990) return [];
    if (this.clock() - this.fetchedAt >= 60_000) {
      this.pending ??= this.refresh().finally(() => { this.pending = null; });
      await this.pending;
    }
    const now = Math.floor(this.clock() / 1000);
    return this.cached.map((row) => {
      // Recompute age on every read so a cached round cannot outlive the age limit.
      const stale = row.stale || row.updatedAt === null || now - row.updatedAt > this.cfg.oracleMaxAgeSec;
      return { ...row, stale, price: stale ? null : row.price };
    });
  }

  private async refresh(): Promise<void> {
    const empty = (feed: OracleFeed): OraclePrice => ({ feed, ...QIE_ORACLES[feed], price: null, roundId: null, updatedAt: null, stale: true });
    let results: Hex[];
    try {
      results = await this.rpc.batch<Hex>(ORACLE_FEED_NAMES.map((feed) => ({
        method: "eth_call",
        params: [{ to: QIE_ORACLES[feed].address, data: encodeFunctionData({ abi: AGGREGATOR_V3_ABI, functionName: "latestRoundData" }) }, "latest"],
      })));
    } catch {
      // A failed batch must not reuse a previous price or re-arm an existing alert.
      this.cached = ORACLE_FEED_NAMES.map(empty);
      this.fetchedAt = this.clock();
      return;
    }
    const now = Math.floor(this.clock() / 1000);
    this.cached = ORACLE_FEED_NAMES.map((feed, i) => {
      try {
        const [roundId, answer, startedAt, updatedAt, answeredInRound] = decodeFunctionResult({ abi: AGGREGATOR_V3_ABI, functionName: "latestRoundData", data: results[i]! });
        const row = empty(feed);
        row.roundId = roundId.toString();
        const update = Number(updatedAt);
        row.updatedAt = Number.isSafeInteger(update) && update > 0 && update <= now ? update : null;
        const price = Number(formatUnits(answer, row.decimals));
        row.stale = row.updatedAt === null || now - row.updatedAt > this.cfg.oracleMaxAgeSec;
        if (!row.stale && roundId > 0n && answeredInRound >= roundId && startedAt > 0n && startedAt <= updatedAt && answer > 0n && Number.isFinite(price) && price > 0) row.price = price;
        return row;
      } catch {
        return empty(feed);
      }
    });
    this.fetchedAt = this.clock();
  }
}
