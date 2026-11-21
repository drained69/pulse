import { useEffect, useState } from "react";
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
import { verifyWebhook } from "qpulse-sdk";

const app = express();

// Use the RAW body: the signature covers the exact bytes we sent.
app.post("/qie-webhook", express.raw({ type: "application/json" }), (req, res) => {
  let event;
  try {
    event = verifyWebhook({ body: req.body, headers: req.headers, secret: process.env.QPULSE_SECRET });
  } catch {
    return res.sendStatus(400);
  }
  if (event.type === "payment.received") {
    // Idempotency: the same event can arrive twice (retries, replays). De-duplicate on event.id.
    console.log(\`\${event.data.from.name ?? event.data.from.address} paid \${event.data.amount.display}\`);
  }
  res.sendStatus(200); // anything else is retried
});`;

const VERIFY_RAW = `// Any language: HMAC-SHA256 over "<timestamp>.<raw body>" with your hook's secret.
const ts = req.headers["qpulse-timestamp"];
const expected = crypto.createHmac("sha256", secret).update(\`\${ts}.\${rawBody}\`).digest("hex");
const ok = req.headers["qpulse-signature"] === \`v1=\${expected}\`  // use a constant-time compare
        && Math.abs(Date.now() / 1000 - Number(ts)) < 300;`;

const PYTHON = `import hmac, hashlib, time

def verify(raw_body: bytes, headers, secret: str) -> bool:
    ts = headers["QPulse-Timestamp"]
    sig = headers["QPulse-Signature"].removeprefix("v1=")
    expected = hmac.new(secret.encode(), f"{ts}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(sig, expected) and abs(time.time() - int(ts)) < 300`;

const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Table of contents built from the section headings, with the section in view highlighted. */
export function DocsToc({ page = "docs" }: { page?: string }) {
  const [items, setItems] = useState<{ id: string; label: string }[]>([]);
  const [current, setCurrent] = useState("");
  useEffect(() => {
    const heads = [...document.querySelectorAll<HTMLHeadingElement>(".docs-body > .card > h2")];
    heads.forEach((h) => (h.id ||= slug(h.textContent ?? "")));
    setItems(heads.map((h) => ({ id: h.id, label: h.textContent ?? "" })));
    // The current section is the last heading scrolled above the header line.
    const onScroll = () => {
      let id = heads[0]?.id ?? "";
      for (const h of heads) if (h.getBoundingClientRect().top < 200) id = h.id;
      if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 4) id = heads.at(-1)?.id ?? id;
      setCurrent(id);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return (
    <nav className="docs-toc" aria-label="On this page">
      <div className="eyebrow" style={{ marginBottom: 8 }}>
        On this page
      </div>
      {items.map((it) => (
        <a
          key={it.id}
          href={`#/${page}`}
          className={current === it.id ? "on" : ""}
          onClick={(e) => {
            e.preventDefault();
            document.getElementById(it.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
          }}
        >
          {it.label}
        </a>
      ))}
    </nav>
  );
}

export function Docs() {
  const wsUrl = `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/rpc`;
  return (
    <div>
      <div className="topbar">
        <div>
          <h1>Docs</h1>
          <p className="muted" style={{ margin: 0 }}>
            The technical reference: triggers, payloads, signatures, API and limits. New here? Start with the <a href="#/guide">step-by-step guide</a>.
          </p>
        </div>
      </div>
      <div className="docs-layout">
        <DocsToc />
        <div className="stack docs-body" style={{ gap: 16 }}>

      <div className="card">
        <h2>How it works</h2>
        <ol className="muted">
          <li>Our indexer reads every QIE block (one every ~4 s, final when produced thanks to CometBFT) across all five public RPC nodes, with failover.</li>
          <li>Logs and native transfers are matched against your hooks. <code>name.qie</code> recipients are resolved through the official QIE ID contracts (via the QIE Wallet MCP) and re-checked every 10 minutes.</li>
          <li>Each match becomes an event with a stable id, stored before delivery. A block range is never skipped: on restart we resume from the last fully stored block, and duplicates are dropped.</li>
          <li>Deliveries retry 6 times over about 8.5 hours (10 s, 1 m, 5 m, 30 m, 2 h, 6 h). You can replay any event from the dashboard or the API.</li>
        </ol>
      </div>

      <div className="card">
        <h2>Triggers</h2>
        <div className="table-wrap">
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
              ["wallet", "wallet.activity", "Anything in or out of an address: QIE and token transfers, contract calls and deployments, including failed transactions. Lookalike addresses and zero-value transfers are flagged (data.security)."],
              ["liquidity", "liquidity.drop", "Rug-pull radar: a QIEDEX pair's liquidity falls a chosen share (default 30%) below its peak of the last 24 hours. Fires once, re-arms after it recovers."],
              ["balance", "balance.threshold", "Scheduled (every minute): a QIE or token balance goes below or above an amount. Fires once, re-arms when it clears."],
              ["price", "price.threshold", "Scheduled: a token's QIEDEX USD price crosses a level. Fires once, re-arms when it clears."],
              ["name_watch", "name.changed", "Scheduled: a name.qie starts pointing to a different address or stops resolving."],
              ["daily_digest", "digest.daily", "Once a day at the hour you pick (UTC): event count, totals per token and top counterparties of another hook."],
              ["invoice", "invoice.paid", "Any of your payment links or product sales is paid. Carries your metadata, the product (for a sale), the payer and the transaction."],
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
        </div>
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
                <code>QPulse-Signature</code>
              </td>
              <td>
                <code>v1=&lt;hex HMAC-SHA256&gt;</code> of <code>&lt;timestamp&gt;.&lt;raw body&gt;</code> using the hook's secret
              </td>
            </tr>
            <tr>
              <td>
                <code>QPulse-Timestamp</code>
              </td>
              <td>Unix seconds when we signed it. Reject anything older than 5 minutes.</td>
            </tr>
            <tr>
              <td>
                <code>QPulse-Event-Id</code>
              </td>
              <td>Stable event id, the same on retries and replays</td>
            </tr>
            <tr>
              <td>
                <code>QPulse-Event-Type</code>
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
          id), the payer and the transaction. Or poll <code>GET /invoices/:id</code>, or call <code>qp.invoices.waitForPayment(id)</code> from the SDK.
        </p>
      </div>

      <div className="card">
        <h2>Products and devices</h2>
        <p className="muted">
          A product is a permanent link (and QR code) for something you sell again and again: a file, a licence, a coffee, a locker. Every buyer who opens it gets
          their own payment link with an exact amount, valid for 15 minutes, so payments are matched without a memo. After paying, the buyer sees the product's
          unlock content (a download link, licence key or door code) on the checkout page, and only then.
        </p>
        <p className="muted">
          Each sale fires <code>invoice.paid</code> with <code>data.product</code>, so a machine can act on it. Point an <code>invoice</code> hook at a small
          receiver on the device: it checks the signature and switches a relay. A ready-made one is in <code>examples/device-receiver</code> in the repository
          (no dependencies). The <b>Device view</b> button on each product opens a demo screen that unlocks live when the product is paid.
        </p>
        <pre className="code">{`await qp.products.create({ name: "Locker 1", amount: "0.5", unlockContent: "Door code 4812" });
// → { url: "…/#/buy/prd_…", deviceUrl: "…/#/device/prd_…" }: print the url as a QR code`}</pre>
      </div>

      <div className="card">
        <h2>Charge per request (HTTP 402)</h2>
        <p className="muted">
          Sell API calls to people and AI agents in QUSDC. A request without payment gets <code>402 Payment Required</code> with a payment link. The caller pays it
          with any QIE wallet and repeats the request with the header <code>X-QPulse-Payment: inv_…</code>. The middleware checks the link was made for this
          price and is paid, then uses it up: one payment buys exactly one request.
        </p>
        <pre className="code">{`import express from "express";
import { QPulse, paywall } from "qpulse-sdk";

const qp = new QPulse({ apiKey: process.env.QPULSE_KEY! });
const app = express();
app.get("/forecast", paywall({ client: qp, id: "forecast", amount: "0.05" }), (req, res) => {
  res.json({ forecast: "sunny", paidBy: req.qpulsePayment.payment.from });
});`}</pre>
        <p className="muted small" style={{ margin: 0 }}>
          Not on Node? Call <code>POST /api/invoices</code> to ask for payment and <code>POST /api/invoices/:id/redeem</code> to use a payment up (402 = not paid
          yet, 409 = already used).
        </p>
      </div>

      <div className="card">
        <h2>Scam guards</h2>
        <p className="muted">
          <b>Address poisoning.</b> Scammers send zero-value or tiny transfers from an address that starts and ends like one you use, hoping you copy it from your
          history. Wallet and payment alerts carry a warning, and <code>data.security</code> in webhooks, when a counterparty imitates an address the hook has
          seen before, or a token transfer is worth zero. Zero-value transfers never count as payments. Template: <a href="#/hooks/new/poisoning">Address
          poisoning guard</a>.
        </p>
        <p className="muted" style={{ margin: 0 }}>
          <b>Rug pulls.</b> The <code>liquidity</code> trigger follows a QIEDEX pair's depth (√(reserve0 × reserve1)) through every Sync event and alerts when it falls
          a chosen share below its 24-hour peak. Template: <a href="#/hooks/new/rugpull">Rug-pull radar</a>.
        </p>
      </div>

      <div className="card">
        <h2>Traction pages</h2>
        <p className="muted">
          A public page and README badge showing how many transactions and distinct wallets use your contracts, counted from the chain: every transaction sent
          directly to the contracts, live from the indexer, plus the last 90 days imported from the QIE explorer. Failed transactions are shown but not counted.
          Pages created from the contract's deployer wallet (or its <code>owner()</code>) are marked Verified. See the <a href="#/explore">leaderboard</a>.
        </p>
        <p className="muted">
          Once a day every project's 30-day numbers (and a hash of the exact transaction set) become a leaf in a Merkle tree whose root is posted to the{" "}
          <code>PulseAttestations</code> contract on QIE. Each page has a <em>Verify in your browser</em> button that recounts the numbers from QIE's explorer
          and checks them against that root, read straight from a QIE node. From a terminal: <code>pnpm verify-traction &lt;slug&gt; --api {window.location.origin}</code>.
        </p>
      </div>

      <div className="card">
        <h2>WebSocket RPC (eth_subscribe)</h2>
        <p className="muted">
          QIE's public nodes reject <code>eth_subscribe</code>. Use <code>{wsUrl}</code> instead and standard libraries stream events on QIE: viem's{" "}
          <code>watchContractEvent</code> / <code>watchBlocks</code>, ethers' <code>contract.on()</code>, or raw <code>eth_subscribe("newHeads" | "logs")</code>.
          Every other JSON-RPC call is forwarded to the five QIE nodes with failover. Over plain HTTP (<code>{window.location.origin}/rpc</code>),{" "}
          <code>eth_newFilter</code> / <code>eth_getFilterChanges</code> work across nodes too. No API key needed.
        </p>
        <pre className="code">{`import { createPublicClient, webSocket, parseAbi } from "viem";

const client = createPublicClient({ transport: webSocket("${wsUrl}") });

client.watchContractEvent({
  address: "0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5", // QUSDC
  abi: parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]),
  eventName: "Transfer",
  onLogs: (logs) => logs.forEach((l) => console.log(l.args.from, "→", l.args.to, l.args.value)),
});`}</pre>
        <p className="small muted" style={{ marginTop: 10 }}>
          Limits per IP: 20 connections, 25 requests/s (bursts of 100), 100 subscriptions per connection. Live numbers and latency are on the{" "}
          <a href="#/status">status page</a>.
        </p>
      </div>

      <div className="card">
        <h2>MCP server for AI agents</h2>
        <p className="muted">
          AI agents (Claude, Cursor, custom agents) can use Q-Pulse as tools over the Model Context Protocol: create payment links and wait for them to be paid,
          create alerts and wait for on-chain events, resolve QIE IDs and read traction. Authenticate with an API key.
        </p>
        <pre className="code">{`# Claude Code
claude mcp add --transport http qpulse ${window.location.origin}/api/mcp \\
  --header "Authorization: Bearer qp_live_…"

# Any MCP client (Streamable HTTP)
{ "mcpServers": { "qpulse": {
    "type": "http",
    "url": "${window.location.origin}/api/mcp",
    "headers": { "Authorization": "Bearer qp_live_…" } } } }`}</pre>
        <p className="small muted" style={{ marginTop: 10 }}>
          Tools: <code>create_payment_link</code>, <code>wait_for_payment</code>, <code>get_payment_link</code>, <code>list_payment_links</code>,{" "}
          <code>create_alert</code>, <code>list_alerts</code>, <code>set_alert_active</code>, <code>delete_alert</code>, <code>get_events</code>,{" "}
          <code>wait_for_event</code>, <code>create_product</code>, <code>list_products</code>, <code>list_telegram_chats</code>, <code>resolve_qie_name</code>,{" "}
          <code>get_traction</code>, <code>network_status</code> (16 in all).
        </p>
      </div>

      <div className="card">
        <h2>REST API</h2>
        <p className="muted">
          Base URL <code>{window.location.origin}/api</code>. Authenticate with <code>Authorization: Bearer qp_live_…</code>.
        </p>
        <div className="table-wrap">
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
              ["POST", "/invoices/:id/redeem", "Use a paid link up once (pay-per-request). 402 = not paid, 409 = already used"],
              ["POST", "/products", "Create a product: { name, amount, token?, description?, unlockContent?, recipient? }"],
              ["GET", "/products", "List products with sales"],
              ["PATCH", "/products/:id", "Update or pause a product ({ active: false })"],
              ["GET", "/shop/:id", "Public product page data (no unlock content)"],
              ["POST", "/shop/:id/buy", "Open a fresh 15-minute checkout for a buyer (public, rate-limited)"],
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
        </div>
      </div>
    </div>
  );
}
