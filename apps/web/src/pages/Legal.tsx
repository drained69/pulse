import { useApp } from "../App.tsx";

const UPDATED = "21 November 2026";

function Page({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="legal">
      <div className="topbar">
        <div>
          <h1>{title}</h1>
          <p className="faint small" style={{ margin: 0 }}>
            Last updated {UPDATED}
          </p>
        </div>
      </div>
      <div className="card prose">{children}</div>
    </div>
  );
}

export function Terms() {
  const { config } = useApp();
  return (
    <Page title="Terms of service">
      <p>Q-Pulse watches QIE Blockchain for the events you choose and tells you about them. By signing in you agree to these terms.</p>
      <h3>The service</h3>
      <ul>
        <li>
          Alerts are best effort. We store every matched event before delivering it and retry failed deliveries for about 8.5 hours, but we can't promise that every
          event arrives or arrives on time: QIE's public nodes, Telegram, Discord or your server can be down. Don't use an alert as the only record of a payment;
          the chain is the record.
        </li>
        <li>QIE sent by a contract (an internal transfer) is not detected, because QIE's public nodes offer no trace API. Token transfers from contracts are.</li>
        <li>Nothing here is financial advice. Prices come from the QIEDEX API and can be wrong or late.</li>
      </ul>
      <h3>Money</h3>
      <ul>
        <li>Q-Pulse never holds your funds. Payment links send money straight from the payer to the recipient you set; Pro payments go straight to the Q-Pulse treasury through the billing contract.</li>
        <li>
          Blockchain transactions can't be reversed. Check the amount and the recipient before you pay. A Pro payment extends your plan for the period shown on the
          Plan page{config.billingContract ? " and is recorded by the billing contract" : ""}.
        </li>
      </ul>
      <h3>Fair use</h3>
      <ul>
        <li>Don't use Q-Pulse to send spam, to attack the webhook endpoints of others, or to overload QIE's public nodes through the RPC gateway. We rate-limit and may disable abusive hooks or accounts.</li>
        <li>Traction pages must list contracts you have a real connection to. Pages that claim someone else's activity may be removed; the deployer of a contract can always claim its page.</li>
      </ul>
      <h3>Changes and contact</h3>
      <p>
        The service and these terms may change; the date above shows the last update. Questions and problems:{" "}
        <a href="https://github.com/drained69/pulse/issues" target="_blank" rel="noreferrer">
          open an issue on GitHub
        </a>
        .
      </p>
    </Page>
  );
}

export function Privacy() {
  return (
    <Page title="Privacy">
      <p>Q-Pulse keeps only what it needs to run your alerts. There are no ads, no analytics and no tracking cookies.</p>
      <h3>What we store</h3>
      <ul>
        <li>Your wallet address, and its QIE ID (.qie name) if it has one.</li>
        <li>The hooks you create: what they watch and where they deliver (webhook URLs, Discord webhook URLs, linked Telegram chat ids and titles).</li>
        <li>Matched events and their delivery log, deleted after 30 days.</li>
        <li>Your payment links and traction pages. These are public by design: anyone with a payment link sees its amount and recipient, and public traction pages are listed on the leaderboard.</li>
        <li>API keys and sign-in sessions, stored only as one-way hashes.</li>
      </ul>
      <h3>What others can see</h3>
      <ul>
        <li>Everything on QIE Blockchain is public. Alerts are built from public chain data.</li>
        <li>Your IP address is used only in memory, to rate-limit requests. Our host (Railway) and the font service (Google Fonts) receive it as part of serving the page.</li>
        <li>We read names from the QIE ID service and prices from the QIEDEX API. We don't send them anything about you beyond the addresses being looked up.</li>
      </ul>
      <h3>Session cookie</h3>
      <p>One cookie keeps you signed in for 14 days. It is only used for that.</p>
      <h3>Deleting your data</h3>
      <p>
        Sign in and open <a href="#/billing">Plan → Delete account</a>. That deletes your hooks and their events, API keys, linked chats, payment links and traction
        pages at once. On-chain transactions, including Pro payments, stay on chain. Daily database backups are kept for 7 days, so deleted data is gone from them
        within a week.
      </p>
      <h3>Contact</h3>
      <p>
        <a href="https://github.com/drained69/pulse/issues" target="_blank" rel="noreferrer">
          Open an issue on GitHub
        </a>
        .
      </p>
    </Page>
  );
}
