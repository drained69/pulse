# Launch checklist: QIE Hackathon 3.0

Deadline: **23:59 CET, 30 Nov 2026**. Demo week Dec 1–5. Winners Dec 10. Half of each prize is held back for 90-day traction milestones.

## Must do before submitting

- [ ] **Register the team** at hackathon.qie.digital, if you haven't already.
- [ ] **Read and own the code.** The hackathon encourages AI-assisted development, but teams must "fully understand and maintain their code and be able to explain architecture to judges". Walk through `apps/server/src/indexer.ts`, `triggers.ts`, `delivery.ts` and `contracts/src/QieHooksBilling.sol` until you can explain them without notes. Change things you'd do differently, and commit as you go so the history shows your work.
- [ ] **Push to a public GitHub repo** (judges review originality and effort).
- [ ] **Telegram bot**: @BotFather → `/newbot` (e.g. `QieHooksBot`) and set a profile picture and description.
- [ ] **Deploy the billing contract to mainnet** (README → Deploy). Use a keystore, not a pasted key. Treasury = your QIE Safe.
- [ ] **Verify the contract** on mainnet.qie.digital. This is a submission requirement ("deployed contract address").
- [ ] **Deploy the server** (Fly.io or any VPS with a disk) with `PUBLIC_URL`, `TELEGRAM_BOT_TOKEN` and `BILLING_CONTRACT`. Check `/#/status` shows 5/5 RPC nodes and lag 0.
- [ ] **Publish the SDK**: `cd packages/sdk && npm publish --access public` (needs an npm org `@qiehooks`, or rename the package).
- [ ] **Public whale-alert channel**: create a Telegram channel such as "QIE Whale Alerts", add the bot as admin, and set `PUBLIC_ALERTS_CHAT_ID`. This gets you community users with zero setup.
- [ ] **Submit**: repo URL, live demo URL, contract address, track = Developer Infrastructure & Tooling.

## Traction plan (judges reward real usage; milestones pay the second 50%)

The best early users are other Hackathon 3.0 teams, who need "payment received" alerts right now.

1. Post in the QIE developer Telegram and Discord: "Free real-time webhooks/Telegram alerts for your QIE dApp: payments to your .qie name, QUSDC, QIEDEX swaps, any contract event. Setup takes 1 minute." Link the dashboard.
2. DM teams building payments, POS, escrow or games (search GitHub for `QIE Hackathon 3.0`, e.g. Patungan, MerchantPay, Agent Escrow, AgentPay Guard). Offer to set up their hook for them.
3. **Traction pages are the hook for other teams.** Every Hackathon 3.0 team must prove usage to judges. Create a traction page for each team's contracts yourself (the data is public), then send them the link: "Your live traction page and README badge are ready. Sign in from your deployer wallet to get the Verified badge." Post the leaderboard (`#/explore`) in the hackathon channels.
4. **Payment links for the commerce teams** (Patungan, Imole, Payounce, QIE AgentPay): offer them checkout links + `invoice.paid` webhooks instead of writing their own payment detection.
5. **MCP for the AI-agent teams** (AgentPay Guard, Leash, Agent Escrow, Semilla1): their agents can create payment links and wait for payment with one tool call.
6. Launch the public whale-alert channel and share it in the QIE community (13K on X, 24K on Discord).
7. Track what the status page already shows: active hooks, developers, events matched, delivery success rate. Screenshot it daily for the demo.

Milestone-friendly metrics QIE Hooks produces naturally: **projects on the leaderboard**, **payment-link volume in QUSDC**, **developers / dApps integrated** (users), **events delivered** (usage), **recurring users** (hooks keep firing every day), **Pro subscriptions in QUSDC** (on-chain revenue).

## 3-minute demo script

1. **Problem (20 s)**: "QIE's RPC can't push events. Every dApp polls. Here's what that costs a shop owner: they don't know a customer paid."
2. **Create (40 s)**: sign in with QIE Wallet → New hook → Payment received → type `shop.qie` (show it resolve live) → Telegram → Create.
3. **Wow (40 s)**: on a phone, pay `shop.qie` 1 QUSDC from QIE Wallet. The Telegram message lands about 2 seconds later: "💸 shop.qie received 1 QUSDC, from alice.qie".
4. **For developers (40 s)**: show the webhook event log (signed, retried, replayable) and the 10-line SDK snippet. Mention any-contract events and QIEDEX swaps.
5. **Payment link (30 s)**: create a 1 QUSDC link, scan its QR with your phone, pay. The checkout flips to "Paid" and the `invoice.paid` Telegram alert lands at the same time.
6. **AI agent (20 s)**: in Claude with the QIE Hooks MCP server: "Create a 2 QUSDC payment link for the logo and tell me when it's paid." Pay it; Claude reports the payer and the transaction.
7. **Proof (30 s)**: the leaderboard and QIE Hooks' own traction page (its badge is in the README), status page (5 RPC nodes, live block), verified billing contract.

(Steps 5–7 make the demo run over 3 minutes: drop step 4 if time is short.)

## Ideas after the hackathon

- Postgres + multiple indexer workers; a hosted free tier for the whole ecosystem.
- Address-activity triggers and NFT (ERC-721) triggers.
- Sanctions and counterparty screening and QIE ID trust-score filters, once QIE ships those APIs (on the Dec 2026 roadmap).
- A "notify me" button any QIE dApp can embed for its own users.
- Payment links with line items and receipts; recurring payment links (subscriptions) in QUSDC.
- Traction pages that also count token volume and internal calls (needs a trace API on QIE).
