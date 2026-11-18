import { createHash, randomBytes } from "node:crypto";

/** Random id with a readable prefix, e.g. `hk_3f9a...`. */
export function newId(prefix: string, bytes = 12): string {
  return `${prefix}_${randomBytes(bytes).toString("hex")}`;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export const nowSec = (): number => Math.floor(Date.now() / 1000);

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type Level = "debug" | "info" | "warn" | "error";
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel = LEVELS[(process.env.LOG_LEVEL as Level) ?? "info"] ?? 20;

function emit(level: Level, msg: string, extra?: Record<string, unknown>): void {
  if (LEVELS[level] < minLevel) return;
  const line = { t: new Date().toISOString(), level, msg, ...extra };
  const out = JSON.stringify(line, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  if (level === "error" || level === "warn") console.error(out);
  else console.log(out);
}

export const log = {
  debug: (msg: string, extra?: Record<string, unknown>) => emit("debug", msg, extra),
  info: (msg: string, extra?: Record<string, unknown>) => emit("info", msg, extra),
  warn: (msg: string, extra?: Record<string, unknown>) => emit("warn", msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) => emit("error", msg, extra),
};

export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/** JSON.stringify that turns bigints into decimal strings. */
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

/** Trim trailing zeros of a decimal string, keep at most `maxDp` decimals. */
export function prettyAmount(formatted: string, maxDp = 6): string {
  const [int = "0", frac = ""] = formatted.split(".");
  const f = frac.slice(0, maxDp).replace(/0+$/, "");
  const withSep = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return f ? `${withSep}.${f}` : withSep;
}
