import { useState } from "react";
import { createPublicClient, http, type Hex } from "viem";
import { ATTESTATIONS_ABI, epochDate, leafHash, processProof, recountFromExplorer, type LeafData } from "../../../server/src/attest-core.ts";
import { ApiError, api } from "../api.ts";
import { go, useApp } from "../App.tsx";
import { Alert, Copy, shortAddr, Spinner, timeAgo, useAsync } from "../ui.tsx";
import { SignInButton } from "./Landing.tsx";

export type ProjectSummary = { txs: number; wallets: number; txs7d: number; wallets7d: number };
export type MyProject = {
  id: string;
  slug: string;
  name: string;
  description: string;
  website: string | null;
  contracts: string[];
  verifiedBy: string | null;
  public: boolean;
  backfill: { status: string; error: string | null };
  createdAt: number;
  summary: ProjectSummary;
};
type Board = { rank: number; slug: string; name: string; description: string; verified: boolean; wallets7d: number; txs7d: number; wallets: number; txs: number };
type Window = { txs: number; wallets: number };
type ProjectView = {
  project: Omit<MyProject, "id" | "summary" | "public"> & { listed: boolean };
  owner: { address: string; qieName: string | null };
  stats: {
    totals: { txs: number; wallets: number; failedTxs: number; returningWallets: number; topWalletsShare: number; qieValue: number; since: number | null };
    last24h: Window;
    last7d: Window;
    last30d: Window;
    series: { date: string; txs: number; wallets: number; newWallets: number }[];
    recent: { txHash: string; wallet: string; contract: string; ts: number; ok: boolean; method: string | null }[];
  };
  indexedBlock: number | null;
  backfillDays: number;
};

const n = (x: number) => x.toLocaleString();
const pageUrl = (slug: string) => `${window.location.origin}/#/p/${slug}`;
const badgeUrl = (slug: string) => `${window.location.origin}/api/projects/${slug}/badge.svg`;

function Verified({ by }: { by: string | null }) {
  if (!by) return null;
  return (
    <span className="badge good" title={by === "deployer" ? "Created by the wallet that deployed the contract" : "Created by the contract's owner()"}>
      ✓ Verified {by === "deployer" ? "deployer" : "owner"}
    </span>
  );
}

/** 30-day bar chart. Plain SVG: no chart library, works in both themes. */
function Bars({ series, metric }: { series: ProjectView["stats"]["series"]; metric: "wallets" | "txs" | "newWallets" }) {
  const max = Math.max(1, ...series.map((d) => d[metric]));
  const w = 600;
  const h = 140;
  const bw = w / series.length;
  return (
    <svg className="bars" viewBox={`0 0 ${w} ${h + 18}`} role="img" aria-label={`Daily ${metric}, last 30 days`}>
      {series.map((d, i) => {
        const bh = (d[metric] / max) * h;
        return (
          <g key={d.date}>
            <rect x={i * bw + 2} y={h - bh} width={bw - 4} height={Math.max(bh, d[metric] ? 2 : 0)} rx="2">
              <title>{`${d.date}: ${d[metric].toLocaleString()}`}</title>
            </rect>
            {d[metric] === 0 && <rect className="zero" x={i * bw + 2} y={h - 1} width={bw - 4} height="1" />}
          </g>
        );
      })}
      <text x="0" y={h + 14}>{series[0]?.date.slice(5)}</text>
      <text x={w} y={h + 14} textAnchor="end">
        today
      </text>
      <text x={w} y="10" textAnchor="end">
        max {max.toLocaleString()}
      </text>
    </svg>
  );
}

// ───────── public leaderboard ─────────

export function Leaderboard() {
  const { me } = useApp();
  const { data, error } = useAsync(() => api<{ projects: Board[] }>("GET", "/projects"), [], 15000);
  return (
    <div>
      <div className="topbar">
        <div>
          <h1>QIE traction leaderboard</h1>
          <p className="muted" style={{ margin: 0 }}>
            Projects on QIE ranked by distinct wallets using their contracts in the last 7 days. Counted live from the chain, so anyone can check the numbers.
          </p>
        </div>
        {me ? (
          <a className="btn primary" href="#/projects/new">
            Add your project
          </a>
        ) : (
          <SignInButton label="Sign in to add your project" next="/projects/new" />
        )}
      </div>
      {error && <Alert kind="error">{error}</Alert>}
      {!data && !error && <Spinner />}
      {data && data.projects.length === 0 && (
        <div className="card empty">
          <div className="big">📈</div>
          <p>No projects yet. Be the first: add your contracts and get a live traction page and README badge.</p>
        </div>
      )}
      {data && data.projects.length > 0 && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Project</th>
                  <th style={{ textAlign: "right" }}>Wallets 7d</th>
                  <th style={{ textAlign: "right" }}>Txs 7d</th>
                  <th style={{ textAlign: "right" }}>All wallets</th>
                  <th style={{ textAlign: "right" }}>All txs</th>
                </tr>
              </thead>
              <tbody>
                {data.projects.map((p) => (
                  <tr key={p.slug} className="clickable" onClick={() => go(`p/${p.slug}`)}>
                    <td className="rank">{p.rank}</td>
                    <td>
                      <a href={`#/p/${p.slug}`} style={{ fontWeight: 600 }}>
                        {p.name}
                      </a>{" "}
                      {p.verified && <span className="badge good">✓</span>}
                      {p.description && <div className="small muted">{p.description}</div>}
                    </td>
                    <td className="num strong">{n(p.wallets7d)}</td>
                    <td className="num">{n(p.txs7d)}</td>
                    <td className="num">{n(p.wallets)}</td>
                    <td className="num">{n(p.txs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ───────── public project page ─────────

function ClaimBox({ slug, onClaimed }: { slug: string; onClaimed: () => void }) {
  const { me } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h2>Is this your project?</h2>
      <p className="small muted">
        Claim this page to edit it and get the <b>Verified</b> badge. Sign in with the wallet that deployed one of these contracts (or its <code>owner()</code>).
      </p>
      {me ? (
        <button
          className="btn primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await api("POST", `/projects/${slug}/claim`);
              onClaimed();
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? <Spinner /> : null} Claim this page as {shortAddr(me.user.address)}
        </button>
      ) : (
        <SignInButton label="Sign in to claim this page" next={null} />
      )}
      {error && (
        <div style={{ marginTop: 10 }}>
          <Alert kind="error">{error}</Alert>
        </div>
      )}
    </div>
  );
}

export function ProjectPage({ slug }: { slug: string }) {
  const { config, me } = useApp();
  const [metric, setMetric] = useState<"wallets" | "txs" | "newWallets">("wallets");
  const { data, error, reload } = useAsync(() => api<ProjectView>("GET", `/projects/${slug}`), [slug], 10000);
  if (error) return <Alert kind="error">{error}</Alert>;
  if (!data) return <Spinner />;
  const { project: p, stats: st, owner } = data;
  const t = st.totals;
  const tx = (h: string) => `${config.explorerUrl}/tx/${h}`;
  const addr = (a: string) => `${config.explorerUrl}/address/${a}`;
  const isOwner = me && me.user.address.toLowerCase() === owner.address.toLowerCase();

  return (
    <div>
      <div className="topbar">
        <div>
          <div className="row" style={{ gap: 8 }}>
            <h1 style={{ margin: 0 }}>{p.name}</h1>
            <Verified by={p.verifiedBy} />
            {!p.listed && <span className="badge">Unlisted</span>}
          </div>
          {p.description && <p className="muted" style={{ margin: "6px 0 0" }}>{p.description}</p>}
          <div className="small faint" style={{ marginTop: 6 }}>
            {p.verifiedBy ? `by ${owner.qieName ?? shortAddr(owner.address)}` : "Not yet claimed by the project team · data read from the chain"}
            {p.website && (
              <>
                {" · "}
                <a href={p.website} target="_blank" rel="noopener noreferrer nofollow">
                  {p.website.replace(/^https?:\/\//, "").replace(/\/$/, "")}
                </a>
              </>
            )}
          </div>
        </div>
        <div className="row">
          <span className="badge good">
            <span className="dot live" /> Live
          </span>
          <a className="btn ghost" href="#/explore">
            Leaderboard
          </a>
        </div>
      </div>

      {(p.backfill.status === "pending" || p.backfill.status === "running") && (
        <div style={{ marginBottom: 16 }}>
          <Alert kind="info">
            <Spinner /> Importing the last {data.backfillDays} days of history from the QIE explorer…
          </Alert>
        </div>
      )}
      {p.backfill.status === "failed" && (
        <div style={{ marginBottom: 16 }}>
          <Alert kind="warn">History import failed ({p.backfill.error}). New activity is still counted live.</Alert>
        </div>
      )}

      <div className="grid four">
        <div className="card stat">
          <div className="l">Wallets · 7 days</div>
          <div className="n">{n(st.last7d.wallets)}</div>
          <div className="small faint">{n(st.last24h.wallets)} in the last 24 h</div>
        </div>
        <div className="card stat">
          <div className="l">Transactions · 7 days</div>
          <div className="n">{n(st.last7d.txs)}</div>
          <div className="small faint">{n(st.last24h.txs)} in the last 24 h</div>
        </div>
        <div className="card stat">
          <div className="l">All-time wallets</div>
          <div className="n">{n(t.wallets)}</div>
          <div className="small faint">{n(t.returningWallets)} came back on another day</div>
        </div>
        <div className="card stat">
          <div className="l">All-time transactions</div>
          <div className="n">{n(t.txs)}</div>
          <div className="small faint">
            {t.failedTxs ? `${n(t.failedTxs)} failed (not counted)` : "no failed txs"}
            {t.qieValue ? ` · ${t.qieValue.toLocaleString()} QIE sent` : ""}
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="row between">
          <h2 style={{ margin: 0 }}>Last 30 days</h2>
          <div className="seg">
            {(
              [
                ["wallets", "Active wallets"],
                ["newWallets", "New wallets"],
                ["txs", "Transactions"],
              ] as const
            ).map(([k, label]) => (
              <button key={k} className={metric === k ? "on" : ""} onClick={() => setMetric(k)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <Bars series={st.series} metric={metric} />
        <p className="small faint" style={{ margin: 0 }}>
          {t.wallets > 10
            ? `Concentration: the 10 most active wallets made ${t.topWalletsShare}% of all transactions${t.topWalletsShare > 80 ? " (activity is dominated by a few wallets)" : ""}.`
            : t.wallets > 0
              ? `${t.wallets} wallet${t.wallets === 1 ? "" : "s"} so far${t.wallets === 1 && t.txs > 20 ? ": every transaction comes from the same wallet" : ""}.`
              : "No successful transactions yet."}
        </p>
      </div>

      <OnChainProof slug={p.slug} />

      <div className="stack" style={{ marginTop: 16, gap: 16 }}>
        <div className="card">
          <h2>Latest transactions</h2>
          {st.recent.length === 0 && <p className="muted">No transactions yet.</p>}
          {st.recent.length > 0 && (
            <div className="table-wrap">
              <table className="compact">
                <tbody>
                  {st.recent.map((r) => (
                    <tr key={r.txHash}>
                      <td>
                        <a className="mono" href={tx(r.txHash)} target="_blank" rel="noreferrer">
                          {shortAddr(r.txHash)}
                        </a>
                        {!r.ok && <span className="badge bad" style={{ marginLeft: 6 }}>failed</span>}
                      </td>
                      <td className="mono small">
                        <a href={addr(r.wallet)} target="_blank" rel="noreferrer">
                          {shortAddr(r.wallet)}
                        </a>
                      </td>
                      <td className="small faint" style={{ textAlign: "right" }}>
                        {timeAgo(r.ts)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="card">
          <h2>How this is counted</h2>
          <p className="small muted">
            Every transaction sent directly to these contracts on QIE {config.network}, read from the chain by the Q-Pulse indexer
            {data.indexedBlock ? ` (now at block ${n(data.indexedBlock)})` : ""}. History before the page was created comes from the QIE explorer
            {t.since ? `, back to ${new Date(t.since * 1000).toISOString().slice(0, 10)}` : ""}. Failed transactions are not counted.
          </p>
          <dl className="kv">
            {p.contracts.map((c, i) => (
              <div key={c} style={{ display: "contents" }}>
                <dt>Contract {p.contracts.length > 1 ? i + 1 : ""}</dt>
                <dd>
                  <a className="mono" href={addr(c)} target="_blank" rel="noreferrer">
                    {c}
                  </a>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2>Share it</h2>
        <div className="row" style={{ marginBottom: 10 }}>
          <img src={`/api/projects/${p.slug}/badge.svg`} alt="QIE traction badge" height={20} />
        </div>
        <div className="stack" style={{ gap: 8 }}>
          <div className="row">
            <code className="mono small grow">{pageUrl(p.slug)}</code>
            <Copy text={pageUrl(p.slug)} label="Copy link" />
          </div>
          <div className="row">
            <code className="mono small grow">{`[![QIE traction](${badgeUrl(p.slug)})](${pageUrl(p.slug)})`}</code>
            <Copy text={`[![QIE traction](${badgeUrl(p.slug)})](${pageUrl(p.slug)})`} label="Copy README badge" />
          </div>
        </div>
        {isOwner && (
          <p className="small" style={{ marginTop: 12 }}>
            <a href="#/projects">Edit this page</a> · <a href="#/hooks/new/wallet">Get a Telegram alert for every new transaction</a>
          </p>
        )}
      </div>
      {!isOwner && !p.verifiedBy && <ClaimBox slug={p.slug} onClaimed={() => void reload()} />}
    </div>
  );
}

// ───────── owner: list, create, edit ─────────

export function MyProjects() {
  const { data, error, reload } = useAsync(() => api<{ projects: MyProject[] }>("GET", "/my/projects"), [], 5000);
  return (
    <div>
      <div className="topbar">
        <div>
          <h1>Traction pages</h1>
          <p className="muted" style={{ margin: 0 }}>
            A public, live page with your project's on-chain users and transactions, plus a badge for your README and hackathon submission.
          </p>
        </div>
        <a className="btn primary" href="#/projects/new">
          New traction page
        </a>
      </div>
      {error && <Alert kind="error">{error}</Alert>}
      {!data && !error && <Spinner />}
      {data && data.projects.length === 0 && (
        <div className="card empty">
          <div className="big">📈</div>
          <p>Show judges, users and investors real usage. Add your contract addresses and the page fills itself from the chain.</p>
          <a className="btn primary" href="#/projects/new">
            Create your traction page
          </a>
        </div>
      )}
      <div className="stack">
        {data?.projects.map((p) => (
          <div className="card" key={p.id}>
            <div className="row between">
              <div>
                <div className="row" style={{ gap: 8 }}>
                  <a href={`#/p/${p.slug}`} style={{ fontWeight: 700, fontSize: "1.05rem" }}>
                    {p.name}
                  </a>
                  <Verified by={p.verifiedBy} />
                  {!p.public && <span className="badge">Unlisted</span>}
                  {p.backfill.status === "running" || p.backfill.status === "pending" ? <span className="badge warn">Importing history…</span> : null}
                  {p.backfill.status === "failed" && <span className="badge bad">History import failed</span>}
                </div>
                <div className="small faint mono">/p/{p.slug}</div>
              </div>
              <div className="row">
                <a className="btn sm" href={`#/projects/${p.id}/edit`}>
                  Edit
                </a>
                {p.backfill.status === "failed" && (
                  <button
                    className="btn sm"
                    onClick={async () => {
                      await api("POST", `/my/projects/${p.id}/backfill`);
                      await reload();
                    }}
                  >
                    Retry import
                  </button>
                )}
                <button
                  className="btn sm danger"
                  onClick={async () => {
                    if (!confirm(`Delete the traction page “${p.name}”? Its link stops working.`)) return;
                    await api("DELETE", `/my/projects/${p.id}`);
                    await reload();
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
            <div className="grid four" style={{ marginTop: 12 }}>
              <div className="stat">
                <div className="l">Wallets 7d</div>
                <div className="n">{n(p.summary.wallets7d)}</div>
              </div>
              <div className="stat">
                <div className="l">Txs 7d</div>
                <div className="n">{n(p.summary.txs7d)}</div>
              </div>
              <div className="stat">
                <div className="l">All wallets</div>
                <div className="n">{n(p.summary.wallets)}</div>
              </div>
              <div className="stat">
                <div className="l">All txs</div>
                <div className="n">{n(p.summary.txs)}</div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ProjectForm({ id }: { id?: string }) {
  const { me } = useApp();
  const existing = useAsync(() => (id ? api<{ project: MyProject }>("GET", `/my/projects/${id}`) : Promise.resolve(null)), [id]);
  const [form, setForm] = useState<{ name: string; slug: string; description: string; website: string; contracts: string; listed: boolean } | null>(id ? null : { name: "", slug: "", description: "", website: "", contracts: "", listed: true });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (id && existing.data && !form) {
    const p = existing.data.project;
    setForm({ name: p.name, slug: p.slug, description: p.description, website: p.website ?? "", contracts: p.contracts.join("\n"), listed: p.public });
  }
  if (!form) return existing.error ? <Alert kind="error">{existing.error}</Alert> : <Spinner />;
  const set = (k: keyof typeof form, v: string | boolean) => setForm({ ...form, [k]: v });

  return (
    <div>
      <div className="topbar">
        <h1>{id ? "Edit traction page" : "New traction page"}</h1>
      </div>
      <form
        className="card stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          setSaving(true);
          try {
            const body = {
              name: form.name,
              slug: form.slug || undefined,
              description: form.description,
              website: form.website,
              contracts: form.contracts.split(/[\s,]+/).filter(Boolean),
              public: form.listed,
            };
            const r = id
              ? await api<{ project: MyProject }>("PATCH", `/my/projects/${id}`, body)
              : await api<{ project: MyProject }>("POST", "/my/projects", body);
            go(`p/${r.project.slug}`);
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          } finally {
            setSaving(false);
          }
        }}
      >
        <label className="field">
          <span>Project name</span>
          <input type="text" required maxLength={60} value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Patungan" />
        </label>
        <label className="field">
          <span>Page address</span>
          <div className="row" style={{ gap: 6 }}>
            <span className="faint mono small">{window.location.host}/#/p/</span>
            <input
              type="text"
              maxLength={40}
              value={form.slug}
              onChange={(e) => set("slug", e.target.value.toLowerCase())}
              placeholder={form.name ? form.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") : "my-project"}
              style={{ flex: 1, minWidth: 160 }}
            />
          </div>
        </label>
        <label className="field">
          <span>One-line description</span>
          <input type="text" maxLength={280} value={form.description} onChange={(e) => set("description", e.target.value)} placeholder="What it does, in a sentence" />
        </label>
        <label className="field">
          <span>Website (optional)</span>
          <input type="text" maxLength={200} value={form.website} onChange={(e) => set("website", e.target.value)} placeholder="https://…" />
        </label>
        <label className="field">
          <span>Contract addresses on QIE (one per line, up to 10)</span>
          <textarea rows={4} required className="mono" value={form.contracts} onChange={(e) => set("contracts", e.target.value)} placeholder="0x…" />
          <span className="hint">
            Every transaction sent to these contracts is counted. Create the page from the wallet that deployed one of them (or its <code>owner()</code>) to get a{" "}
            <b>Verified</b> badge{me ? ` (you're signed in as ${shortAddr(me.user.address)})` : ""}.
          </span>
        </label>
        <label className="check">
          <input type="checkbox" checked={form.listed} onChange={(e) => set("listed", e.target.checked)} /> Show on the public leaderboard
        </label>
        {error && <Alert kind="error">{error}</Alert>}
        <div className="row">
          <button className="btn primary" type="submit" disabled={saving}>
            {saving ? "Checking contracts…" : id ? "Save" : "Create page"}
          </button>
          <a className="btn ghost" href="#/projects">
            Cancel
          </a>
        </div>
      </form>
    </div>
  );
}

// ───────── on-chain proof ─────────

type ProofView = {
  attestation: { epoch: number; date: string; root: Hex; leaves: number; snapshotBlock: number; status: string; txHash: string | null };
  contract: Hex | null;
  chainId: number;
  leaf: LeafData;
  leafHash: Hex;
  proof: Hex[];
  explorerUrl: string;
  explorerApiUrl: string;
  rpcUrls: string[];
};

type Step = { label: string; state: "run" | "ok" | "fail"; detail?: string };

function OnChainProof({ slug }: { slug: string }) {
  const { data, error, loading } = useAsync(
    () => api<ProofView>("GET", `/projects/${slug}/proof`).catch((e) => (e instanceof ApiError && e.status === 404 ? null : Promise.reject(e))),
    [slug],
  );
  const [steps, setSteps] = useState<Step[] | null>(null);
  if (error || loading) return null;
  if (!data)
    return (
      <div className="card" style={{ marginTop: 16 }}>
        <h2>On-chain proof</h2>
        <p className="small muted" style={{ margin: 0 }}>
          Once a day Q-Pulse commits every project's numbers to a contract on QIE, so anyone can check them without trusting us. This page joins the next
          daily snapshot after its history import finishes.
        </p>
      </div>
    );

  const { leaf, attestation: a } = data;
  const anchored = a.status === "anchored";
  const set = (i: number, step: Step) => setSteps((prev) => [...(prev ?? []).slice(0, i), step]);

  async function verify() {
    setSteps([]);
    let ok = true;
    const fail = (i: number, label: string, detail: string) => {
      ok = false;
      set(i, { label, state: "fail", detail });
    };
    try {
      set(0, { label: "Recounting from QIE's explorer", state: "run" });
      const rc = await recountFromExplorer(data!.explorerApiUrl, leaf, { onPage: (n) => set(0, { label: "Recounting from QIE's explorer", state: "run", detail: `page ${n}` }) });
      const same = rc.txCount === leaf.txCount && rc.walletCount === leaf.walletCount && rc.txSetHash === leaf.txSetHash;
      if (same) set(0, { label: "Numbers match QIE's explorer", state: "ok", detail: `${n(rc.txCount)} txs, ${n(rc.walletCount)} wallets, same ${n(rc.txCount)} transaction hashes` });
      else fail(0, "Numbers differ from QIE's explorer", `claimed ${leaf.txCount} txs / ${leaf.walletCount} wallets, explorer has ${rc.txCount} / ${rc.walletCount}`);

      const root = processProof(leafHash({ ...leaf, txCount: rc.txCount, walletCount: rc.walletCount, txSetHash: rc.txSetHash }), data!.proof);
      if (root === a.root) set(1, { label: "Recounted numbers fold into the snapshot's Merkle root", state: "ok", detail: `${root.slice(0, 18)}…` });
      else fail(1, "Merkle proof does not reach the snapshot root", root);

      if (!data!.contract || !anchored) {
        fail(2, "Root is not on chain yet", data!.contract ? `status: ${a.status}` : "no attestation contract configured on this server");
      } else {
        set(2, { label: "Reading the root from a QIE node", state: "run" });
        const client = createPublicClient({ transport: http(data!.rpcUrls[0]) });
        const [onchain] = await client.readContract({ address: data!.contract, abi: ATTESTATIONS_ABI, functionName: "attestations", args: [a.epoch] });
        const accepted = await client.readContract({ address: data!.contract, abi: ATTESTATIONS_ABI, functionName: "verify", args: [a.epoch, leafHash({ ...leaf, txCount: rc.txCount, walletCount: rc.walletCount, txSetHash: rc.txSetHash }), data!.proof] });
        if (onchain.toLowerCase() === root.toLowerCase() && accepted) set(2, { label: "On-chain root matches, and the contract's verify() returns true", state: "ok", detail: new URL(data!.rpcUrls[0]!).host });
        else fail(2, "On-chain root does not match", onchain);
      }
      set(3, { label: ok ? "Verified: these numbers are on chain and match the explorer" : "Verification failed", state: ok ? "ok" : "fail" });
    } catch (e) {
      setSteps((prev) => [...(prev ?? []).filter((s) => s.state !== "run"), { label: "Could not finish", state: "fail", detail: (e as Error).message }]);
    }
  }

  const cli = `node apps/server/bin/verify-traction.ts ${slug} --api ${window.location.origin}`;
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="row between">
        <h2 style={{ margin: 0 }}>On-chain proof</h2>
        <span className={`badge ${anchored ? "good" : ""}`}>{anchored ? "✓ Anchored on QIE" : a.status === "sent" ? "Anchoring…" : "Computed, not anchored yet"}</span>
      </div>
      <p className="small muted">
        Snapshot of <strong>{epochDate(a.epoch)}</strong>: <strong>{n(leaf.txCount)}</strong> successful transactions from <strong>{n(leaf.walletCount)}</strong> wallets in the
        30 days up to block{" "}
        <a className="mono" href={`${data.explorerUrl}/block/${leaf.toBlock}`} target="_blank" rel="noreferrer">
          {n(leaf.toBlock)}
        </a>
        . These numbers are a leaf in a Merkle tree of {n(a.leaves)} project{a.leaves === 1 ? "" : "s"} whose root is posted to{" "}
        {data.contract ? (
          <a className="mono" href={`${data.explorerUrl}/address/${data.contract}`} target="_blank" rel="noreferrer">
            PulseAttestations
          </a>
        ) : (
          "the attestation contract"
        )}
        {a.txHash && (
          <>
            {" "}
            (
            <a href={`${data.explorerUrl}/tx/${a.txHash}`} target="_blank" rel="noreferrer">
              transaction
            </a>
            )
          </>
        )}
        . The check below recounts them from QIE's own explorer and reads the root from a QIE node, so it doesn't rely on Q-Pulse.
      </p>
      <div className="row" style={{ gap: 8 }}>
        <button className="btn" onClick={() => void verify()} disabled={steps !== null && steps.some((s) => s.state === "run")}>
          Verify in your browser
        </button>
        <Copy text={cli} label="Copy CLI command" />
      </div>
      {steps && steps.length > 0 && (
        <ul style={{ listStyle: "none", padding: 0, margin: "12px 0 0", display: "grid", gap: 6 }}>
          {steps.map((st, i) => (
            <li key={i} className="small">
              <span style={{ color: st.state === "ok" ? "var(--good)" : st.state === "fail" ? "var(--bad)" : "var(--muted)", fontWeight: 600 }}>
                {st.state === "ok" ? "✓" : st.state === "fail" ? "✗" : "…"}
              </span>{" "}
              {st.label}
              {st.detail && <span className="faint"> · {st.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
