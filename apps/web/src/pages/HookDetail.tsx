import { Icon } from "../icons.tsx";
import { Fragment, useState } from "react";
import { api, type Hook, type HookEvent } from "../api.ts";
import { go, useApp } from "../App.tsx";
import { Alert, CHANNEL_META, Copy, Spinner, StatusBadge, TRIGGER_META, fmtAmount, maskSecretUrl, shortAddr, timeAgo, triggerSummary, useAsync } from "../ui.tsx";

function eventSummary(p: any): string {
  const d = p.data ?? {};
  const who = (x: any) => x?.name ?? shortAddr(x?.address);
  switch (p.type) {
    case "payment.received":
      return `${d.amount?.display} from ${who(d.from)}`;
    case "token.transfer":
      return `${d.amount?.display} ${who(d.from)} → ${who(d.to)}`;
    case "dex.swap":
      return `${d.amountIn?.display} → ${d.amountOut?.display}`;
    case "contract.event":
      return `${d.event}(${Object.keys(d.args ?? {}).slice(0, 3).join(", ")})`;
    case "wallet.activity": {
      const failed = d.status === "failed" ? "FAILED · " : "";
      if (d.kind === "contract_call") return `${failed}${d.direction === "out" ? `called ${who(d.to)}` : `called by ${who(d.from)}`}${d.method ? ` (${d.method})` : ""}`;
      if (d.kind === "contract_deploy") return `${failed}deployed a contract`;
      return `${failed}${d.direction === "in" ? `received ${d.amount?.display} from ${who(d.from)}` : `sent ${d.amount?.display} to ${who(d.to)}`}`;
    }
    case "balance.threshold":
      return `${d.symbol} balance ${d.direction} ${d.threshold}: now ${d.balance?.display}`;
    case "price.threshold":
      return `${d.symbol} ${d.direction} $${d.threshold}: now $${Number(d.priceUsd).toPrecision(4)}`;
    case "name.changed":
      return `${d.name}: ${shortAddr(d.from) || "none"} → ${shortAddr(d.to) || "none"}`;
    case "invoice.paid":
      return `${d.amount?.display} for ${d.invoice?.description || d.invoice?.id} from ${who(d.from)}`;
    case "digest.daily":
      return `${d.count} events · ${(d.totals ?? []).map((t: any) => t.display).join(", ") || "no amounts"}`;
    default:
      return p.type;
  }
}

/** "minAmount" → "Min amount", "sourceHookId" → "Source hook" */
const LABELS: Record<string, string> = { sourceHookId: "Source hook", hourUtc: "Hour (UTC)", minValueUsd: "Min value (USD)", anyToken: "Any token" };
function humanize(k: string): string {
  return LABELS[k] ?? k.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()).replace(/ ([A-Z])/g, (_m, c: string) => ` ${c.toLowerCase()}`);
}

export function HookDetail({ id }: { id: string }) {
  const { reloadMe } = useApp();
  const hook = useAsync(() => api<{ hook: Hook }>("GET", `/hooks/${id}`), [id], 10_000);
  const events = useAsync(() => api<{ events: HookEvent[] }>("GET", `/hooks/${id}/events?limit=100`), [id], 4000);
  const [showSecret, setShowSecret] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; code: number | null; error: string | null; latencyMs: number } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  if (hook.error) return <Alert kind="error">{hook.error}</Alert>;
  if (!hook.data) return <Spinner />;
  const h = hook.data.hook;
  const t = TRIGGER_META[h.trigger.type]!;
  const ch = CHANNEL_META[h.channel.type]!;

  const act = async (fn: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await fn();
      await hook.reload();
      await events.reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div>
      <div className="topbar">
        <div>
          <a href="#/hooks" className="small">
            ← All hooks
          </a>
          <h1 className="row" style={{ gap: 10 }}>
            <span className="hook-icon"><Icon name={t.icon} size={20} /></span> {h.name} {!h.active && <span className="badge">Paused</span>}
          </h1>
          <p className="muted" style={{ margin: 0 }}>
            {t.label}: {triggerSummary(h)}
          </p>
        </div>
        <div className="row">
          <button
            className="btn"
            disabled={testing}
            onClick={async () => {
              setTesting(true);
              setTestResult(null);
              try {
                setTestResult((await api<{ result: any }>("POST", `/hooks/${id}/test`)).result);
              } catch (e) {
                setActionError(e instanceof Error ? e.message : String(e));
              } finally {
                setTesting(false);
              }
            }}
          >
            {testing ? <Spinner /> : <Icon name="send" size={15} />} Send test
          </button>
          <button className="btn" onClick={() => act(() => api("PATCH", `/hooks/${id}`, { active: !h.active }))}>
            {h.active ? "Pause" : "Resume"}
          </button>
          <a className="btn" href={`#/hooks/${id}/edit`}>
            Edit
          </a>
          <button
            className="btn danger"
            onClick={async () => {
              if (!confirm(`Delete “${h.name}”? Its event history is deleted too.`)) return;
              await api("DELETE", `/hooks/${id}`);
              await reloadMe();
              go("/hooks");
            }}
          >
            Delete
          </button>
        </div>
      </div>

      {testResult && (
        <div style={{ marginBottom: 16 }}>
          {testResult.ok ? (
            <Alert kind="ok">
              Test delivered{testResult.code ? ` (HTTP ${testResult.code})` : ""} in {testResult.latencyMs} ms. Check your {ch.label.toLowerCase()}.
            </Alert>
          ) : (
            <Alert kind="error">Test failed: {testResult.error}</Alert>
          )}
        </div>
      )}
      {actionError && (
        <div style={{ marginBottom: 16 }}>
          <Alert kind="error">{actionError}</Alert>
        </div>
      )}

      <div className="grid two">
        <div className="card">
          <h3>Trigger</h3>
          <dl className="kv">
            <dt>Type</dt>
            <dd>{t.label}</dd>
            {Object.entries(h.trigger.config)
              .filter(([, v]) => v !== undefined && v !== "" && !(typeof v === "object" && v && Object.keys(v).length === 0))
              .map(([k, v]) => (
                <div key={k} style={{ display: "contents" }}>
                  <dt>{humanize(k)}</dt>
                  <dd className="mono">{Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : /amount|below|above|minValue/i.test(k) ? fmtAmount(v) : String(v)}</dd>
                </div>
              ))}
            {Object.entries(h.trigger.resolved).map(([k, v]) =>
              v ? (
                <div key={`r-${k}`} style={{ display: "contents" }}>
                  <dt>{humanize(k)} resolves to</dt>
                  <dd className="mono">{v}</dd>
                </div>
              ) : null,
            )}
          </dl>
        </div>
        <div className="card">
          <h3>Destination</h3>
          <dl className="kv">
            <dt>Channel</dt>
            <dd>
              <Icon name={ch.icon} size={14} /> {ch.label}
            </dd>
            {h.channel.type !== "telegram" && (
              <>
                <dt>URL</dt>
                <dd className="mono">{maskSecretUrl(String(h.channel.config.url))}</dd>
              </>
            )}
            {h.channel.type === "webhook" && (
              <>
                <dt>Signing secret</dt>
                <dd>
                  <div className="row">
                    <span className="mono">{showSecret ? h.secret : "whsec_••••••••••••"}</span>
                    <button className="btn sm" onClick={() => setShowSecret(!showSecret)}>
                      {showSecret ? "Hide" : "Reveal"}
                    </button>
                    <Copy text={h.secret} />
                    <button
                      className="btn sm"
                      onClick={() => {
                        if (confirm("Rotate the secret? Your receiver must use the new one right away.")) void act(() => api("POST", `/hooks/${id}/rotate-secret`));
                      }}
                    >
                      Rotate
                    </button>
                  </div>
                </dd>
              </>
            )}
            <dt>Fired</dt>
            <dd>
              {h.fireCount > 0 ? `${h.fireCount.toLocaleString()} time${h.fireCount === 1 ? "" : "s"} · last ${timeAgo(h.lastFiredAt)}` : "Not fired yet"}
            </dd>
            <dt>Hook id</dt>
            <dd className="mono">{h.id}</dd>
          </dl>
        </div>
      </div>

      <div className="card">
        <div className="row between">
          <h2 style={{ margin: 0 }}>Events</h2>
          <span className="row small faint">
            <span className="dot live" style={{ color: "var(--good)" }} /> refreshing
          </span>
        </div>
        {events.data && events.data.events.length === 0 && (
          <div className="empty">
            <p>No events yet. They appear here within seconds of the block that triggers them.</p>
            <p className="small">Use “Send test” to check your destination now.</p>
          </div>
        )}
        {events.data && events.data.events.length > 0 && (
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Event</th>
                  <th>Delivery</th>
                  <th>Tx</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {events.data.events.map((e) => (
                  <Fragment key={e.id}>
                    <tr>
                      <td className="small" style={{ whiteSpace: "nowrap" }}>{timeAgo(e.createdAt)}</td>
                      <td>
                        <div className="small faint mono">{e.type}</div>
                        <div>{eventSummary(e.payload)}</div>
                        {e.payload?.data?.token?.warning && <span className="badge warn">Unofficial token</span>}
                      </td>
                      <td>
                        {e.delivery ? (
                          <div className="stack" style={{ gap: 2 }}>
                            <StatusBadge status={e.delivery.status} />
                            <span className="small faint">
                              {e.delivery.attempts} attempt{e.delivery.attempts === 1 ? "" : "s"}
                              {e.delivery.responseCode ? ` · ${e.delivery.responseCode}` : ""}
                              {e.delivery.latencyMs != null ? ` · ${e.delivery.latencyMs} ms` : ""}
                            </span>
                            {e.delivery.error && <span className="small" style={{ color: "var(--bad)" }}>{e.delivery.error}</span>}
                            {e.delivery.status === "pending" && e.delivery.attempts > 0 && <span className="small faint">next try {new Date(e.delivery.nextAttemptAt * 1000).toLocaleTimeString()}</span>}
                          </div>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="small">
                        {e.payload?.tx?.hash && e.payload.type !== "test" ? (
                          <a href={e.payload.tx.explorerUrl} target="_blank" rel="noreferrer" className="mono">
                            {shortAddr(e.payload.tx.hash)}
                          </a>
                        ) : (
                          "—"
                        )}
                        {e.payload?.tx ? <div className="faint">#{e.payload.tx.blockNumber}</div> : <div className="faint">scheduled</div>}
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        <button className="btn sm" onClick={() => setOpen(open === e.id ? null : e.id)}>
                          {open === e.id ? "Hide" : "JSON"}
                        </button>{" "}
                        <button className="btn sm" onClick={() => act(() => api("POST", `/events/${e.id}/replay`))} title="Send this event again">
                          Replay
                        </button>
                      </td>
                    </tr>
                    {open === e.id && (
                      <tr>
                        <td colSpan={5}>
                          <pre className="code" style={{ maxHeight: 360 }}>{JSON.stringify(e.payload, null, 2)}</pre>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
