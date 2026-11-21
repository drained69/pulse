import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./icons.tsx";

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[], refreshMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const reload = useCallback(async () => {
    try {
      const d = await fnRef.current();
      setData(d);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    setLoading(true);
    void reload();
    if (!refreshMs) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void reload();
    }, refreshMs);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error, loading, reload, setData };
}

/** "10000.5" -> "10,000.5" (keeps the decimals as typed). */
export function fmtAmount(v: unknown): string {
  const s = String(v ?? "");
  if (!/^\d+(\.\d+)?$/.test(s)) return s;
  const [i, f] = s.split(".");
  return `${i!.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${f ? `.${f}` : ""}`;
}

/** Discord webhook URLs carry a secret in the path: show the host and an id prefix only. */
export function maskSecretUrl(u: string): string {
  const m = u.match(/^(https:\/\/(?:ptb\.|canary\.)?(?:discord|discordapp)\.com\/api\/webhooks\/)(\d+)\/.+$/);
  return m ? `${m[1]}${m[2]!.slice(0, 6)}…/••••••` : u;
}

export function shortAddr(a?: string | null): string {
  if (!a) return "";
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export function timeAgo(sec: number | null | undefined): string {
  if (!sec) return "never";
  const d = Math.floor(Date.now() / 1000) - sec;
  if (d < 5) return "just now";
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

export function Copy({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn sm"
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
    >
      {done ? "Copied" : label}
    </button>
  );
}

export function Alert({ kind = "info", children }: { kind?: "info" | "error" | "ok" | "warn"; children: ReactNode }) {
  return <div className={`alert ${kind}`}>{children}</div>;
}

export function Spinner() {
  return <span className="spin" aria-label="Loading" />;
}

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = { success: "good", failed: "bad", pending: "warn", skipped: "" };
  const label: Record<string, string> = { success: "Delivered", failed: "Failed", pending: "Retrying", skipped: "Over quota" };
  return <span className={`badge ${map[status] ?? ""}`}>{label[status] ?? status}</span>;
}

export const TRIGGER_META: Record<string, { icon: string; label: string; desc: string }> = {
  payment: { icon: "incoming", label: "Payment received", desc: "QIE or QUSDC lands at a name.qie or address" },
  token_transfer: { icon: "transfer", label: "Token transfer", desc: "Any transfer of a token, e.g. large QUSDC moves" },
  swap: { icon: "swap", label: "QIEDEX swap", desc: "Trades on a QIEDEX pair, with USD value" },
  contract_event: { icon: "megaphone", label: "Contract event", desc: "Any events from any contract, decoded" },
  wallet: { icon: "wallet", label: "Wallet activity", desc: "Everything in and out of an address, failed txs too" },
  balance: { icon: "battery", label: "Balance alert", desc: "A balance goes below or above an amount" },
  price: { icon: "trending", label: "Price alert", desc: "A QIEDEX price crosses a level" },
  name_watch: { icon: "id", label: "QIE ID watch", desc: "A name.qie starts pointing elsewhere" },
  daily_digest: { icon: "calendar", label: "Daily summary", desc: "Once a day: totals from another hook" },
  invoice: { icon: "receipt", label: "Payment link paid", desc: "One of your payment links or products is paid" },
  liquidity: { icon: "alert", label: "Rug-pull radar", desc: "A QIEDEX pair loses a big share of its liquidity" },
};

export const CHANNEL_META: Record<string, { icon: string; label: string }> = {
  webhook: { icon: "link", label: "Webhook" },
  telegram: { icon: "send", label: "Telegram" },
  discord: { icon: "chat", label: "Discord" },
};

export function triggerSummary(h: { trigger: { type: string; config: Record<string, any>; resolved: Record<string, string> } }): string {
  const c = h.trigger.config;
  switch (h.trigger.type) {
    case "payment":
      return `${(c.assets ?? []).join(" / ")}${c.anyToken ? " + any token" : ""} to ${c.recipient}${c.minAmount ? ` · min ${fmtAmount(c.minAmount)}` : ""}`;
    case "token_transfer":
      return `${c.token.length > 10 ? shortAddr(c.token) : c.token}${c.from ? ` from ${c.from}` : ""}${c.to ? ` to ${c.to}` : ""}${c.minAmount ? ` · ≥ ${fmtAmount(c.minAmount)}` : ""}`;
    case "swap":
      return `Pair ${shortAddr(c.pair)}${c.minValueUsd ? ` · ≥ $${fmtAmount(c.minValueUsd)}` : ""}`;
    case "contract_event": {
      const sigs: string[] = [...(c.event ? [c.event] : []), ...(c.events ?? [])];
      const names = [...new Set(sigs.map((x) => x.replace(/^event\s+/, "").split("(")[0]))];
      return `${names.slice(0, 3).join(", ")}${names.length > 3 ? ` +${names.length - 3}` : ""}${c.address ? ` on ${shortAddr(c.address)}` : " on any contract"}`;
    }
    case "wallet":
      return `${c.address} · ${c.direction === "in" ? "incoming" : c.direction === "out" ? "outgoing" : "in and out"}${c.includeFailed === false ? "" : " · incl. failed"}`;
    case "balance":
      return `${c.asset} of ${c.address} ${c.below ? `below ${c.below}` : `above ${c.above}`}`;
    case "price":
      return `${c.token} ${c.below !== undefined ? `below $${c.below}` : `above $${c.above}`}`;
    case "name_watch":
      return c.name;
    case "daily_digest":
      return `at ${String(c.hourUtc ?? 8).padStart(2, "0")}:00 UTC`;
    case "invoice":
      return "any of your payment links";
    case "liquidity":
      return `pair ${shortAddr(c.pair)} · liquidity −${c.dropPercent ?? 30}% from its 24 h peak`;
    default:
      return "";
  }
}

// ───────── theme (light / dark / follow the system) ─────────

type Theme = "light" | "dark" | null;
const THEME_KEY = "qp-theme";

function storedTheme(): Theme {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === "light" || t === "dark" ? t : null;
  } catch {
    return null;
  }
}

function applyTheme(t: Theme): void {
  if (t) document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

export function initTheme(): void {
  applyTheme(storedTheme());
}

export function ThemeToggle() {
  const isDark = () => {
    const t = storedTheme();
    return t ? t === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
  };
  const [dark, setDark] = useState(isDark);
  return (
    <button
      type="button"
      className="theme-toggle"
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
      title={dark ? "Light theme" : "Dark theme"}
      onClick={() => {
        const next: Theme = dark ? "light" : "dark";
        try {
          localStorage.setItem(THEME_KEY, next);
        } catch {
          /* private mode: still switch for this visit */
        }
        applyTheme(next);
        setDark(!dark);
      }}
    >
      <Icon name={dark ? "sun" : "moon"} size={17} />
    </button>
  );
}
