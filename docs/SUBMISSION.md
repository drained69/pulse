# Hackathon 3.0 submission pack

Everything to paste into the submission form, plus the demo video and presentation outlines.
Replace `<…>` placeholders once deployed. Deadline: **23:59 CET, 30 November 2026**.

## Mandatory items checklist

The hackathon FAQ lists these as required. Missing any one risks disqualification.

| Requirement | What to submit | Status |
|---|---|---|
| Mainnet deployment | QieHooksBilling contract on QIE mainnet | ⏳ deploy (docs/LAUNCH.md step 3) |
| Open-source smart contracts | `contracts/src/QieHooksBilling.sol`, **verified** on mainnet.qie.digital | ⏳ verify after deploy |
| Live public app | `<https://your-app>` | ⏳ deploy server |
| Public repository | `<https://github.com/you/qie-hooks>` | ⏳ push |
| Demo video | 3-minute video (script below) | ⏳ record |
| Documentation | README.md, docs/ARCHITECTURE.md, in-app Docs page | ✅ |
| Team presentation | Slides (outline below) for demo week Dec 1–5 | ⏳ make |

Judging weights: **Innovation 30% · Technical Quality 25% · User Experience 15% · Mainnet Integration 15% · Business Potential 15%**, plus bonus for using several QIE components.

---

## Form fields

**Project name:** QIE Hooks

**Track:** Developer Infrastructure & Tooling

**Repository:** `<https://github.com/you/qie-hooks>`

**Live demo URL:** `<https://your-app>`

**Contract address:** `<0x… QieHooksBilling on QIE mainnet>` (verified)

**One-liner (if asked):**
Real-time webhooks, Telegram and Discord alerts, payment links and on-chain traction pages for QIE Blockchain, usable by apps, people and AI agents.

**Description (≈200 words):**

> QIE's public RPC nodes can't push events, so every QIE app has to poll the chain to learn that a payment arrived or a contract was called. QIE Hooks does that once, for the whole ecosystem.
>
> **Hooks:** get a signed webhook, a Telegram message or a Discord post seconds after something happens on QIE: a payment to your `name.qie`, a large QUSDC transfer, a QIEDEX swap, any contract event, a failed transaction, a low gas balance, a price level, or a QIE ID being repointed.
>
> **Payment links:** a hosted checkout. Customers pay with QIE Wallet or a QR code; the merchant gets `invoice.paid` with their order id the moment it settles. Funds go straight to the merchant.
>
> **Traction pages:** a live public page and README badge with a project's real on-chain users and transactions, verified from the chain, plus a leaderboard of QIE projects.
>
> **For AI agents:** an MCP server lets Claude and other agents create payment links, wait for payment and react to on-chain events.
>
> It indexes every block across all five QIE RPC nodes with failover, stores each event exactly once, retries deliveries for 8 hours and can replay any event. Pro is paid in QUSDC through an on-chain billing contract.

**QIE components used:**
QIE Wallet (sign-in with EIP-4361, one-click payments, EIP-6963) · QIE ID (name resolution, reverse lookup, takeover alerts) · QUSDC (payment links, payment alerts, billing) · QIEDEX (live prices, swap decoding, new pairs) · all five QIE mainnet RPC nodes · QIE explorer (links, history import) · QIE Wallet MCP.

**What's new / innovative (Innovation is 30%):**
- First event-delivery infrastructure for QIE: no other project offers webhooks, alerts or an indexer as a service.
- Memo-less payment matching: unique amounts per open payment link, so any wallet can pay without extra data.
- Traction that can't be quietly faked: returning wallets, failed transactions and top-10 wallet concentration shown next to the totals.
- AI-agent native: one MCP tool call creates a payment link, another waits until it's paid.

**Traction (update before submitting):**
- Projects on the leaderboard: `<N>`; verified: `<N>`
- Developers / accounts: `<N>`; active hooks: `<N>`
- Events delivered: `<N>`, delivery success rate `<N>%`
- Payment links paid: `<N>` (`<N>` QUSDC)
- Pro subscriptions paid on chain: `<N>`
(All visible on `<https://your-app>/#/status` and `<https://your-app>/#/explore`.)

---

## Demo video (3 minutes)

Record the screen at 1080p, with your phone in shot or a phone screen recording for the payment. Speak to the judging criteria.

| Time | Show | Say |
|---|---|---|
| 0:00–0:20 | The explorer, then the QIE Hooks landing page | "QIE's RPC can't push events. Every app polls. A shop doesn't even know a customer paid. QIE Hooks fixes that for the whole ecosystem." |
| 0:20–0:55 | Sign in with QIE Wallet → New hook → Shop payments template → `shop.qie` resolving live → Telegram → Create | "Sign in with QIE Wallet. Type a QIE ID, not an address. Pick Telegram." |
| 0:55–1:20 | Phone: pay `shop.qie` 1 QUSDC. Telegram alert appears (~2 s) | "QIE finalises in about two seconds, and so does the alert, with the payer's QIE ID." |
| 1:20–1:50 | Payment links: create 1 QUSDC link → open checkout → scan QR with phone → pay → page flips to Paid + `invoice.paid` alert | "Payment links: no memo needed. Each link gets a unique amount so any wallet can pay." |
| 1:50–2:15 | Claude with the MCP server: "Create a 2 QUSDC payment link for the logo and tell me when it's paid" → pay → Claude answers | "AI agents can take payments on QIE with one tool call." |
| 2:15–2:40 | Leaderboard and a traction page with its badge | "Every QIE project gets a live, verifiable traction page. N projects already listed." |
| 2:40–3:00 | Status page (5 nodes, live block), hook event log (signed, retried, replayable), verified billing contract on the explorer | "Five RPC nodes with failover, signed and retried delivery, billing in QUSDC on chain. Live on mainnet today." |

---

## Team presentation (demo week, ~6 slides)

1. **Problem:** QIE can't push events; every dApp rebuilds polling; merchants don't know they've been paid.
2. **Product:** hooks, payment links, traction pages, MCP for agents (one screenshot each).
3. **Live demo:** the video flow, done live (keep the video as backup).
4. **How it works:** the diagram from docs/ARCHITECTURE.md; exactly-once storage, failover, signed retries.
5. **Traction:** leaderboard count, developers, events delivered, payment-link volume, Pro payments.
6. **Business and next 90 days:** free tier for growth, Pro in QUSDC; targets for the three milestone metrics (projects/merchants onboarded, events delivered, recurring users / revenue).
