# Hackathon 3.0 submission pack

Everything to paste into the submission form, plus the demo video and presentation outlines.
Replace `<…>` placeholders once deployed. Deadline: **23:59 CET, 30 November 2026**.

## Mandatory items checklist

The hackathon FAQ lists these as required. Missing any one risks disqualification.

| Requirement | What to submit | Status |
|---|---|---|
| Mainnet deployment | QPulseBilling + PulseAttestations on QIE mainnet | ⏳ deploy (docs/LAUNCH.md steps 3, 3b) |
| Open-source smart contracts | `contracts/src/QPulseBilling.sol`, `contracts/src/PulseAttestations.sol`, **verified** on mainnet.qie.digital | ⏳ verify after deploy |
| Live public app | `<https://your-app>` | ⏳ deploy server |
| Public repository | `<https://github.com/drained69/pulse>` | ⏳ push |
| Demo video | 3-minute video (script below) | ⏳ record |
| Documentation | README.md, docs/ARCHITECTURE.md, in-app Docs page | ✅ |
| Team presentation | Slides (outline below) for demo week Dec 1–5 | ⏳ make |

Judging weights: **Innovation 30% · Technical Quality 25% · User Experience 15% · Mainnet Integration 15% · Business Potential 15%**, plus bonus for using several QIE components.

---

## Form fields

**Project name:** Q-Pulse

**Track:** Developer Infrastructure & Tooling

**Repository:** `<https://github.com/drained69/pulse>`

**Live demo URL:** `<https://your-app>`

**Contract addresses:** `<0x… QPulseBilling>` and `<0x… PulseAttestations>` on QIE mainnet (both verified)

**One-liner (if asked):**
Real-time webhooks, Telegram and Discord alerts, payment links and on-chain traction pages for QIE Blockchain, usable by apps, people and AI agents.

**Description (≈200 words):**

> QIE's public RPC nodes can't push events, so every QIE app has to poll the chain to learn that a payment arrived or a contract was called. Q-Pulse does that once, for the whole ecosystem.
>
> **Hooks:** get a signed webhook, a Telegram message or a Discord post seconds after something happens on QIE: a payment to your `name.qie`, a large QUSDC transfer, a QIEDEX swap, any contract event, a failed transaction, a low gas balance, a price level, or a QIE ID being repointed.
>
> **Payment links:** a hosted checkout. Customers pay with QIE Wallet or a QR code; the merchant gets `invoice.paid` with their order id the moment it settles. Funds go straight to the merchant.
>
> **Traction pages:** a live public page and README badge with a project's real on-chain users and transactions, verified from the chain, plus a leaderboard of QIE projects.
>
> **For AI agents:** an MCP server lets Claude and other agents create payment links, wait for payment and react to on-chain events.
>
> **`eth_subscribe` for QIE:** `wss://…/rpc` is a drop-in WebSocket RPC, so viem's `watchContractEvent` and ethers' `contract.on()` work on QIE, which its public nodes don't support.
>
> **Provable traction:** once a day every project's numbers go into a Merkle tree whose root is posted on chain; anyone can recount them from QIE's explorer and check them, in the browser or with a CLI.
>
> It indexes every block across all five QIE RPC nodes with failover, stores each event exactly once, retries deliveries for 8 hours and can replay any event. Pro is paid in QUSDC through an on-chain billing contract.

**QIE components used:**
QIE Wallet (sign-in with EIP-4361, one-click payments, EIP-6963) · QIE ID (name resolution, reverse lookup, takeover alerts) · QUSDC (payment links, payment alerts, billing) · QIEDEX (live prices, swap decoding, new pairs) · all five QIE mainnet RPC nodes · QIE explorer (links, history import) · QIE Wallet MCP.

**What's new / innovative (Innovation is 30%):**
- First event-delivery infrastructure for QIE: no other project offers webhooks, alerts or an indexer as a service.
- Adds `eth_subscribe` to QIE: one shared poller (one batched request per block) fans out to every WebSocket subscriber; standard viem/ethers code works unchanged.
- Traction you don't have to trust: daily Merkle roots on chain, each leaf committing to the exact transaction set; a browser button and a CLI recount from QIE's explorer and check against the root.
- Measured, not claimed: live p50/p95/p99 latency from block timestamp to WebSocket push, detection and webhook delivery on the status page.
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
| 0:00–0:20 | The explorer, then the Q-Pulse landing page | "QIE's RPC can't push events. Every app polls. A shop doesn't even know a customer paid. Q-Pulse fixes that for the whole ecosystem." |
| 0:20–0:55 | Sign in with QIE Wallet → New hook → Shop payments template → `shop.qie` resolving live → Telegram → Create | "Sign in with QIE Wallet. Type a QIE ID, not an address. Pick Telegram." |
| 0:55–1:20 | Phone: pay `shop.qie` 1 QUSDC. Telegram alert appears within seconds | "QIE blocks are final when produced, so the alert arrives seconds later, with the payer's QIE ID." |
| 1:20–1:50 | Payment links: create 1 QUSDC link → open checkout → scan QR with phone → pay → page flips to Paid + `invoice.paid` alert | "Payment links: no memo needed. Each link gets a unique amount so any wallet can pay." |
| 1:50–2:15 | Claude with the MCP server: "Create a 2 QUSDC payment link for the logo and tell me when it's paid" → pay → Claude answers | "AI agents can take payments on QIE with one tool call." |
| 2:15–2:35 | Traction page → "Verify in your browser" → four green checks | "Every QIE project gets a traction page, and you don't have to trust us: the numbers are committed on chain daily and recounted from QIE's own explorer, right here." |
| 2:35–2:45 | Terminal: 5-line viem script with `webSocket("wss://…/rpc")` and `watchContractEvent` printing live QUSDC transfers | "And for developers: `eth_subscribe` now works on QIE. Change one URL." |
| 2:45–3:00 | Status page: latency card (p50/p95), 5 nodes, attestations table | "Measured latency, five nodes with failover, two verified contracts. Live on mainnet today." |

---

## Team presentation (demo week, ~6 slides)

1. **Problem:** QIE can't push events; every dApp rebuilds polling; merchants don't know they've been paid.
2. **Product:** hooks, payment links, traction pages, MCP for agents (one screenshot each).
3. **Live demo:** the video flow, done live (keep the video as backup).
4. **How it works:** the diagram from docs/ARCHITECTURE.md; exactly-once storage, failover, signed retries; the WebSocket stream hub (one batched poll fans out to all subscribers); the attestation Merkle tree and how anyone verifies it.
5. **Traction:** leaderboard count, developers, events delivered, payment-link volume, Pro payments.
6. **Business and next 90 days:** free tier for growth, Pro in QUSDC; targets for the three milestone metrics (projects/merchants onboarded, events delivered, recurring users / revenue).
