# Outreach drafts

Messages to send yourself once the app is live. Replace `<…>`. Keep each personal: mention their project by name and what you set up for them.

## 1. To another Hackathon 3.0 team (traction page already made for them)

> Hey `<name>`! I'm building QIE Pulse for Hackathon 3.0 (dev tooling). I made a live traction page for `<project>` from your contracts on mainnet: `<https://your-app/#/p/slug>`
>
> It counts real wallets and transactions from the chain and gives you a README badge, handy for proving traction to the judges. If you open the dashboard with the wallet that deployed the contract, the page gets a **Verified** badge.
>
> Also free if useful: Telegram/webhook alerts when your contract gets used, or payment links if you take payments. Happy to set it up for you.

## 2. To commerce / payments teams (Patungan, Imole, Payounce, QIE AgentPay…)

> Hi `<name>`, saw `<project>` takes payments on QIE. QIE has no memo field and no push events, so detecting "did this order get paid?" is painful. QIE Pulse has payment links: you create a link per order (API or dashboard), the customer pays with QIE Wallet or a QR, and you get a signed `invoice.paid` webhook with your order id within seconds. Free during the hackathon. Want me to wire it into your checkout? Docs: `<https://your-app/#/docs>`

## 3. To AI-agent teams (AgentPay Guard, Leash, Agent Escrow, Semilla1…)

> Hey `<name>`, QIE Pulse has an MCP server: your agent can create a QUSDC payment link and wait until it's paid in one tool call, or wait for any on-chain event (escrow funded, deposit arrived). One line to add: `claude mcp add --transport http qiepulse <https://your-app>/api/mcp --header "Authorization: Bearer <key>"`. Happy to help you integrate. It'd make a nice demo moment for both of us.

## 4. Community post (QIE Telegram / Discord / X)

> 🪝 **QIE Pulse is live on mainnet**
> • Telegram/Discord/webhook alerts for payments to your .qie, QUSDC whales, QIEDEX swaps, any contract event
> • Payment links: get paid in QUSDC/QIE with a link or QR
> • Traction leaderboard: see which QIE projects real wallets actually use → `<https://your-app/#/explore>`
> • MCP server so AI agents can transact on QIE
> Free to start: `<https://your-app>`

## 5. Hackathon project list for traction pages

Contracts found in public repos are in `scripts/traction-targets.json` (Fluenci, RemitChain, Patungan, Semilla1 Guard). After deploying, run `QIEHOOKS_URL=… QIEHOOKS_KEY=… node scripts/seed-traction.mjs`, then send each team message 1. They claim their page with the "Claim this page" button by signing in with their deployer wallet.
