import { useState } from "react";
import { api, type Status } from "../api.ts";
import { go, useApp } from "../App.tsx";
import { Alert, Spinner, useAsync } from "../ui.tsx";
import { connect, signMessage } from "../wallet.ts";

export function SignInButton({ big, label = "Sign in with QIE Wallet", next = "/hooks" }: { big?: boolean; label?: string; next?: string | null }) {
  const { reloadMe } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="stack" style={{ gap: 8, alignItems: "flex-start" }}>
      <button
        className={`btn primary ${big ? "lg" : ""}`}
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
      {error && <Alert kind="error">{error}</Alert>}
    </div>
  );
}

function LiveStrip() {
  const { data } = useAsync(() => api<Status>("GET", "/status"), [], 5000);
  if (!data) return null;
  const healthy = data.rpc.filter((r) => r.healthy).length;
  return (
    <div className="strip">
      <span className="row" style={{ gap: 8, color: data.indexer.lastError ? "var(--bad)" : "var(--good)" }}>
        <span className="dot live" /> <b style={{ color: "var(--text)" }}>Live on QIE {data.network}</b>
      </span>
      <span className="muted">
        Block <b className="mono" style={{ color: "var(--text)" }}>{data.indexer.cursor?.toLocaleString() ?? "…"}</b>
      </span>
      <span className="muted">
        RPC nodes healthy <b style={{ color: "var(--text)" }}>{healthy}/{data.rpc.length}</b>
      </span>
      <span className="muted">
        Active hooks <b style={{ color: "var(--text)" }}>{data.totals.hooks}</b>
      </span>
      <a href="#/status" className="right">
        Network status →
      </a>
    </div>
  );
}

export function Landing() {
  return (
    <div className="landing">
      <header>
        <div className="brand" style={{ padding: 0 }}>
          <img src="/favicon.svg" alt="" /> QIE Pulse
        </div>
        <div className="row">
          <a href="#/explore" className="btn ghost">
            Leaderboard
          </a>
          <a href="#/docs" className="btn ghost">
            Docs
          </a>
          <a href="#/status" className="btn ghost">
            Status
          </a>
        </div>
      </header>

      <section className="hero">
        <div>
          <span className="badge accent" style={{ marginBottom: 16 }}>
            Developer tooling for QIE Blockchain
          </span>
          <h1>
            Know the moment it happens <em>on QIE</em>.
          </h1>
          <p className="lead">
            Real-time webhooks, Telegram and Discord alerts for payments to your <b>name.qie</b>, QUSDC transfers, QIEDEX swaps and any contract event.
            No polling, no indexer to run.
          </p>
          <div className="row" style={{ marginTop: 24, alignItems: "flex-start" }}>
            <SignInButton big />
            <a className="btn lg" href="#/docs">
              Read the docs
            </a>
          </div>
          <p className="small faint" style={{ marginTop: 14 }}>
            Free plan included. Signing in costs nothing and sends no transaction.
          </p>
        </div>
        <div className="phone" aria-label="Example Telegram alerts">
          <div className="small faint">QIE Pulse bot · Shop staff</div>
          <div className="msg">
            <b>💸 shop.qie received 25 QUSDC (~$25)</b>
            From: alice.qie
            <div className="meta">Shop payments · 2s after the block</div>
          </div>
          <div className="msg">
            <b>💸 shop.qie received 120 QIE (~$18.57)</b>
            From: 0x3EcD…E542
            <div className="meta">Shop payments</div>
          </div>
          <div className="msg">
            <b>🔄 Swap 1,500 QUSDC → 9,742 WQIE (~$1,500)</b>
            Trader: whale.qie · QIEDEX
            <div className="meta">Big WQIE/QUSDC trades</div>
          </div>
        </div>
      </section>

      <LiveStrip />

      <section className="grid three features">
        {[
          ["🧾", "Payment links", "Send a link, get paid in QUSDC or QIE from QIE Wallet or a QR code, and get a webhook or Telegram message the moment it settles."],
          ["📈", "Traction pages", "A live public page and README badge with your contracts' real users and transactions, verified from the chain. See the leaderboard."],
          ["🤖", "Built for AI agents", "An MCP server lets Claude and other agents take payments, wait for them and react to on-chain events on QIE."],
          ["🪪", "Built on QIE ID", "Watch shop.qie, not a hex address. Senders show by their QIE ID. If a name is repointed, your hook follows it."],
          ["⚡", "Seconds, not minutes", "QIE finalises in 1–2 seconds with CometBFT. We read every block across all five public RPC nodes and fail over when one stalls."],
          ["🔏", "Signed and retried", "Every webhook is HMAC-signed. Failed deliveries retry for 8 hours with backoff, and you can replay any event."],
          ["🛡️", "Lookalike-token safe", "Payment hooks only count official QUSDC and WQIE. Copycat tokens with the same symbol are flagged."],
          ["🔄", "QIEDEX aware", "Swap alerts decode direction and amounts, with USD values from the official QIEDEX API."],
          ["🧩", "Any contract", "Paste a Solidity event signature and get decoded arguments for any contract on QIE."],
        ].map(([icon, title, body]) => (
          <div className="card feature" key={title}>
            <div className="ico">{icon}</div>
            <h3>{title}</h3>
            <p className="muted small" style={{ margin: 0 }}>
              {body}
            </p>
          </div>
        ))}
      </section>

      <section className="card" style={{ marginTop: 24 }}>
        <h2>Ten lines to accept payments</h2>
        <p className="muted">Get a signed POST whenever someone pays your shop, then mark the order paid.</p>
        <pre className="code">{`import { QiePulse, verifyWebhook } from "@qiepulse/sdk";

const qh = new QiePulse({ apiKey: process.env.QIEPULSE_KEY, baseUrl: "${window.location.origin}" });
await qh.onPayment("shop.qie", { url: "https://shop.example.com/qie-webhook" });

app.post("/qie-webhook", express.raw({ type: "application/json" }), (req, res) => {
  const event = verifyWebhook({ body: req.body, headers: req.headers, secret: process.env.QIEPULSE_SECRET });
  if (event.type === "payment.received") markPaid(event.data.from, event.data.amount);
  res.sendStatus(200);
});`}</pre>
      </section>
    </div>
  );
}
