import type { Db } from "./db.ts";

/**
 * End-to-end latency, measured from the block's on-chain timestamp:
 * - `stream`:  block produced → pushed to WebSocket subscribers
 * - `detect`:  block produced → event matched and stored by the indexer
 * - `deliver`: block produced → webhook / Telegram / Discord accepted it (first attempt)
 *
 * QIE block timestamps have 1-second resolution, so each sample can overstate
 * the true latency by up to 1 s. Numbers are upper bounds, never flattering.
 */
export type Series = "stream" | "detect" | "deliver";
export const SERIES: Series[] = ["stream", "detect", "deliver"];

/** Samples above this are catch-up after downtime, not live latency. */
const MAX_LIVE_MS = 10 * 60_000;
const KEEP_MS = 24 * 3600_000;
const CACHE_MS = 10_000;

export type LatencyStats = { count: number; p50: number | null; p95: number | null; p99: number | null; max: number | null };

export class Metrics {
  private db: Db;
  private inserts = 0;
  private cached: { at: number; windowMs: number; value: Record<Series, LatencyStats> } | null = null;

  constructor(db: Db) {
    this.db = db;
  }

  /** Record a sample: `blockTimestampSec` is the block's timestamp, `atMs` when the step finished. */
  record(series: Series, blockTimestampSec: number | null | undefined, atMs = Date.now()): void {
    if (!blockTimestampSec) return;
    const ms = Math.max(0, atMs - blockTimestampSec * 1000);
    if (ms > MAX_LIVE_MS) return;
    this.db.prepare("INSERT INTO latency_samples (series, at_ms, ms) VALUES (?, ?, ?)").run(series, atMs, ms);
    if (++this.inserts % 500 === 0) this.prune(atMs);
  }

  prune(now = Date.now()): void {
    this.db.prepare("DELETE FROM latency_samples WHERE at_ms < ?").run(now - KEEP_MS);
  }

  stats(series: Series, windowMs = KEEP_MS, now = Date.now()): LatencyStats {
    const rows = this.db
      .prepare("SELECT ms FROM latency_samples WHERE series = ? AND at_ms >= ? ORDER BY ms")
      .all(series, now - windowMs) as { ms: number }[];
    const v = rows.map((r) => r.ms);
    return { count: v.length, p50: pct(v, 50), p95: pct(v, 95), p99: pct(v, 99), max: v.length ? v[v.length - 1]! : null };
  }

  /** Public status polls this every few seconds per viewer; percentiles over a day of samples are cached briefly. */
  all(windowMs = KEEP_MS): Record<Series, LatencyStats> {
    if (this.cached && this.cached.windowMs === windowMs && Date.now() - this.cached.at < CACHE_MS) return this.cached.value;
    const value = Object.fromEntries(SERIES.map((s) => [s, this.stats(s, windowMs)])) as Record<Series, LatencyStats>;
    this.cached = { at: Date.now(), windowMs, value };
    return value;
  }
}

/** Nearest-rank percentile over an ascending array. */
export function pct(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}
