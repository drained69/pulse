import { Easing, interpolate, spring } from "remotion";
import { FPS } from "../timeline.ts";

export const easeOut = Easing.bezier(0.16, 1, 0.3, 1);
export const easeInOut = Easing.bezier(0.65, 0, 0.35, 1);
export const easeIn = Easing.bezier(0.7, 0, 0.84, 0);

/** 0→1 over [start, start+dur], clamped. */
export function prog(f: number, start: number, dur: number, easing: (t: number) => number = easeOut): number {
  if (dur <= 0) return f >= start ? 1 : 0;
  return interpolate(f, [start, start + dur], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing });
}

/** A springy 0→1 (may overshoot a little) starting at `start`. */
export function pop(f: number, start: number, stiffness = 190, damping = 15): number {
  if (f < start) return 0;
  return spring({ frame: f - start, fps: FPS, config: { stiffness, damping, mass: 0.7 } });
}

export const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Opacity/translate style for an element that enters at `start` and optionally leaves at `end`. */
export function enter(f: number, start: number, opts: { dy?: number; dx?: number; dur?: number; end?: number; outDur?: number; scale?: number } = {}) {
  const { dy = 24, dx = 0, dur = 12, end, outDur = 8, scale = 0 } = opts;
  const a = prog(f, start, dur);
  const b = end === undefined ? 0 : prog(f, end, outDur, easeIn);
  const o = a * (1 - b);
  return {
    opacity: o,
    transform: `translate(${dx * (1 - a)}px, ${dy * (1 - a) - b * 16}px)${scale ? ` scale(${1 - scale * (1 - a)})` : ""}`,
  } as const;
}

/** Number that counts up from 0 to `to` between frames. */
export function countUp(f: number, start: number, dur: number, to: number): number {
  return Math.round(to * prog(f, start, dur, Easing.bezier(0.2, 0.7, 0.2, 1)));
}

export const fmt = (n: number): string => n.toLocaleString("en-US");
