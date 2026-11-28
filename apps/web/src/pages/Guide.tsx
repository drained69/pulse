import { useEffect, type ReactNode } from "react";
import { useApp } from "../App.tsx";
import { Icon } from "../icons.tsx";
import { DocsToc } from "./Docs.tsx";

/** "How to use Q-Pulse": one step-by-step guide per kind of user, every step pointing at the real screen. */

function Steps({ children }: { children: ReactNode }) {
  return <ol className="guide-steps">{children}</ol>;
}

function Section({ id, icon, title, who, needs, children }: { id: string; icon: string; title: string; who: string; needs: string; children: ReactNode }) {
  return (
    <div className="card guide-card">
      <h2 id={id}>{title}</h2>
      <div className="row guide-meta">
        <span className="tile-ico" aria-hidden>
          <Icon name={icon} size={17} />
        </span>
        <span>
          <b>For:</b> {who}
        </span>
        <span>
          <b>You need:</b> {needs}
        </span>
      </div>
      {children}
    </div>
  );
}

const Note = ({ children }: { children: ReactNode }) => <p className="small muted guide-note">{children}</p>;

export function Guide({ section }: { section?: string }) {
  const { config, me } = useApp();
  // #/guide/<section> opens the page at that guide (the landing page links straight to each one).
  useEffect(() => {
    if (!section) return;
    const t = setTimeout(() => document.getElementById(section)?.scrollIntoView({ block: "start" }), 50);
    return () => clearTimeout(t);
  }, [section]);
  const origin = window.location.origin;
  const wsUrl = `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/rpc`;
  const bot = config.telegram.botUsername;
  const free = config.plans.free;
  const pro = config.plans.pro;
  const startHref = me ? "#/hooks/new" : "#/";

  return (
    <div>
      <div className="topbar">
        <div>
          <h1>How to use Q-Pulse</h1>
          <p className="muted" style={{ margin: 0, maxWidth: 720 }}>
            Pick what you want to do. Most guides take two or three minutes and need no code. Every step names the exact button in the app.
          </p>
        </div>
      </div>
      <div className="docs-layout">
        <DocsToc page="guide" />
        <div className="stack docs-body" style={{ gap: 16 }}>
          <div className="card">
            <h2 id="start">Before you start</h2>
            <Steps>
              <li>
                <b>Have a wallet on QIE.</b> QIE Wallet (browser extension or app) or MetaMask with QIE mainnet added (chain ID {config.chainId}, RPC{" "}
                <code>{config.rpcUrl}</code>). Any wallet works for paying; you only need one to sign in.
              </li>
              <li>
                <b>Sign in.</b> Press <b>Get started</b> at the top of the page and approve the signature request in your wallet. Signing in is free: it sends no
                transaction and costs no gas. Your account is your wallet address, so there is no password or email to remember.
              </li>
              <li>
                <b>Decide where alerts should go.</b> Pick one when you create a hook:
                <ul>
                  <li>
                    <b>Telegram:</b> link a chat once under <b>your account menu → Telegram → Connect a chat</b>
                    {bot ? (
                      <>
                        {" "}
                        (the bot is <b>@{bot}</b>)
                      </>
                    ) : null}
                    . It can be your own chat, a staff group or a channel.
                  </li>
                  <li>
                    <b>Discord:</b> in Discord open the channel's settings → <b>Integrations → Webhooks → New Webhook → Copy Webhook URL</b>, then paste it into
                    the hook. Q-Pulse stores it and only ever shows it masked.
                  </li>
                  <li>
                    <b>Your own server:</b> a public HTTPS URL that receives a signed <code>POST</code> for every event (see the developer guide below).
                  </li>
                </ul>
              </li>
            </Steps>
            <Note>
              Free plan: {free.maxHooks} hooks and {free.monthlyEvents.toLocaleString()} events a month, every feature included. Pro: {config.proPriceQusdc} QUSDC
              for {config.proPeriodDays} days, {pro.maxHooks} hooks and {pro.monthlyEvents.toLocaleString()} events a month. Details under{" "}
              <a href="#/guide" onClick={(e) => (e.preventDefault(), document.getElementById("plans")?.scrollIntoView({ behavior: "smooth" }))}>
                Plans and limits
              </a>
              .
            </Note>
          </div>

          <Section id="shops" icon="bag" title="Get told the moment you're paid" who="shops, freelancers, creators, anyone who receives QIE or QUSDC" needs="a wallet or name.qie that receives payments">
            <Steps>
              <li>
                Open <b>Hooks → + New hook</b> and choose the <b>Shop payments</b> template.
              </li>
              <li>
                Under <b>Recipient</b>, type your QIE ID (for example <code>shop.qie</code>) or your wallet address. A QIE ID is resolved live and re-checked every 10
                minutes, so if you point it to a new wallet the hook follows.
              </li>
              <li>
                Choose which assets count (QIE, QUSDC, WQIE) and, if you like, a minimum amount so small transfers don't ping you.
              </li>
              <li>
                Choose <b>Telegram</b> or <b>Discord</b>, then <b>Create</b>. On the hook's page press <b>Send test</b> to check the message arrives.
              </li>
            </Steps>
            <p className="muted">
              From now on every payment arrives within seconds of its block: the amount, its USD value, who paid (by QIE ID when they have one) and a link to the
              transaction on the QIE explorer. Only the official QUSDC and WQIE contracts count, so a copycat token with the same name never looks like a payment.
            </p>
            <Note>
              Want a daily total instead of one message per payment? Add a <b>Daily sales summary</b> hook that summarises this one at the hour you pick.
            </Note>
          </Section>

          <Section id="invoices" icon="receipt" title="Ask for an exact amount with a payment link" who="anyone sending an invoice or taking an order" needs="nothing but a signed-in account">
            <Steps>
              <li>
                Open <b>Payment links</b>. Enter the amount, the token (QUSDC, QIE or WQIE) and what it's for. The money goes to your signed-in wallet unless you
                enter another address or <code>name.qie</code> under <b>Pay to</b>.
              </li>
              <li>
                Press <b>Create link</b> and send the link to your customer by chat, email or as a QR code.
              </li>
              <li>
                Your customer opens it and pays with the <b>QIE Wallet</b> button, or scans the QR code with any wallet. The page switches to <b>Paid</b> as soon as
                the transfer is in a block, and shows the transaction.
              </li>
              <li>
                Follow every link under <b>Your links</b>. To be told automatically, create a hook from the <b>Payment link paid</b> template.
              </li>
            </Steps>
            <p className="muted">
              QIE transfers can't carry an order number, so Q-Pulse tells links apart by amount: when two open links ask for the same amount, the second asks for a
              few millionths more (25.000001 QUSDC). The checkout page always shows the exact figure, and the QIE Wallet button fills it in. Funds go straight from
              your customer to you: Q-Pulse never holds them. A payment that arrives up to 24 hours after a link expired is still recorded.
            </p>
          </Section>

          <Section
            id="products"
            icon="unlock"
            title="Sell the same thing again and again, with a QR code"
            who="digital downloads, licence keys, coffee, vending machines, lockers, event entry"
            needs="a signed-in account; a screen or small computer if a device should unlock"
          >
            <Steps>
              <li>
                Open <b>Payment links</b> and press <b>New product</b>. Give it a name and a price.
              </li>
              <li>
                Optionally fill in <b>unlock content</b>: what the buyer sees after paying, such as a download link, a licence key or a door code (up to 2,000
                characters). It is never shown before payment.
              </li>
              <li>
                Share the product's link, or press <b>QR</b> and print the code. The link never changes, so it can live on a poster, a menu or a machine.
              </li>
              <li>
                Every buyer who opens it gets their own checkout for 15 minutes. After paying they see the unlock content, and your <b>Payment link paid</b> hooks
                fire with the product's name.
              </li>
              <li>
                Press <b>Device view</b> to open a full-screen page for a tablet or display next to the item: it shows the QR code and unlocks live with every sale.
              </li>
            </Steps>
            <Note>
              To switch real hardware (a relay, a lock, a light), point a <b>Payment link paid</b> hook at a small receiver on the device. A ready-made one with no
              dependencies is in{" "}
              <a href="https://github.com/drained69/pulse/tree/main/examples/device-receiver" target="_blank" rel="noreferrer">
                examples/device-receiver
              </a>
              : it checks the signature, ignores repeats and runs your command.
            </Note>
          </Section>

          <Section id="protect" icon="shield" title="Protect your wallet and your trades" who="anyone holding QIE, QUSDC or other QIE tokens" needs="the wallet address or QIEDEX pair you care about">
            <p className="muted">
              Open <b>Hooks → + New hook</b>, pick one of these templates, fill in the address, choose Telegram or Discord and press <b>Create</b>:
            </p>
            <div className="table-wrap">
              <table>
                <tbody>
                  {[
                    ["Watch a wallet", "Everything in and out of a wallet: QIE and token transfers, contract calls, failed transactions."],
                    ["Address poisoning guard", "Warns when someone sends a zero-value or tiny transfer from an address that starts and ends like one you use, hoping you copy it from your history."],
                    ["Token approvals", "Alerts when your wallet approves a contract to spend its tokens, so an approval you didn't mean to give is caught fast."],
                    ["Rug-pull radar", "Alerts when a QIEDEX pair you hold loses a chosen share (default 30%) of its liquidity compared with its peak in the last 24 hours."],
                    ["WQIE price alert", "Alerts once when the QIEDEX price crosses a level you set, then re-arms when it moves back."],
                    ["Low gas wallet", "Alerts when a wallet's QIE balance drops below an amount, before a bot or service runs out of gas."],
                    ["Watch my .qie name", "Alerts if your QIE ID starts pointing to a different address or stops resolving."],
                  ].map(([t, d]) => (
                    <tr key={t}>
                      <td style={{ whiteSpace: "nowrap" }}>
                        <b>{t}</b>
                      </td>
                      <td className="muted">{d}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Note>Q-Pulse only reads the public chain. It never asks for your seed phrase or private key and can't move anything in your wallet.</Note>
          </Section>

          <Section id="community" icon="megaphone" title="Feed a Discord or Telegram community" who="communities, DAOs, trading groups, project channels" needs="admin rights in the Discord channel or Telegram group">
            <Steps>
              <li>
                <b>Discord:</b> copy a channel webhook URL (channel settings → Integrations → Webhooks → New Webhook → Copy Webhook URL).{" "}
                <b>Telegram:</b> open <b>Telegram → Connect a chat</b>, add {bot ? <b>@{bot}</b> : "the bot"} to the group (to a channel as an admin that can post) and
                send the <code>/link</code> code shown there in the group.
              </li>
              <li>
                Create a hook for each feed you want. Good ones for a community: <b>QUSDC whale moves</b> (large transfers), <b>New QIEDEX pairs</b> (every new
                trading pair), <b>Rug-pull radar</b> on your token's pair, or <b>Contract admin changes</b> on your project's contracts.
              </li>
              <li>
                For your own project's activity, start from <b>Hooks → + New hook</b>, choose the <b>Contract event</b> trigger, paste the contract address and the
                event lines from its source (for example <code>event Deposit(address indexed user, uint256 amount)</code>). Messages show the decoded values.
              </li>
            </Steps>
          </Section>

          <Section id="traction" icon="trending" title="Show your project's real usage" who="teams building on QIE" needs="your contract addresses (up to 10)">
            <Steps>
              <li>
                Open <b>Traction → New traction page</b>. Enter the project name, its contract addresses, a website and a short description, then create it.
              </li>
              <li>
                Q-Pulse imports the last 90 days of transactions from the QIE explorer and counts every new one live. The page shows transactions, distinct
                wallets, returning wallets, failed transactions and how concentrated usage is among the top 10 wallets.
              </li>
              <li>
                Create it while signed in with the wallet that deployed one of the contracts (or the contract's <code>owner()</code>) and it gets a{" "}
                <b>Verified</b> badge. Otherwise anyone could list your contracts, but only you can verify them.
              </li>
              <li>
                Copy the badge snippet from the page into your README or website. It shows live numbers and links back to the page.
              </li>
              <li>
                Public pages join the <a href="#/explore">Leaderboard</a>, ranked by wallets in the last 7 days.
              </li>
            </Steps>
            <Note>
              Every day each project's 30-day numbers are committed to the PulseAttestations contract on QIE, so anyone can check them (next guide).
            </Note>
          </Section>

          <Section id="verify" icon="check" title="Check any project's numbers yourself" who="investors, partners, users, anyone deciding whom to trust" needs="nothing: no account, no wallet">
            <Steps>
              <li>
                Open the <a href="#/explore">Leaderboard</a> and pick a project, or open a link someone shared with you.
              </li>
              <li>
                Press <b>Verify in your browser</b>. Your browser, not our server, fetches the project's transactions from QIE's own explorer, recounts them,
                rebuilds that day's record and checks it against the root stored on chain, read directly from a QIE node.
              </li>
              <li>All checks green means the numbers on the page match the chain. A red check says exactly which part doesn't.</li>
            </Steps>
            <p className="muted">From a terminal, with the repository checked out:</p>
            <pre className="code">{`pnpm verify-traction <project> --api ${origin}`}</pre>
          </Section>

          <Section id="developers" icon="zap" title="Build it into your app" who="developers" needs="an API key (free) and Node 18+ for the SDK, or any HTTP client">
            <Steps>
              <li>
                Create a key under <b>your account menu → API keys → Create key</b>. It is shown once; store it as a secret, never in front-end code.
              </li>
              <li>
                Install the SDK: <code>npm install qpulse-sdk</code>. Create hooks, payment links and products from code:
              </li>
            </Steps>
            <pre className="code">{`import { QPulse, verifyWebhook } from "qpulse-sdk";

const qp = new QPulse({ apiKey: process.env.QPULSE_KEY });

// 1. Get a signed POST for every payment to your shop
const hook = await qp.onPayment("shop.qie", { url: "https://shop.example.com/qie-webhook" });
// keep hook.secret: it verifies deliveries

// 2. Or ask for an exact amount per order
const link = await qp.invoices.create({ amount: "25", token: "QUSDC", metadata: { orderId: "1042" } });
// send the customer to link.url; you get invoice.paid with orderId

// 3. Verify every delivery
app.post("/qie-webhook", express.raw({ type: "application/json" }), (req, res) => {
  const event = verifyWebhook({ body: req.body, headers: req.headers, secret: process.env.QPULSE_SECRET });
  // de-duplicate on event.id: retries and replays repeat it
  res.sendStatus(200);
});`}</pre>
            <ul className="muted">
              <li>Answer with any 2xx within 10 seconds. Otherwise the delivery is retried 6 times over about 8.5 hours, and you can replay any event later.</li>
              <li>
                Sell API calls per request in QUSDC with the <code>paywall()</code> middleware (HTTP 402): one payment buys exactly one request.
              </li>
              <li>
                Stream QIE events with standard libraries: point viem, ethers or web3 at <code>{wsUrl}</code> and <code>eth_subscribe</code> works. No key needed.
              </li>
            </ul>
            <Note>
              Every endpoint, trigger, payload and signature format is in the <a href="#/docs">Docs</a>.
            </Note>
          </Section>

          <Section id="agents" icon="chat" title="Let an AI agent take payments and watch QIE" who="people using Claude, Cursor or their own agents" needs="an API key">
            <Steps>
              <li>
                Create an API key (<b>your account menu → API keys</b>).
              </li>
              <li>Add Q-Pulse to your agent as an MCP server. For Claude Code:</li>
            </Steps>
            <pre className="code">{`claude mcp add --transport http qpulse ${origin}/api/mcp \\
  --header "Authorization: Bearer qp_live_…"`}</pre>
            <p className="muted">Then ask in plain words, for example:</p>
            <ul className="muted">
              <li>“Create a 5 QUSDC payment link for the logo design and tell me when it's paid.”</li>
              <li>“Message my Telegram whenever shop.qie receives more than 100 QUSDC.”</li>
              <li>“Sell my e-book for 3 QUSDC and show the download link only after payment.”</li>
              <li>“How many wallets used Patungan this week?”</li>
            </ul>
            <Note>
              The agent gets 17 tools: payment links, products, alerts, events, QIE ID lookup, traction and network status. It acts only through your API key and
              can't move funds: payments always go from the payer's wallet straight to yours.
            </Note>
          </Section>

          <div className="card">
            <h2 id="plans">Plans and limits</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th />
                    <th>Free</th>
                    <th>Pro</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Price</td>
                    <td>Free</td>
                    <td>
                      {config.proPriceQusdc} QUSDC per {config.proPeriodDays} days
                    </td>
                  </tr>
                  <tr>
                    <td>Hooks</td>
                    <td>{free.maxHooks}</td>
                    <td>{pro.maxHooks}</td>
                  </tr>
                  <tr>
                    <td>Events a month</td>
                    <td>{free.monthlyEvents.toLocaleString()}</td>
                    <td>{pro.monthlyEvents.toLocaleString()}</td>
                  </tr>
                  <tr>
                    <td>Payment links, products, traction pages, API, MCP, WebSocket RPC</td>
                    <td>Included</td>
                    <td>Included</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <ul className="muted">
              <li>
                Pro is paid on the <b>Plan</b> page with QUSDC from your wallet, through the{" "}
                <a href={`${config.explorerUrl}/address/${config.billingContract}`} target="_blank" rel="noreferrer">
                  Q-Pulse billing contract
                </a>
                . It never renews by itself: you pay for each period, and paying again extends it.
              </li>
              <li>
                When a month's events run out, new events are still recorded in your history but not delivered until the next month or an upgrade. Counting
                restarts on the 1st (UTC).
              </li>
              <li>
                You can delete your account and everything in it at any time on the <b>Plan</b> page.
              </li>
            </ul>
          </div>

          <div className="card">
            <h2 id="faq">Common questions</h2>
            <dl className="guide-faq">
              <dt>Does Q-Pulse hold my money or my keys?</dt>
              <dd>No. Payments go from the payer's wallet straight to yours, and Q-Pulse never sees a private key. Signing in only proves you own the address.</dd>
              <dt>How fast are alerts?</dt>
              <dd>
                QIE makes a block about every 4 seconds and a block is final as soon as it is made. Alerts are sent seconds after that; live latency figures are
                on the <a href="#/status">Status</a> page.
              </dd>
              <dt>What if my server or bot is down?</dt>
              <dd>Every event is stored before it is sent and retried for about 8.5 hours. Missed events can be replayed from the hook's page or the API.</dd>
              <dt>Is anything not seen?</dt>
              <dd>
                QIE sent by a contract as part of another call (an internal transfer) isn't visible through QIE's public nodes. Token transfers from contracts
                are seen.
              </dd>
              <dt>Which wallets work?</dt>
              <dd>QIE Wallet and MetaMask to sign in. Any QIE wallet, or a QR scan, to pay a link.</dd>
            </dl>
          </div>

          <div className="card guide-cta">
            <h2>Ready?</h2>
            <p className="muted">Start with one hook. It takes about a minute, and you can test it before any real payment arrives.</p>
            <a className="btn primary" href={startHref}>
              {me ? "Create your first hook" : "Get started, free"} <span className="arrow">→</span>
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
