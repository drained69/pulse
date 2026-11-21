/**
 * Rug-pull radar. A QIEDEX pair emits Sync(reserve0, reserve1) after every change. Pool depth is
 * sqrt(reserve0 * reserve1): swaps barely move it, adding liquidity raises it, removing lowers it.
 * Each hook keeps its 24-hour peak; when depth falls `dropPercent` below the peak it fires once,
 * and re-arms once depth is back within half that drop.
 */

export type LiquidityState = { peak: string; peakAt: number; armed: boolean };

export const PEAK_WINDOW_SEC = 86400;

export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error("negative");
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

export function depthOf(reserve0: bigint, reserve1: bigint): bigint {
  return isqrt(reserve0 * reserve1);
}

/** Advance a hook's state with a new depth. Returns the drop in percent when it should fire. */
export function stepLiquidity(
  prev: LiquidityState | null,
  depth: bigint,
  dropPercent: number,
  now: number,
): { state: LiquidityState; fire: number | null; peak: bigint } {
  if (!prev || now - prev.peakAt > PEAK_WINDOW_SEC || BigInt(prev.peak) === 0n) {
    return { state: { peak: depth.toString(), peakAt: now, armed: prev?.armed ?? true }, fire: null, peak: depth };
  }
  let peak = BigInt(prev.peak);
  let peakAt = prev.peakAt;
  if (depth >= peak) {
    peak = depth;
    peakAt = now;
  }
  const dropBp = peak === 0n ? 0 : Number(((peak - depth) * 10000n) / peak); // basis points
  const drop = dropBp / 100;
  let armed = prev.armed;
  let fire: number | null = null;
  if (drop >= dropPercent && armed) {
    fire = drop;
    armed = false;
  } else if (drop < dropPercent / 2) {
    armed = true;
  }
  return { state: { peak: peak.toString(), peakAt, armed }, fire, peak };
}
