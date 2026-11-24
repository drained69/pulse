import { useState, type ReactNode } from "react";
import { api, type Status } from "../api.ts";
import { go, SiteFooter, SiteHeader, useApp } from "../App.tsx";
import { Icon } from "../icons.tsx";
import { TEMPLATES } from "../templates.ts";
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
  const { me, reloadMe } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (me) {
    return (
      <a className={`btn ${className} ${big ? "lg" : ""}`} href={`#${next ?? "/hooks"}`}>
        {next === "/billing" ? "View your plan" : "Open dashboard"} <span aria-hidden>↗</span>
      </a>
    );
  }
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

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

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

const PREVIEWS = [
  { label: "Payment received", icon: "incoming", type: "payment.received", source: "shop.qie", amount: "125.00", unit: "QUSDC", destination: "Telegram", destinationIcon: "send", title: "You just got paid.", detail: "A customer paid shop.qie. Your team gets the message, your app gets the event.", guide: "invoices" },
  { label: "Wallet activity", icon: "wallet", type: "wallet.activity", source: "treasury.qie", amount: "2,500", unit: "QIE", destination: "Discord", destinationIcon: "chat", title: "Your wallet, in the loop.", detail: "Follow incoming and outgoing transfers without refreshing an explorer.", guide: "protect" },
  { label: "Contract event", icon: "zap", type: "contract.event", source: "Your contract", amount: "Transfer", unit: "event", destination: "Webhook", destinationIcon: "link", title: "An event. An action.", detail: "Turn a contract event into a signed webhook your application can act on.", guide: "developers" },
];

function HeroArt() {
  const [selected, setSelected] = useState(0);
  const preview = PREVIEWS[selected]!;
  return (
    <div className="signal-preview">
      <div className="preview-topline"><span><img src="/favicon.svg" alt="" /> Q-Pulse</span><span className="preview-demo">Interactive preview</span></div>
      <div className="preview-options" role="group" aria-label="Choose an example event">
        {PREVIEWS.map((item, i) => (
          <button type="button" key={item.type} aria-pressed={selected === i} onClick={() => setSelected(i)}>
            <Icon name={item.icon} size={15} />{item.label}
          </button>
        ))}
      </div>
      <div className="signal-flow" aria-hidden="true">
        <div className="signal-node"><Icon name="wallet" size={23} /><span>QIE Blockchain</span></div>
        <div className="signal-wire"><i /></div>
        <div className="signal-core"><img src="/favicon.svg" alt="" /></div>
        <div className="signal-wire"><i /></div>
        <div className="signal-node destination"><Icon name={preview.destinationIcon} size={23} /><span>{preview.destination}</span></div>
      </div>
      <div className="preview-event" aria-live="polite" aria-atomic="true">
        <div className="preview-event-head"><span className="preview-event-icon"><Icon name={preview.icon} size={20} /></span><div><b>{preview.label}</b><span>Example event · {preview.source}</span></div><span className="preview-check"><Icon name="check" size={16} /></span></div>
        <div className="preview-amount">{preview.amount} <span>{preview.unit}</span></div>
        <div className="preview-event-foot"><code>{preview.type}</code><span><Icon name={preview.destinationIcon} size={13} /> {preview.destination}</span></div>
      </div>
      <div className="preview-caption" aria-live="polite"><b>{preview.title}</b><p>{preview.detail}</p></div>
      <a className="preview-bottom" href={`#/guide/${preview.guide}`}><span>From on-chain activity to your next action.</span><span aria-hidden>↗</span></a>
    </div>
  );
}

function ProductOverview() {
  const products = [
    { number: "01", icon: "zap", title: "Never miss a signal.", description: "Wallet moves, payments and contract events, delivered to Telegram, Discord or your app.", link: "shops", action: "Explore alerts" },
    { number: "02", icon: "receipt", title: "Make getting paid simple.", description: "Share a payment link or product QR. Funds go straight to your wallet; confirmation follows on chain.", link: "invoices", action: "Explore payments" },
    { number: "03", icon: "trending", title: "Let your traction talk.", description: "Give your project a public page with real wallets, transactions and daily on-chain proofs.", link: "traction", action: "Explore traction" },
  ];
  return (
    <section className="product-overview" aria-label="What you can do with Q-Pulse">
      <div className="product-overview-grid">
        {products.map(product => (
          <a href={`#/guide/${product.link}`} key={product.number} className="product-pillar">
            <div className="pillar-heading">
              <span className="tile-ico"><Icon name={product.icon} size={20} /></span>
              <span className="mono">{product.number} /</span>
            </div>
            <h2>{product.title}</h2>
            <p>{product.description}</p>
            <span className="pillar-action">{product.action}<span aria-hidden>↗</span></span>
          </a>
        ))}
      </div>
    </section>
  );
}

const MCP_TOOLS = [
  "create_payment_link",
  "wait_for_payment",
  "get_payment_link",
  "list_payment_links",
  "create_product",
  "list_products",
  "create_alert",
  "list_alerts",
  "set_alert_active",
  "delete_alert",
  "get_events",
  "wait_for_event",
  "list_telegram_chats",
  "resolve_qie_name",
  "get_traction",
  "network_status",
];

const TOUR: { key: string; tab: string; title: string; body: string; link: [string, string]; art: (live: Live) => ReactNode }[] = [
  {
    key: "hooks",
    tab: "Alerts and webhooks",
    title: "Know the moment money moves.",
    body: "Watch a name.qie, a token, a QIEDEX pair or any contract event. Get a signed webhook, a Telegram message or a Discord post seconds after the block, retried for about 8.5 hours if your server is down.",
    link: ["#/guide/shops", "Set up your first alert"],
    art: ({ status }) => (
      <Window title="Start from a template">
        {["shop", "whale", "rugpull", "admin"].map((id) => {
          const t = TEMPLATES.find((x) => x.id === id)!;
          return (
            <div className="alert-row row between" key={id} style={{ flexWrap: "nowrap", gap: 12 }}>
              <div>
                <b>{t.title}</b>
                <div className="meta">{t.desc}</div>
              </div>
              <span className="chip">{t.who}</span>
            </div>
          );
        })}
        <div className="small faint">
          {TEMPLATES.length} templates, or build your own from 11 triggers
          {status?.indexer.cursor ? ` · watching block ${status.indexer.cursor.toLocaleString()}` : ""}
        </div>
      </Window>
    ),
  },
  {
    key: "pay",
    tab: "Payment links",
    title: "Get paid without a memo field.",
    body: "QIE transfers carry no reference, so each open link gets a unique amount. Customers pay with QIE Wallet or a QR code, funds go straight to you, and you get invoice.paid with your order id.",
    link: ["#/guide/invoices", "Create a payment link"],
    art: () => (
      <Window title="How a checkout settles">
        {[
          ["1 · You create a link", "Amount in QUSDC, QIE or WQIE, what it's for, and where the money goes"],
          ["2 · Your customer pays", "QIE Wallet button, or a QR code any QIE wallet can scan"],
          ["3 · Matched on chain", "Recipient + token + exact amount, in the next block (about 4 s), final at once"],
          ["4 · You're told", "The page shows Paid; your hook sends invoice.paid with your order id"],
        ].map(([t, d]) => (
          <div className="alert-row" key={t}>
            <b>{t}</b>
            <div className="meta">{d}</div>
          </div>
        ))}
        <div className="small faint">Funds go from the customer's wallet straight to yours</div>
      </Window>
    ),
  },
  {
    key: "traction",
    tab: "Traction pages",
    title: "Traction anyone can check.",
    body: "A public page and README badge with a project's real wallets and transactions, read from the chain. Every day the numbers are committed on chain, so anyone can verify them without trusting us.",
    link: ["#/guide/traction", "Create your traction page"],
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
    body: "An MCP server gives Claude and other agents 16 tools: create a payment link or a product, wait until it's paid, react to any on-chain event, resolve QIE IDs. One line to connect.",
    link: ["#/guide/agents", "Connect an agent"],
    art: () => (
      <Window title="16 tools over MCP">
        <div className="row" style={{ gap: 6 }}>
          {MCP_TOOLS.map((t) => (
            <span className="chip mono" key={t}>
              {t}
            </span>
          ))}
        </div>
        <pre className="code" style={{ margin: 0 }}>{`claude mcp add --transport http qpulse \\
  ${window.location.origin}/api/mcp \\
  --header "Authorization: Bearer qp_live_…"`}</pre>
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
      <div className="tour-tabs" role="tablist" aria-label="Explore Q-Pulse features" onKeyDown={(e) => {
        if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
        e.preventDefault();
        const index = TOUR.findIndex((item) => item.key === on);
        const next = e.key === "Home" ? 0 : e.key === "End" ? TOUR.length - 1 : (index + (["ArrowRight", "ArrowDown"].includes(e.key) ? 1 : -1) + TOUR.length) % TOUR.length;
        setOn(TOUR[next]!.key);
        document.getElementById(`tour-tab-${TOUR[next]!.key}`)?.focus();
      }}>
        {TOUR.map((x) => (
          <button key={x.key} id={`tour-tab-${x.key}`} role="tab" aria-selected={x.key === on} aria-controls="tour-panel" tabIndex={x.key === on ? 0 : -1} className={x.key === on ? "on" : ""} onClick={() => setOn(x.key)}>
            {x.tab}
          </button>
        ))}
      </div>
      <div id="tour-panel" role="tabpanel" aria-labelledby={`tour-tab-${on}`} tabIndex={0}>
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
  ["Signed and retried", "HMAC-signed webhooks, retried 6 times over about 8.5 hours. Every event is stored once and can be replayed."],
  ["Lookalike-token safe", "Payment hooks only count official QUSDC and WQIE. Copycat tokens with the same symbol are flagged."],
  ["QIEDEX aware", "Swap alerts decode direction and amounts, with USD values from the official QIEDEX API."],
  ["Any contract", "Paste a Solidity event signature and get decoded arguments for any contract on QIE."],
  ["Sell anything, unlock anything", "Products give you a permanent link or QR code. Each buyer gets their own checkout, then sees a download or a code, or a device unlocks."],
  ["Pay-per-request APIs", "Charge people and AI agents per call in QUSDC with one middleware: HTTP 402, pay, retry. One payment buys one request."],
  ["Scam guards", "Warnings for lookalike-address poisoning and zero-value transfers, and a rug-pull radar for QIEDEX pairs."],
];

/** Who Q-Pulse is for. Each card opens that case's step-by-step guide. */
const USES: { id: string; icon: string; who: string; what: string }[] = [
  { id: "shops", icon: "bag", who: "Shops and freelancers", what: "A Telegram or Discord message seconds after a customer pays your name.qie: the amount, its USD value and who paid." },
  { id: "invoices", icon: "receipt", who: "Invoices and orders", what: "Send a link for an exact amount. The customer pays with QIE Wallet or a QR code, and the order shows Paid within seconds." },
  { id: "products", icon: "unlock", who: "Things you sell again and again", what: "One permanent QR code per product. Every buyer pays, then unlocks a download, a licence key, a door code or a device." },
  { id: "protect", icon: "shield", who: "Anyone holding QIE", what: "Alerts for wallet activity, token approvals, address-poisoning attempts, price levels and pairs losing liquidity." },
  { id: "community", icon: "megaphone", who: "Communities", what: "Feed a Discord or Telegram channel with whale moves, new QIEDEX pairs or your own contract's events, decoded." },
  { id: "traction", icon: "trending", who: "Project teams", what: "A live public page and README badge with your real users and transactions, committed on chain every day." },
  { id: "developers", icon: "zap", who: "Developers", what: "Signed webhooks with retries, an SDK, a REST API, pay-per-request APIs and eth_subscribe on QIE." },
  { id: "agents", icon: "chat", who: "AI agents", what: "Connect Claude or any MCP client and let it take payments, sell products and react to on-chain events." },
];

const HOW: [string, string][] = [
  ["Sign in with your wallet", "QIE Wallet or MetaMask. Free, one signature, no transaction and no gas."],
  ["Pick what to watch or sell", "Start from a template: a payment to your name.qie, a wallet, a token, a pair, a contract, a payment link or a product."],
  ["Choose where it goes", "Telegram, Discord or your server. Press Send test, and real events follow seconds after each block."],
];

function WhoUsesIt() {
  return (
    <section className="section">
      <div className="inner">
        <span className="eyebrow">How it works</span>
        <h2 className="display" style={{ fontSize: "clamp(2.2rem, 4.6vw, 3.4rem)", maxWidth: 760, margin: "12px 0 28px" }}>
          Three steps, about a minute, no code needed
        </h2>
        <ol className="how3">
          {HOW.map(([t, d], i) => (
            <li key={t}>
              <span className="n">{i + 1}</span>
              <div>
                <b>{t}</b>
                <p>{d}</p>
              </div>
            </li>
          ))}
        </ol>
        <h3 className="serif" style={{ fontSize: "1.5rem", margin: "44px 0 18px" }}>
          Who uses it, and how
        </h3>
        <div className="use-grid">
          {USES.map((u) => (
            <a className="use-card" key={u.id} href={`#/guide/${u.id}`}>
              <span className="tile-ico" aria-hidden>
                <Icon name={u.icon} size={17} />
              </span>
              <b>{u.who}</b>
              <p>{u.what}</p>
              <span className="go">Step-by-step guide →</span>
            </a>
          ))}
        </div>
        <div className="row" style={{ marginTop: 24, gap: 12 }}>
          <a className="btn" href="#/guide">
            Read the full guide
          </a>
          <a className="btn ghost" href="#/docs">
            Technical docs
          </a>
        </div>
      </div>
    </section>
  );
}

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
    ["Counted", `${plural(proof.leaf.txCount, "transaction")} from ${plural(proof.leaf.walletCount, "wallet")}`],
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

/** Plans, read from the server's own configuration and the billing contract's price. */
function Pricing() {
  const { config } = useApp();
  const { free, pro } = config.plans;
  const common = ["Telegram, Discord and signed webhooks", "Payment links and products", "Traction pages with daily on-chain proofs", "API, SDK, MCP for AI agents, WebSocket RPC"];
  return (
    <section className="section alt" id="landing-pricing">
      <div className="inner">
        <span className="eyebrow">Pricing</span>
        <h2 className="display" style={{ fontSize: "clamp(2.2rem, 4.6vw, 3.4rem)", margin: "12px 0 10px" }}>
          Free to start. Pro when you grow.
        </h2>
        <p className="muted" style={{ maxWidth: 640, marginBottom: 28 }}>
          Every feature is on both plans; Pro raises the limits. Pro is paid in QUSDC through an on-chain contract: no card, no sign-up form, and it never renews
          by itself.
        </p>
        <div className="price-grid">
          <div className="price-card">
            <h3>Free</h3>
            <div className="price">
              <b>0</b> forever
            </div>
            <ul>
              <li>{free.maxHooks} hooks</li>
              <li>{free.monthlyEvents.toLocaleString()} events a month</li>
              {common.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <SignInButton label="Start free" />
          </div>
          <div className="price-card featured">
            <div className="row between"><h3>Pro</h3><span className="badge accent">Room to grow</span></div>
            <div className="price">
              <b>{config.proPriceQusdc} QUSDC</b> per {config.proPeriodDays} days
            </div>
            <ul>
              <li>{pro.maxHooks} hooks</li>
              <li>{pro.monthlyEvents.toLocaleString()} events a month</li>
              <li>Everything in Free</li>
              <li>Pay early and the time adds up</li>
            </ul>
            <SignInButton label="Get started with Pro" next="/billing" className="" />
            {config.billingContract ? (
              <a className="small" href={`${config.explorerUrl}/address/${config.billingContract}`} target="_blank" rel="noreferrer">
                Billing contract on the QIE explorer →
              </a>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}

export function Landing() {
  const live = useLive();
  const data = live.status;
  return (
    <div className="landing">
      <SiteHeader />

      <main id="main-content" tabIndex={-1}>
        <section className="hero product-hero">
          <div className="hero-inner">
            <div>
              <a className="pill-new" href="#/guide"><b><span className="dot" /> Built for QIE</b> Meet your on-chain command center <span aria-hidden>↗</span></a>
              <div className="hero-kicker">THE SIGNAL BETWEEN BLOCKCHAIN AND BUSINESS</div>
              <h1 className="display">
                On-chain activity.<br />Real-world <em>momentum.</em>
              </h1>
              <p className="lead">
                Get the alert. Take the payment. Prove the growth. Turn QIE Blockchain activity into something you can act on, all from one place.
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
                <a className="btn lg hero-secondary" href="#/guide">Explore the product <span aria-hidden>↗</span></a>
              </div>
              <div className="hero-reassurance"><span><Icon name="check" size={14} /> Free plan included</span><span><Icon name="check" size={14} /> No gas to sign in</span></div>
              <div className="hero-shortcuts"><a href="#/docs">Developer docs <span aria-hidden>↗</span></a><button type="button" onClick={() => document.getElementById("landing-pricing")?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" })}>View pricing <span aria-hidden>↓</span></button></div>
            </div>
            <HeroArt />
          </div>
        </section>

        <div className="landing-live"><LiveStrip data={data} /></div>
        <ProductOverview />

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

        <WhoUsesIt />

        <section className="section alt">
          <div className="inner">
            <h2 className="display statement">One indexer for QIE. Five ways to use it, from a Telegram ping to an AI agent.</h2>
            <Tour live={live} />
          </div>
        </section>

        <section className="section">
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

        <section className="section alt">
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

        <section className="section">
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

        <Pricing />

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

      </main>
      <SiteFooter />
    </div>
  );
}
