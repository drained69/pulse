import { api, type LatencyStats, type Status } from "../api.ts";
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
            Live health of the five public QIE {data.network} RPC nodes, checked every 15 seconds, and of the Q-Pulse indexer.
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

      <LatencyCard latency={data.latency} />

      <div className="card" style={{ marginTop: 16 }}>
        <h2>WebSocket RPC</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          QIE's nodes reject <code>eth_subscribe</code>. Point any viem, ethers or web3 client at{" "}
          <code className="mono">{wsUrl()}</code> and <code>watchContractEvent</code> / <code>contract.on()</code> just work.
        </p>
        <div className="grid four">
          <div className="stat">
            <div className="l">Connections</div>
            <div className="n">{data.stream.connections}</div>
          </div>
          <div className="stat">
            <div className="l">Live subscriptions</div>
            <div className="n">{data.stream.subscribers}</div>
            <div className="small faint">{data.stream.filters} HTTP filters</div>
          </div>
          <div className="stat">
            <div className="l">Blocks streamed</div>
            <div className="n">{data.stream.blocksStreamed.toLocaleString()}</div>
            <div className="small faint">{data.stream.lastBlock ? `last #${data.stream.lastBlock.toLocaleString()}` : "idle until someone subscribes"}</div>
          </div>
          <div className="stat">
            <div className="l">Notifications sent</div>
            <div className="n">{data.stream.notifications.toLocaleString()}</div>
          </div>
        </div>
      </div>

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
          Q-Pulse sends each request to the fastest healthy node and fails over to the next one. A node more than 5 blocks behind is marked down.
        </p>
      </div>

      <Attestations />

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

function wsUrl(): string {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/rpc`;
}

const STEPS: { key: keyof Status["latency"]; label: string; hint: string }[] = [
  { key: "stream", label: "Block → WebSocket subscribers", hint: "newHeads / logs pushed over wss://…/rpc" },
  { key: "detect", label: "Block → event detected", hint: "matched to a hook and stored" },
  { key: "deliver", label: "Block → delivered", hint: "your webhook, Telegram or Discord accepted it (first attempt)" },
];

const fmt = (ms: number | null) => (ms == null ? "—" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

function LatencyCard({ latency }: { latency: Status["latency"] }) {
  const scale = Math.max(5000, ...STEPS.map((s) => latency[s.key].p95 ?? 0));
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h2>End-to-end latency (last 24 h)</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        Measured from each block's on-chain timestamp, so it includes the time QIE's own nodes take to serve a new block. Block timestamps have
        1-second resolution, so these are upper bounds.
      </p>
      <div style={{ display: "grid", gap: 14 }}>
        {STEPS.map((s) => (
          <LatencyRow key={s.key} label={s.label} hint={s.hint} st={latency[s.key]} scale={scale} />
        ))}
      </div>
    </div>
  );
}

function LatencyRow({ label, hint, st, scale }: { label: string; hint: string; st: LatencyStats; scale: number }) {
  const w = (ms: number | null) => `${Math.min(100, ((ms ?? 0) / scale) * 100)}%`;
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <strong>{label}</strong> <span className="small faint">{hint}</span>
        </div>
        <div className="mono small">
          p50 <strong>{fmt(st.p50)}</strong> · p95 {fmt(st.p95)} · p99 {fmt(st.p99)} · <span className="faint">{st.count.toLocaleString()} samples</span>
        </div>
      </div>
      <div style={{ position: "relative", height: 8, borderRadius: 4, background: "var(--accent-soft)", marginTop: 6, overflow: "hidden" }}>
        <div style={{ position: "absolute", inset: 0, width: w(st.p95), background: "var(--accent)", opacity: 0.3 }} />
        <div style={{ position: "absolute", inset: 0, width: w(st.p50), background: "var(--accent)" }} />
      </div>
    </div>
  );
}

type AttestationList = {
  contract: string | null;
  explorerUrl: string;
  anchoring: boolean;
  attestations: { epoch: number; date: string; root: string; leaves: number; snapshotBlock: number; status: string; txHash: string | null }[];
};

function Attestations() {
  const { data } = useAsync(() => api<AttestationList>("GET", "/attestations?limit=7"), [], 60_000);
  if (!data || data.attestations.length === 0) return null;
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h2>Traction attestations</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        Once a day every project's 30-day numbers go into a Merkle tree whose root is posted to{" "}
        {data.contract ? (
          <a className="mono" href={`${data.explorerUrl}/address/${data.contract}`} target="_blank" rel="noreferrer">
            PulseAttestations
          </a>
        ) : (
          "the attestation contract"
        )}
        . Each traction page can be checked against it in the browser or with the CLI.
      </p>
      <div className="table-wrap">
        <table className="compact">
          <thead>
            <tr>
              <th>Day</th>
              <th>Projects</th>
              <th>Snapshot block</th>
              <th>Root</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {data.attestations.map((a) => (
              <tr key={a.epoch}>
                <td>{a.date}</td>
                <td>{a.leaves}</td>
                <td className="mono">{a.snapshotBlock.toLocaleString()}</td>
                <td className="mono small">{a.root.slice(0, 18)}…</td>
                <td>
                  {a.txHash ? (
                    <a href={`${data.explorerUrl}/tx/${a.txHash}`} target="_blank" rel="noreferrer">
                      <span className={`badge ${a.status === "anchored" ? "good" : ""}`}>{a.status}</span>
                    </a>
                  ) : (
                    <span className="badge">{a.status}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
