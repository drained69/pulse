import { api, type Status } from "../api.ts";
import { Alert, Spinner, useAsync } from "../ui.tsx";
import { SignInButton } from "./Landing.tsx";
import { useApp } from "../App.tsx";

export function StatusPage() {
  const { me } = useApp();
  const { data, error } = useAsync(() => api<Status>("GET", "/status"), [], 4000);
  if (error) return <Alert kind="error">{error}</Alert>;
  if (!data) return <Spinner />;
  const ix = data.indexer;
  const best = Math.max(...data.rpc.map((r) => r.lastBlock ?? 0));
  const d = data.deliveries24h;

  return (
    <div>
      <div className="topbar">
        <div>
          <h1>QIE network status</h1>
          <p className="muted" style={{ margin: 0 }}>
            Live health of the five public QIE {data.network} RPC nodes, checked every 15 seconds, and of the QIE Hooks indexer.
          </p>
        </div>
        {!me && <SignInButton />}
      </div>

      <div className="grid four">
        <div className="card stat">
          <div className="l">Indexed block</div>
          <div className="n mono" style={{ fontSize: "1.3rem" }}>{ix.cursor?.toLocaleString() ?? "…"}</div>
          <div className="small faint">head {ix.head?.toLocaleString() ?? "…"}</div>
        </div>
        <div className="card stat">
          <div className="l">Lag</div>
          <div className="n" style={{ color: (ix.lagBlocks ?? 0) > 20 ? "var(--warn)" : "var(--good)" }}>
            {ix.lagBlocks ?? "…"} <span style={{ fontSize: "1rem" }}>blocks</span>
          </div>
        </div>
        <div className="card stat">
          <div className="l">Deliveries (24h)</div>
          <div className="n">{((d.success ?? 0) + (d.failed ?? 0) + (d.pending ?? 0)).toLocaleString()}</div>
          <div className="small faint">{d.successRate != null ? `${d.successRate}% delivered` : "no deliveries yet"}</div>
        </div>
        <div className="card stat">
          <div className="l">Avg delivery</div>
          <div className="n">{d.avgLatencyMs != null ? `${d.avgLatencyMs} ms` : "—"}</div>
        </div>
      </div>

      {ix.lastError && (
        <div style={{ marginTop: 16 }}>
          <Alert kind="warn">Indexer: {ix.lastError}</Alert>
        </div>
      )}

      <div className="card" style={{ marginTop: 16 }}>
        <h2>RPC nodes</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Endpoint</th>
                <th>Health</th>
                <th>Latency</th>
                <th>Block</th>
                <th>Behind</th>
                <th>Last error</th>
              </tr>
            </thead>
            <tbody>
              {data.rpc.map((r) => (
                <tr key={r.url}>
                  <td className="mono">{r.url.replace(/^https?:\/\//, "")}</td>
                  <td>
                    <span className={`badge ${r.healthy ? "good" : "bad"}`}>
                      <span className="dot" /> {r.healthy ? "Healthy" : "Down"}
                    </span>
                  </td>
                  <td>{r.latencyMs != null ? `${r.latencyMs} ms` : "—"}</td>
                  <td className="mono">{r.lastBlock?.toLocaleString() ?? "—"}</td>
                  <td>{r.lastBlock != null ? best - r.lastBlock : "—"}</td>
                  <td className="small faint">{r.lastError ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small faint" style={{ marginTop: 10 }}>
          QIE Hooks sends each request to the fastest healthy node and fails over to the next one. A node more than 5 blocks behind is marked down.
        </p>
      </div>

      <div className="grid three" style={{ marginTop: 16 }}>
        <div className="card stat">
          <div className="l">Active hooks</div>
          <div className="n">{data.totals.hooks}</div>
        </div>
        <div className="card stat">
          <div className="l">Developers</div>
          <div className="n">{data.totals.users}</div>
        </div>
        <div className="card stat">
          <div className="l">Events matched</div>
          <div className="n">{data.totals.events.toLocaleString()}</div>
        </div>
      </div>
    </div>
  );
}
