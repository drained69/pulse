import { Icon } from "../icons.tsx";
import { api, type Hook } from "../api.ts";
import { go, useApp } from "../App.tsx";
import { TEMPLATES } from "../templates.ts";
import { Alert, CHANNEL_META, Spinner, TRIGGER_META, timeAgo, triggerSummary, useAsync } from "../ui.tsx";

export function Hooks() {
  const { me } = useApp();
  const { data, error, loading } = useAsync(() => api<{ hooks: Hook[] }>("GET", "/hooks"), [], 8000);
  const hooks = data?.hooks ?? [];
  const atLimit = me ? me.usage.hooks >= me.plan.maxHooks : false;

  return (
    <div>
      <div className="topbar">
        <div>
          <h1>Hooks</h1>
          <p className="muted" style={{ margin: 0 }}>
            Each hook watches QIE for one thing and tells one place: Telegram, Discord or your server. New here? See the <a href="#/guide">guide</a>.
          </p>
        </div>
        <button className="btn primary" onClick={() => go("/hooks/new")} disabled={atLimit} title={atLimit ? "Plan limit reached" : ""}>
          + New hook
        </button>
      </div>

      {me && (
        <div className="grid four" style={{ marginBottom: 20 }}>
          <div className="card stat">
            <div className="l">Hooks</div>
            <div className="n">
              {me.usage.hooks}
              <span className="faint" style={{ fontSize: "1rem" }}> / {me.plan.maxHooks}</span>
            </div>
          </div>
          <div className="card stat">
            <div className="l">Events this month</div>
            <div className="n">
              {me.usage.eventsThisMonth.toLocaleString()}
              <span className="faint" style={{ fontSize: "1rem" }}> / {me.plan.monthlyEvents.toLocaleString()}</span>
            </div>
          </div>
          <div className="card stat">
            <div className="l">Delivered</div>
            <div className="n">{hooks.reduce((a, h) => a + (h.stats?.success ?? 0), 0).toLocaleString()}</div>
          </div>
          <div className="card stat">
            <div className="l">Failed</div>
            <div className="n" style={{ color: hooks.some((h) => (h.stats?.failed ?? 0) > 0) ? "var(--bad)" : undefined }}>
              {hooks.reduce((a, h) => a + (h.stats?.failed ?? 0), 0)}
            </div>
          </div>
        </div>
      )}

      {atLimit && (
        <div style={{ marginBottom: 16 }}>
          <Alert kind="warn">
            You have used all {me?.plan.maxHooks} hooks on the {me?.plan.label} plan. <a href="#/billing">Upgrade to Pro</a> for more.
          </Alert>
        </div>
      )}
      {error && <Alert kind="error">{error}</Alert>}
      {loading && !data && <Spinner />}

      {data && hooks.length === 0 && (
        <div className="card empty">
          <div className="big"><Icon name="zap" size={34} /></div>
          <h2>No hooks yet</h2>
          <p>
            A hook watches QIE for you and tells you the moment something happens. Start from a template, or build your own. Not sure where to start? The{" "}
            <a href="#/guide">step-by-step guide</a> walks through each case.
          </p>
          <div className="tiles" style={{ textAlign: "left", marginTop: 16 }}>
            {TEMPLATES.slice(0, 6).map((t) => (
              <button key={t.id} type="button" className="tile" onClick={() => go(`/hooks/new/${t.id}`)}>
                <div className="t">
                  <Icon name={t.icon} /> {t.title}
                </div>
                <div className="d">{t.desc}</div>
              </button>
            ))}
          </div>
          <button className="btn primary" style={{ marginTop: 16 }} onClick={() => go("/hooks/new")}>
            See all templates
          </button>
        </div>
      )}

      <div className="stack">
        {hooks.map((h) => {
          const t = TRIGGER_META[h.trigger.type]!;
          const ch = CHANNEL_META[h.channel.type]!;
          return (
            <div key={h.id} className="card hook-card" onClick={() => go(`/hooks/${h.id}`)} role="link" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && go(`/hooks/${h.id}`)}>
              <div className="hook-icon"><Icon name={t.icon} size={20} /></div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="row between">
                  <div className="row">
                    <b>{h.name}</b>
                    {!h.active && <span className="badge">Paused</span>}
                  </div>
                  <span className="small faint">{h.lastFiredAt ? `Last fired ${timeAgo(h.lastFiredAt)}` : "Not fired yet"}</span>
                </div>
                <div className="muted small" style={{ marginTop: 2, overflow: "hidden", textOverflow: "ellipsis" }}>
                  {t.label}: {triggerSummary(h)}
                </div>
                <div className="row small" style={{ marginTop: 8 }}>
                  <span className="badge">
                    <Icon name={ch.icon} size={14} /> {ch.label}
                  </span>
                  <span className={`badge ${(h.stats?.success ?? 0) > 0 ? "good" : ""}`}>{(h.stats?.success ?? 0).toLocaleString()} delivered</span>
                  {(h.stats?.pending ?? 0) > 0 && <span className="badge warn">{h.stats?.pending} retrying</span>}
                  {(h.stats?.failed ?? 0) > 0 && <span className="badge bad">{h.stats?.failed} failed</span>}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
