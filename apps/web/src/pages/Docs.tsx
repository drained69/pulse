const PAYMENT_EXAMPLE = `{
  "id": "evt_6c1f0e5b2a9d4e7f8a1b2c3d",
  "type": "payment.received",
  "createdAt": "2026-11-18T10:21:07.412Z",
  "hook": { "id": "hk_9a2b…", "name": "Shop payments" },
  "chain": { "id": 1990, "network": "mainnet" },
  "tx": {
    "hash": "0x5046…d3b2",
    "blockNumber": 11981875,
    "logIndex": 5,
    "timestamp": 1794958201,
    "explorerUrl": "https://mainnet.qie.digital/tx/0x5046…d3b2"
  },
  "data": {
    "from": { "address": "0xF1cB…c17a", "name": "alice.qie" },
    "to":   { "address": "0x1720…b174", "name": "shop.qie" },
    "token": { "address": "0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5", "symbol": "QUSDC", "decimals": 6, "official": true },
    "amount": { "raw": "25000000", "formatted": "25", "display": "25 QUSDC", "symbol": "QUSDC", "valueUsd": 25 }
  }
}`;

const VERIFY_SDK = `import express from "express";
import { verifyWebhook } from "@qiehooks/sdk";

const app = express();

// Use the RAW body: the signature covers the exact bytes we sent.
app.post("/qie-webhook", express.raw({ type: "application/json" }), (req, res) => {
  let event;
  try {
    event = verifyWebhook({ body: req.body, headers: req.headers, secret: process.env.QIEHOOKS_SECRET });
  } catch {
    return res.sendStatus(400);
  }
  if (event.type === "payment.received") {
    // Idempotency: we may deliver the same event twice (retries, replays). Key on event.tx.hash + logIndex.
    console.log(\`\${event.data.from.name ?? event.data.from.address} paid \${event.data.amount.display}\`);
  }
  res.sendStatus(200); // anything else is retried
});`;

const VERIFY_RAW = `// Any language: HMAC-SHA256 over "<timestamp>.<raw body>" with your hook's secret.
const ts = req.headers["qiehooks-timestamp"];
const expected = crypto.createHmac("sha256", secret).update(\`\${ts}.\${rawBody}\`).digest("hex");
const ok = req.headers["qiehooks-signature"] === \`v1=\${expected}\`  // use a constant-time compare
        && Math.abs(Date.now() / 1000 - Number(ts)) < 300;`;

const PYTHON = `import hmac, hashlib, time

def verify(raw_body: bytes, headers, secret: str) -> bool:
    ts = headers["QieHooks-Timestamp"]
    sig = headers["QieHooks-Signature"].removeprefix("v1=")
    expected = hmac.new(secret.encode(), f"{ts}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(sig, expected) and abs(time.time() - int(ts)) < 300`;

export function Docs() {
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div>
        <h1>Docs</h1>
        <p className="muted">How QIE Hooks works, what we send, and how to verify it.</p>
      </div>

      <div className="card">
        <h2>How it works</h2>
        <ol className="muted">
          <li>Our indexer reads every QIE block (CometBFT, 1–2 s finality) across all five public RPC nodes, with failover.</li>
          <li>Logs and native transfers are matched against your hooks. <code>name.qie</code> recipients are resolved through the official QIE ID contracts (via the QIE Wallet MCP) and re-checked every 10 minutes.</li>
          <li>Each match becomes an event with a stable id, stored before delivery. A block range is never skipped: on restart we resume from the last fully stored block, and duplicates are dropped.</li>
          <li>Deliveries retry 6 times over about 8.5 hours (10 s, 1 m, 5 m, 30 m, 2 h, 6 h). You can replay any event from the dashboard or the API.</li>
        </ol>
      </div>

      <div className="card">
        <h2>Triggers</h2>
        <table>
          <thead>
            <tr>
              <th>Trigger</th>
              <th>Event type</th>
              <th>Fires when</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>payment</code>
              </td>
              <td>
                <code>payment.received</code>
              </td>
              <td>Native QIE (successful tx) or a listed ERC-20 lands at the recipient. Only official QUSDC/WQIE count by symbol.</td>
            </tr>
            <tr>
              <td>
                <code>token_transfer</code>
              </td>
              <td>
                <code>token.transfer</code>
              </td>
              <td>A token moves, optionally filtered by from, to and minimum amount.</td>
            </tr>
            <tr>
              <td>
                <code>swap</code>
              </td>
              <td>
                <code>dex.swap</code>
              </td>
              <td>A trade on a QIEDEX pair, with tokens in/out and USD value, optionally above a USD size.</td>
            </tr>
            <tr>
              <td>
                <code>contract_event</code>
              </td>
              <td>
                <code>contract.event</code>
              </td>
              <td>Any of up to 12 events matching Solidity signatures, from one contract or all, with optional argument filters.</td>
            </tr>
            {[
              ["wallet", "wallet.activity", "Anything in or out of an address: QIE and token transfers, contract calls and deployments, including failed transactions."],
              ["balance", "balance.threshold", "Scheduled (every minute): a QIE or token balance goes below or above an amount. Fires once, re-arms when it clears."],
              ["price", "price.threshold", "Scheduled: a token's QIEDEX USD price crosses a level. Fires once, re-arms when it clears."],
              ["name_watch", "name.changed", "Scheduled: a name.qie starts pointing to a different address or stops resolving."],
              ["daily_digest", "digest.daily", "Once a day at the hour you pick (UTC): event count, totals per token and top counterparties of another hook."],
            ].map(([t, e, d]) => (
              <tr key={t}>
                <td>
                  <code>{t}</code>
                </td>
                <td>
                  <code>{e}</code>
                </td>
                <td>{d}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="small faint" style={{ marginTop: 10 }}>
          Scheduled events have <code>tx: null</code> and a <code>link</code> to look at instead.
        </p>
        <p className="small faint" style={{ marginTop: 10 }}>
          Native QIE sent by a contract (an internal transfer) is not seen: QIE's public RPC has no trace API. Token transfers from contracts are seen.
        </p>
      </div>

      <div className="card">
        <h2>Webhook request</h2>
        <p className="muted">
          <code>POST</code> with <code>content-type: application/json</code> and these headers:
        </p>
        <table>
          <tbody>
            <tr>
              <td>
                <code>QieHooks-Signature</code>
              </td>
              <td>
                <code>v1=&lt;hex HMAC-SHA256&gt;</code> of <code>&lt;timestamp&gt;.&lt;raw body&gt;</code> using the hook's secret
              </td>
            </tr>
            <tr>
              <td>
                <code>QieHooks-Timestamp</code>
              </td>
              <td>Unix seconds when we signed it. Reject anything older than 5 minutes.</td>
            </tr>
            <tr>
              <td>
                <code>QieHooks-Event-Id</code>
              </td>
              <td>Stable event id, the same on retries and replays</td>
            </tr>
            <tr>
              <td>
                <code>QieHooks-Event-Type</code>
              </td>
              <td>
                e.g. <code>payment.received</code>
              </td>
            </tr>
          </tbody>
        </table>
        <p className="muted" style={{ marginTop: 12 }}>
          Return any 2xx within 10 seconds. Redirects are not followed. Webhook URLs must be public (no private or loopback addresses).
        </p>
        <h3 style={{ marginTop: 16 }}>Example body</h3>
        <pre className="code">{PAYMENT_EXAMPLE}</pre>
      </div>

      <div className="card">
        <h2>Verify signatures</h2>
        <h3>Node.js with the SDK</h3>
        <pre className="code">{VERIFY_SDK}</pre>
        <h3 style={{ marginTop: 16 }}>Without the SDK</h3>
        <pre className="code">{VERIFY_RAW}</pre>
        <h3 style={{ marginTop: 16 }}>Python</h3>
        <pre className="code">{PYTHON}</pre>
      </div>

      <div className="card">
        <h2>Payment links</h2>
        <p className="muted">
          A hosted checkout page for an exact amount of QUSDC, QIE or WQIE. The customer pays with QIE Wallet or scans a QR code; funds go straight to your
          wallet. QIE transfers have no memo, so when several links for the same amount are open the amount gets a few extra millionths (25.000001) and the
          payment is matched on recipient + token + exact amount. A payment that arrives up to 24 hours after a link expired is still credited.
        </p>
        <p className="muted">
          Get told when a link is paid with a hook of type <code>invoice</code>: it sends <code>invoice.paid</code> with your <code>metadata</code> (e.g. the order
          id), the payer and the transaction. Or poll <code>GET /invoices/:id</code>, or call <code>qh.invoices.waitForPayment(id)</code> from the SDK.
        </p>
      </div>

      <div className="card">
        <h2>Traction pages</h2>
        <p className="muted">
          A public page and README badge showing how many transactions and distinct wallets use your contracts, counted from the chain: every transaction sent
          directly to the contracts, live from the indexer, plus the last 90 days imported from the QIE explorer. Failed transactions are shown but not counted.
          Pages created from the contract's deployer wallet (or its <code>owner()</code>) are marked Verified. See the <a href="#/explore">leaderboard</a>.
        </p>
      </div>

      <div className="card">
        <h2>MCP server for AI agents</h2>
        <p className="muted">
          AI agents (Claude, Cursor, custom agents) can use QIE Hooks as tools over the Model Context Protocol: create payment links and wait for them to be paid,
          create alerts and wait for on-chain events, resolve QIE IDs and read traction. Authenticate with an API key.
        </p>
        <pre className="code">{`# Claude Code
claude mcp add --transport http qiehooks ${window.location.origin}/api/mcp \\
  --header "Authorization: Bearer qh_live_…"

# Any MCP client (Streamable HTTP)
{ "mcpServers": { "qiehooks": {
    "type": "http",
    "url": "${window.location.origin}/api/mcp",
    "headers": { "Authorization": "Bearer qh_live_…" } } } }`}</pre>
        <p className="small muted" style={{ marginTop: 10 }}>
          Tools: <code>create_payment_link</code>, <code>wait_for_payment</code>, <code>get_payment_link</code>, <code>list_payment_links</code>,{" "}
          <code>create_alert</code>, <code>list_alerts</code>, <code>set_alert_active</code>, <code>delete_alert</code>, <code>get_events</code>,{" "}
          <code>wait_for_event</code>, <code>list_telegram_chats</code>, <code>resolve_qie_name</code>, <code>get_traction</code>, <code>network_status</code>.
        </p>
      </div>

      <div className="card">
        <h2>REST API</h2>
        <p className="muted">
          Base URL <code>{window.location.origin}/api</code>. Authenticate with <code>Authorization: Bearer qh_live_…</code>.
        </p>
        <table>
          <tbody>
            {[
              ["GET", "/hooks", "List hooks"],
              ["POST", "/hooks", "Create a hook: { name, trigger: { type, config }, channel: { type, config } }"],
              ["GET", "/hooks/:id", "Get a hook"],
              ["PATCH", "/hooks/:id", "Update a hook (e.g. { active: false })"],
              ["DELETE", "/hooks/:id", "Delete a hook"],
              ["POST", "/hooks/:id/test", "Send a test event now"],
              ["POST", "/hooks/:id/rotate-secret", "Rotate the signing secret"],
              ["GET", "/hooks/:id/events", "Recent events with delivery status"],
              ["POST", "/events/:id/replay", "Deliver an event again"],
              ["POST", "/invoices", "Create a payment link: { amount, token?, description?, recipient?, expiresInMinutes?, metadata?, successUrl? }"],
              ["GET", "/invoices", "List payment links (?status=open|paid|expired|cancelled)"],
              ["GET", "/invoices/:id", "Get a payment link, with the payment once paid"],
              ["POST", "/invoices/:id/cancel", "Cancel an open payment link"],
              ["GET", "/pay/:id", "Public status of a payment link (what the checkout page polls)"],
              ["GET", "/projects", "Public traction leaderboard"],
              ["GET", "/projects/:slug", "Public traction stats of a project"],
              ["GET", "/projects/:slug/badge.svg", "README badge"],
              ["POST", "/my/projects", "Create a traction page: { name, contracts: [0x…], slug?, description?, website?, public? }"],
              ["GET", "/resolve?name=shop.qie", "Resolve a QIE ID"],
              ["GET", "/status", "Public indexer and RPC health"],
            ].map(([m, p, d]) => (
              <tr key={`${m}${p}`}>
                <td>
                  <span className="badge accent">{m}</span>
                </td>
                <td className="mono">{p}</td>
                <td className="muted">{d}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
