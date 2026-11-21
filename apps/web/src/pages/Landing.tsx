import { useState, type ReactNode } from "react";
import { api, type Status } from "../api.ts";
import { go, SiteFooter, SiteHeader, useApp } from "../App.tsx";
import { Alert, Spinner, useAsync } from "../ui.tsx";
import { connect, signMessage } from "../wallet.ts";

export function SignInButton({
  big,
  compact,
  label = "Sign in with QIE Wallet",
  next = "/hooks",
  className = "primary",
}: {
  big?: boolean;
  compact?: boolean;
  label?: ReactNode;
  next?: string | null;
  className?: string;
}) {
  const { reloadMe } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const button = (
    <button
      className={`btn ${className} ${big ? "lg" : ""}`}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        setError(null);
        try {
          const { address, provider } = await connect();
          const { message, nonce } = await api<{ message: string; nonce: string }>("POST", "/auth/nonce", { address });
          const signature = await signMessage(provider, address, message);
          await api("POST", "/auth/verify", { address, signature, nonce });
          await reloadMe();
          if (next) go(next);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          setError(/reject|denied|4001/i.test(msg) ? "You cancelled the signature request." : msg);
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? <Spinner /> : null} {label}
    </button>
  );
  if (compact)
    return (
      <span style={{ position: "relative" }}>
        {button}
        {error && (
          <span style={{ position: "absolute", right: 0, top: "calc(100% + 10px)", width: 280, zIndex: 30 }}>
            <Alert kind="error">{error}</Alert>
          </span>
        )}
      </span>
    );
  return (
    <div className="stack" style={{ gap: 8, alignItems: "flex-start" }}>
      {button}
      {error && <Alert kind="error">{error}</Alert>}
    </div>
  );
}

const fmtMs = (ms: number | null | undefined) => (ms == null ? null : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

function useStatus() {
  return useAsync(() => api<Status>("GET", "/status"), [], 5000).data;
}

type BoardRow = { rank: number; slug: string; name: string; verified: boolean; wallets7d: number; txs7d: number; wallets: number; txs: number };
type Attestation = { epoch: number; date: string; root: string; leaves: number; snapshotBlock: number; status: string; txHash: string | null; blockNumber: number | null };
type Proof = {
  attestation: Attestation;
  leaf: { slug: string; contracts: string[]; fromTs: number; toBlock: number; txCount: number; walletCount: number };
  contract: string | null;
};
/** Real numbers for the landing page: the public leaderboard, the latest on-chain proof and the top project's leaf. */
type Live = { status: Status | null; board: BoardRow[] | null; latest: Attestation | null; proof: Proof | null; proofName: string | null };

function useLive(): Live {
  const status = useStatus();
  const board = useAsync(() => api<{ projects: BoardRow[] }>("GET", "/projects"), [], 60_000).data?.projects ?? null;
  const latest = useAsync(() => api<{ attestations: Attestation[] }>("GET", "/attestations?limit=1"), [], 60_000).data?.attestations[0] ?? null;
  const top = board?.find((p) => p.txs > 0) ?? null;
  const proof = useAsync(
    () => (top ? api<Proof>("GET", `/projects/${top.slug}/proof`).catch(() => null) : Promise.resolve(null)),
    [top?.slug],
    60_000,
  ).data;
  return { status, board, latest, proof: proof ?? null, proofName: top?.name ?? null };
}

const PROOF_STATUS: Record<string, string> = { anchored: "ON CHAIN", sent: "POSTING", computed: "COMPUTED", failed: "RETRYING", superseded: "SUPERSEDED" };

function LiveStrip({ data }: { data: Status | null }) {
  if (!data) return null;
  const healthy = data.rpc.filter((r) => r.healthy).length;
  const p50 = fmtMs(data.latency?.deliver.p50) ?? fmtMs(data.latency?.stream.p50);
  return (
    <div className="live-strip">
      <span className="row" style={{ gap: 8, color: data.indexer.lastError ? "var(--bad)" : "var(--accent)" }}>
        <span className="dot live" /> <b>Live on QIE {data.network}</b>
      </span>
      <span>
        Block <b className="mono">{data.indexer.cursor?.toLocaleString() ?? "…"}</b>
      </span>
      <span>
        RPC nodes <b>{healthy}/{data.rpc.length}</b>
      </span>
      {p50 && (
        <span>
          p50 latency <b>{p50}</b>
        </span>
      )}
      <a href="#/status">Network status →</a>
    </div>
  );
}

function Window({ title, children, chips }: { title?: string; children: ReactNode; chips?: ReactNode }) {
  return (
    <div className="window">
      <div className="lights" aria-hidden>
        <i />
        <i />
        <i />
      </div>
      {title && <h3 className="serif">{title}</h3>}
      {chips && (
        <div className="row" style={{ gap: 6, marginBottom: 14 }}>
          {chips}
        </div>
      )}
      <div className="stack" style={{ gap: 10 }}>
        {children}
      </div>
    </div>
  );
}

function HeroArt({ live }: { live: Live }) {
  const { config } = useApp();
  const { status, board, latest } = live;
  const healthy = status ? status.rpc.filter((r) => r.healthy).length : null;
  const top = board?.[0] ?? null;
  return (
    <div className="hero-art" aria-label="Live data from QIE mainnet">
      <Window
        title="Live on QIE"
        chips={
          <>
            <span className="chip">
              <span className="dot live" style={{ color: "var(--lime)" }} /> {status?.indexer.cursor ? `Block ${status.indexer.cursor.toLocaleString()}` : "QIE mainnet"}
            </span>
            <span className="chip">Chain {status?.chainId ?? config.chainId}</span>
          </>
        }
      >
        <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <div className="mini-stat">
            <div className="l">RPC nodes healthy</div>
            <div className="n">{healthy === null ? "…" : `${healthy} of ${status!.rpc.length}`}</div>
          </div>
          <div className="mini-stat">
            <div className="l">Projects tracked</div>
            <div className="n">{board ? board.length : "…"}</div>
          </div>
        </div>
        {top && (
          <a className="alert-row" href={`#/p/${top.slug}`} style={{ color: "inherit" }}>
            <b>
              #1 {top.name}: {top.wallets7d} wallet{top.wallets7d === 1 ? "" : "s"} this week
            </b>
            <div className="meta">{top.txs.toLocaleString()} transactions counted from the chain{top.verified ? " · verified owner" : ""}</div>
          </a>
        )}
        {latest && (
          <div className="alert-row hot row between" style={{ flexWrap: "nowrap" }}>
            <div>
              <b>
                Traction proof for {latest.date} · {latest.leaves} project{latest.leaves === 1 ? "" : "s"}
              </b>
              <div className="meta">
                {latest.txHash ? (
                  <a href={`${config.explorerUrl}/tx/${latest.txHash}`} target="_blank" rel="noreferrer">
                    Posted to PulseAttestations{latest.blockNumber ? ` at block ${latest.blockNumber.toLocaleString()}` : ""}
                  </a>
                ) : (
                  "Merkle root computed from the chain"
                )}
              </div>
            </div>
            <span className="pass">{PROOF_STATUS[latest.status] ?? latest.status.toUpperCase()}</span>
          </div>
        )}
        <div className="small faint">Live from this server, not sample data</div>
      </Window>
    </div>
  );
}

const TOUR: { key: string; tab: string; title: string; body: string; link: [string, string]; art: (live: Live) => ReactNode }[] = [
  {
    key: "hooks",
    tab: "Alerts and webhooks",
    title: "Know the moment money moves.",
    body: "Watch a name.qie, a token, a QIEDEX pair or any contract event. Get a signed webhook, a Telegram message or a Discord post seconds after the block, retried for 8 hours if your server is down.",
    link: ["#/docs", "See every trigger"],
    art: () => (
      <Window title="Your hooks">
        {[
          ["Payments to shop.qie", "QUSDC or QIE · Telegram"],
          ["QUSDC whales", "≥ 10,000 QUSDC · Webhook"],
          ["QIEDEX big swaps", "≥ $1,000 · Discord"],
          ["Escrow contract", "Funded, Released · Webhook"],
        ].map(([t, d]) => (
          <div className="alert-row row between" key={t} style={{ flexWrap: "nowrap" }}>
            <div>
              <b>{t}</b>
              <div className="meta">{d}</div>
            </div>
            <span className="pass">LIVE</span>
          </div>
        ))}
        <div className="small faint">Example</div>
      </Window>
    ),
  },
  {
    key: "pay",
    tab: "Payment links",
    title: "Get paid without a memo field.",
    body: "QIE transfers carry no reference, so each open link gets a unique amount. Customers pay with QIE Wallet or a QR code, funds go straight to you, and you get invoice.paid with your order id.",
    link: ["#/docs", "How matching works"],
    art: () => (
      <Window title="Checkout">
        <div className="mini-stat">
          <div className="l">Logo design · pay shop.qie</div>
          <div className="n">25.000001 QUSDC</div>
        </div>
        <div className="alert-row">
          <b>Pay with QIE Wallet</b>
          <div className="meta">or scan the QR code with any wallet</div>
        </div>
        <div className="alert-row hot row between" style={{ flexWrap: "nowrap" }}>
          <div>
            <b>Paid by alice.qie</b>
            <div className="meta">matched by exact amount, final in one block</div>
          </div>
          <span className="pass">PAID</span>
        </div>
        <div className="small faint">Example</div>
      </Window>
    ),
  },
  {
    key: "traction",
    tab: "Traction pages",
    title: "Traction anyone can check.",
    body: "A public page and README badge with a project's real wallets and transactions, read from the chain. Every day the numbers are committed on chain, so anyone can verify them without trusting us.",
    link: ["#/explore", "Open the leaderboard"],
    art: ({ board }) => (
      <Window title="Leaderboard · 7 days">
        {(board ?? []).slice(0, 3).map((p) => (
          <a className="alert-row row between" key={p.slug} href={`#/p/${p.slug}`} style={{ flexWrap: "nowrap", color: "inherit" }}>
            <div className="row" style={{ flexWrap: "nowrap" }}>
              <span className="serif faint" style={{ fontSize: "1.2rem", width: 18 }}>
                {p.rank}
              </span>
              <b>{p.name}</b>
            </div>
            <span className="small muted">
              {p.wallets7d} wallet{p.wallets7d === 1 ? "" : "s"}
            </span>
          </a>
        ))}
        {board && board.length === 0 && <div className="alert-row">No public pages yet. Create the first one.</div>}
        <div className="small faint">Live from the public leaderboard</div>
      </Window>
    ),
  },
  {
    key: "agents",
    tab: "AI agents",
    title: "Let agents take payments.",
    body: "An MCP server gives Claude and other agents 14 tools: create a payment link, wait until it's paid, react to any on-chain event, resolve QIE IDs. One line to connect.",
    link: ["#/docs", "Connect an agent"],
    art: () => (
      <Window title="Agent">
        <div className="alert-row">
          <b>“Bill the client 2 QUSDC for the logo and tell me when it's paid.”</b>
        </div>
        <div className="alert-row">
          <span className="mono small">create_payment_link → wait_for_payment</span>
        </div>
        <div className="alert-row hot">
          <b>Paid by client.qie, 2 QUSDC.</b>
          <div className="meta">seconds after the block</div>
        </div>
        <div className="small faint">Example</div>
      </Window>
    ),
  },
  {
    key: "rpc",
    tab: "eth_subscribe",
    title: "eth_subscribe, finally on QIE.",
    body: "QIE's public nodes reject subscriptions. Point viem, ethers or web3 at our WebSocket RPC and watchContractEvent and contract.on() just work, with failover across all five nodes.",
    link: ["#/docs", "Read the RPC docs"],
    art: () => (
      <pre className="code" style={{ boxShadow: "var(--shadow-lg)" }}>{`const client = createPublicClient({
  transport: webSocket("${window.location.origin.replace(/^http/, "ws")}/rpc"),
});

client.watchContractEvent({
  address: QUSDC,
  abi,
  eventName: "Transfer",
  onLogs: (logs) => console.log(logs),
});`}</pre>
    ),
  },
];

function Tour({ live }: { live: Live }) {
  const [on, setOn] = useState(TOUR[0]!.key);
  const t = TOUR.find((x) => x.key === on)!;
  return (
    <div className="tour">
      <div className="tour-tabs" role="tablist">
        {TOUR.map((x) => (
          <button key={x.key} role="tab" aria-selected={x.key === on} className={x.key === on ? "on" : ""} onClick={() => setOn(x.key)}>
            {x.tab}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        <h3 className="display">{t.title}</h3>
        <p>{t.body}</p>
        <a href={t.link[0]}>{t.link[1]} →</a>
      </div>
      <div>{t.art(live)}</div>
    </div>
  );
}

const FEATURES: [string, string][] = [
  ["Built on QIE ID", "Watch shop.qie, not a hex address. Senders show by their QIE ID, and if a name is repointed your hook follows it."],
  ["Seconds, measured", "Every block across all five public RPC nodes, with failover. Live p50 and p95 latency on the status page, not a claim."],
  ["Signed and retried", "HMAC-signed webhooks, retried for 8 hours with backoff. Every event is stored once and can be replayed."],
  ["Lookalike-token safe", "Payment hooks only count official QUSDC and WQIE. Copycat tokens with the same symbol are flagged."],
  ["QIEDEX aware", "Swap alerts decode direction and amounts, with USD values from the official QIEDEX API."],
  ["Any contract", "Paste a Solidity event signature and get decoded arguments for any contract on QIE."],
];

/** The latest real proof: what was counted for the top project and where its root was posted. */
function ProofWindow({ live }: { live: Live }) {
  const { config } = useApp();
  const { proof, proofName } = live;
  if (!proof) {
    return (
      <Window title="Latest proof">
        <div className="alert-row">The first daily proof is posted once a project's history import finishes.</div>
      </Window>
    );
  }
  const a = proof.attestation;
  const rows: [string, ReactNode][] = [
    ["Project", <a href={`#/p/${proof.leaf.slug}`}>{proofName ?? proof.leaf.slug}</a>],
    ["Window", `30 days up to block ${proof.leaf.toBlock.toLocaleString()}`],
    ["Counted", `${proof.leaf.txCount.toLocaleString()} transactions from ${proof.leaf.walletCount.toLocaleString()} wallets`],
    ["Merkle root", <span className="mono">{`${a.root.slice(0, 10)}…${a.root.slice(-6)}`}</span>],
    [
      "Posted",
      a.txHash ? (
        <a href={`${config.explorerUrl}/tx/${a.txHash}`} target="_blank" rel="noreferrer">
          PulseAttestations{a.blockNumber ? `, block ${a.blockNumber.toLocaleString()}` : ""}
        </a>
      ) : (
        "waiting for today's post"
      ),
    ],
  ];
  return (
    <Window title={`Proof for ${a.date}`}>
      <div className="checks">
        {rows.map(([k, v]) => (
          <div className="row" key={k}>
            <b>{k}</b>
            <span className="grow">· {v}</span>
          </div>
        ))}
      </div>
      <div className="row between">
        <span className="pass">{PROOF_STATUS[a.status] ?? a.status.toUpperCase()}</span>
        <a href={`#/p/${proof.leaf.slug}`}>Recount it yourself →</a>
      </div>
    </Window>
  );
}

export function Landing() {
  const live = useLive();
  const data = live.status;
  return (
    <div className="landing">
      <SiteHeader />

      <section className="hero">
        <div className="hero-inner">
          <div>
            <a className="pill-new" href="#/docs">
              <b>New</b> eth_subscribe for QIE <span aria-hidden>→</span>
            </a>
            <h1 className="display">
              Know the moment it <em>happens</em> on QIE.
            </h1>
            <p className="lead">
              Alerts, webhooks, payment links and provable traction pages for QIE Blockchain. One indexer reads every block, so you never run your own.
            </p>
            <div className="row" style={{ marginTop: 30, alignItems: "flex-start", gap: 12 }}>
              <SignInButton
                big
                label={
                  <>
                    Get started, free <span className="arrow">→</span>
                  </>
                }
              />
              <a className="btn lg" href="#/docs">
                Read the docs
              </a>
            </div>
            <p className="small faint" style={{ marginTop: 14 }}>
              Sign in with QIE Wallet. It costs nothing and sends no transaction.
            </p>
            <LiveStrip data={data} />
          </div>
          <HeroArt live={live} />
        </div>
      </section>

      <div className="built">
        <div className="inner">
          <span className="eyebrow">Built on</span>
          {["QIE Wallet", "QIE ID", "QUSDC", "QIEDEX", "QIE mainnet"].map((n) => (
            <span className="name" key={n}>
              {n}
            </span>
          ))}
        </div>
      </div>

      <section className="section">
        <div className="inner">
          <h2 className="display statement">One indexer for QIE. Five ways to use it, from a Telegram ping to an AI agent.</h2>
          <Tour live={live} />
        </div>
      </section>

      <section className="section alt">
        <div className="inner split">
          <div>
            <span className="eyebrow">Provable traction</span>
            <h2 className="display" style={{ marginTop: 12 }}>
              Numbers you can prove
            </h2>
            <p>
              Anyone can claim users. Every day Q-Pulse commits each project's numbers to a contract on QIE, down to the exact set of transactions. One click
              recounts them from QIE's own explorer and checks them against the chain. Nothing to trust, including us.
            </p>
            <a className="btn primary lg" href="#/explore" style={{ marginTop: 10 }}>
              Verify a project yourself <span className="arrow">→</span>
            </a>
          </div>
          <ProofWindow live={live} />
        </div>
      </section>

      <section className="section">
        <div className="inner">
          <h2 className="display" style={{ fontSize: "clamp(2.2rem, 4.6vw, 3.4rem)", maxWidth: 700, marginBottom: 40 }}>
            Made for builders shipping on QIE
          </h2>
          <div className="feature-grid">
            {FEATURES.map(([t, b]) => (
              <div className="feature" key={t}>
                <h3>{t}</h3>
                <p>{b}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section alt">
        <div className="inner split">
          <div>
            <span className="eyebrow">For developers</span>
            <h2 className="display" style={{ marginTop: 12 }}>
              Ten lines to accept payments
            </h2>
            <p>Get a signed POST whenever someone pays your shop, verify it with the SDK, mark the order paid. Or skip code: send alerts to Telegram.</p>
            <a href="#/docs">Read the docs →</a>
          </div>
          <pre className="code" style={{ boxShadow: "var(--shadow-lg)" }}>{`import { QPulse, verifyWebhook } from "qpulse-sdk";

const qp = new QPulse({ apiKey: process.env.QPULSE_KEY, baseUrl: "${window.location.origin}" });
await qp.onPayment("shop.qie", { url: "https://shop.example.com/qie-webhook" });

app.post("/qie-webhook", express.raw({ type: "application/json" }), (req, res) => {
  const event = verifyWebhook({ body: req.body, headers: req.headers, secret: process.env.QPULSE_SECRET });
  if (event.type === "payment.received") markPaid(event.data.from, event.data.amount);
  res.sendStatus(200);
});`}</pre>
        </div>
      </section>

      <section className="section">
        <div className="cta">
          <h2>Ship on QIE. Know the moment it happens.</h2>
          <div className="row" style={{ justifyContent: "center", gap: 12 }}>
            <SignInButton className="light" big label="Start free" />
            <a className="btn lg" href="#/explore">
              Open the leaderboard
            </a>
          </div>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
