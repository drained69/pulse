# Launch checklist: QIE Hackathon 3.0

Deadline: **23:59 CET, 30 Nov 2026**. Demo week Dec 1–5. Winners Dec 10. Half of each prize is held back for 90-day traction milestones.

## Step-by-step: from this repo to a submitted project

Do these in order. Each step says what you need and how to check it worked.

### 1. Put the code on GitHub (done)
Public repo = submission requirement. It lives at https://github.com/drained69/pulse (`git push` to update).

### 2. Create the Telegram bot (5 min)
In Telegram, open **@BotFather** → `/newbot` → name `Q-Pulse` → username e.g. `QPulseBot`. Copy the **token** (keep it secret). Optional: `/setuserpic`, `/setdescription`.

### 3. Deploy and verify the billing contract (20 min, ~1 QIE gas)
This is the hackathon's "mainnet deployment" + "open-source contract". Use a **keystore** (asks for a password; never paste a private key into a command).
```bash
cd contracts
forge install foundry-rs/forge-std --no-git        # once
cast wallet import deployer --interactive           # paste the deployer key into the prompt, set a password
TREASURY=0xYOUR_SAFE_OR_WALLET forge script script/Deploy.s.sol --rpc-url qie --broadcast --account deployer
```
Note the deployed address and block number from the output. Then verify the source on the QIE explorer (Blockscout):
```bash
forge verify-contract 0xDEPLOYED_ADDRESS src/QPulseBilling.sol:QPulseBilling \
  --rpc-url qie --verifier blockscout --verifier-url https://mainnet.qie.digital/api/ \
  --constructor-args $(cast abi-encode "constructor(address,address,uint256,uint32)" 0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5 0xYOUR_SAFE_OR_WALLET 9000000 2592000)
```
Check: `https://mainnet.qie.digital/address/0xDEPLOYED_ADDRESS` shows a green "verified" contract.
Treasury tip: a QIE Safe (safe.qie.digital) looks best to judges; your own wallet is fine too.

### 3b. Deploy the attestation contract (10 min, ~1 QIE gas)
The second mainnet contract: the server posts a daily Merkle root of every project's traction numbers to it.
```bash
cast wallet new                                     # a NEW key just for the server; note its address and private key
cd contracts
ATTESTER=0xNEW_ATTESTER_ADDRESS forge script script/DeployAttestations.s.sol --rpc-url qie --broadcast --account deployer
forge verify-contract 0xATTESTATIONS_ADDRESS src/PulseAttestations.sol:PulseAttestations \
  --rpc-url qie --verifier blockscout --verifier-url https://mainnet.qie.digital/api/ \
  --constructor-args $(cast abi-encode "constructor(address)" 0xNEW_ATTESTER_ADDRESS)
```
Send ~1 QIE to the attester address for gas (each daily post costs a fraction of a cent). That key holds nothing else; if it leaks, rotate it with `setAttester` from your deployer.

### 4. Deploy the server on Fly.io (20 min, ~$5/month)
```bash
brew install flyctl
fly auth signup                                     # or: fly auth login
fly launch --no-deploy --copy-config                # accept or change the app name; note the URL (https://<name>.fly.dev)
fly volumes create data --size 1
fly secrets set PUBLIC_URL=https://<name>.fly.dev TELEGRAM_BOT_TOKEN=<token> \
  BILLING_CONTRACT=0xDEPLOYED_ADDRESS BILLING_START_BLOCK=<deploy block> MAX_PROJECTS_PER_USER=50 \
  ATTESTATION_CONTRACT=0xATTESTATIONS_ADDRESS
fly secrets set ATTESTER_PRIVATE_KEY=0x…            # the key from `cast wallet new`; type it here yourself
fly deploy
```
Check: `https://<name>.fly.dev/#/status` shows 5/5 healthy nodes and lag 0. Send `/start` to your bot: it should answer.
`fly.toml` uses region `ewr` (New Jersey): QIE's public RPC nodes are on DigitalOcean near New York, so every RPC call is ~2 ms instead of ~270 ms.
Check the WebSocket RPC: `cast block-number --rpc-url wss://<name>.fly.dev/rpc` (or open the Status page: the WebSocket card counts connections).
The first traction attestation appears on the Status page the day after a page's history import finishes; then run `pnpm verify-traction <slug> --api https://<name>.fly.dev`.
(No Fly? Any VPS with Docker: `docker build -t qpulse . && docker run -d -p 8787:8787 -v qpulse-data:/data --env-file .env qpulse` behind HTTPS.)

### 5. Test the three things only a real wallet can test (15 min)
1. **Sign in** with the QIE Wallet extension on your live URL.
2. **Telegram:** Telegram page → Connect → send the code to your bot → create a "Shop payments" hook to Telegram → send 0.1 QUSDC to your own `.qie` from your phone. The message should arrive in seconds.
3. **Payment link:** create a 0.5 QUSDC link → open it → *Pay with QIE Wallet*. Also scan its QR with the QIE Wallet phone app and note whether it pre-fills (if not, the copy buttons work).
Also: **Plan** page → pay for Pro once (9 QUSDC). Judges see a real on-chain payment in your own billing contract.

### 6. Seed traction pages and start outreach (30 min, then daily)
Create an API key in the dashboard, then:
```bash
QPULSE_URL=https://<name>.fly.dev QPULSE_KEY=qp_live_… node scripts/seed-traction.mjs
```
This creates pages for Fluenci, RemitChain, Patungan and Semilla1 Guard. Also create a page for **Q-Pulse itself** (your billing contract) and put its badge in your README. Then send the messages in `docs/OUTREACH.md`.

### 7. Optional but good
- **Public whale-alert channel:** Telegram channel "QIE Whale Alerts", bot as admin, `fly secrets set PUBLIC_ALERTS_CHAT_ID=@yourchannel`.
- **Publish the SDK:** `cd packages/sdk && npm publish --access public` (needs the `@qpulse` npm org, or rename the package).
- **Make the code yours:** read `docs/ARCHITECTURE.md`, walk through `indexer.ts`, `invoices.ts`, `projects.ts`, change what you'd do differently, and commit. Judges check effort and will ask you to explain it.

### 8. Record, present, submit (by 29 Nov, a day early)
- **Demo video:** script in `docs/SUBMISSION.md`. Upload to YouTube (unlisted is fine).
- **Slides:** outline in `docs/SUBMISSION.md`.
- **Submit** at hackathon.qie.digital → Sign in → submission form: repo URL, live URL, contract address, track **Developer Infrastructure & Tooling**, description and traction numbers from `docs/SUBMISSION.md`.

## Traction plan (judges reward real usage; milestones pay the second 50%)

The best early users are other Hackathon 3.0 teams, who need "payment received" alerts right now.

1. Post in the QIE developer Telegram and Discord: "Free real-time webhooks/Telegram alerts for your QIE dApp: payments to your .qie name, QUSDC, QIEDEX swaps, any contract event. Setup takes 1 minute." Link the dashboard.
2. DM teams building payments, POS, escrow or games (search GitHub for `QIE Hackathon 3.0`, e.g. Patungan, MerchantPay, Agent Escrow, AgentPay Guard). Offer to set up their hook for them.
3. **Traction pages are the hook for other teams.** Every Hackathon 3.0 team must prove usage to judges. Create a traction page for each team's contracts yourself (the data is public), then send them the link: "Your live traction page and README badge are ready. Sign in from your deployer wallet to get the Verified badge." Post the leaderboard (`#/explore`) in the hackathon channels.
4. **Payment links for the commerce teams** (Patungan, Imole, Payounce, QIE AgentPay): offer them checkout links + `invoice.paid` webhooks instead of writing their own payment detection.
5. **MCP for the AI-agent teams** (AgentPay Guard, Leash, Agent Escrow, Semilla1): their agents can create payment links and wait for payment with one tool call.
6. Launch the public whale-alert channel and share it in the QIE community (13K on X, 24K on Discord).
7. Track what the status page already shows: active hooks, developers, events matched, delivery success rate. Screenshot it daily for the demo.

Milestone-friendly metrics Q-Pulse produces naturally: **projects on the leaderboard**, **payment-link volume in QUSDC**, **developers / dApps integrated** (users), **events delivered** (usage), **recurring users** (hooks keep firing every day), **Pro subscriptions in QUSDC** (on-chain revenue).

## 3-minute demo script

1. **Problem (20 s)**: "QIE's RPC can't push events. Every dApp polls. Here's what that costs a shop owner: they don't know a customer paid."
2. **Create (40 s)**: sign in with QIE Wallet → New hook → Payment received → type `shop.qie` (show it resolve live) → Telegram → Create.
3. **Wow (40 s)**: on a phone, pay `shop.qie` 1 QUSDC from QIE Wallet. The Telegram message lands about 2 seconds later: "💸 shop.qie received 1 QUSDC, from alice.qie".
4. **For developers (40 s)**: show the webhook event log (signed, retried, replayable) and the 10-line SDK snippet. Mention any-contract events and QIEDEX swaps.
5. **Payment link (30 s)**: create a 1 QUSDC link, scan its QR with your phone, pay. The checkout flips to "Paid" and the `invoice.paid` Telegram alert lands at the same time.
6. **AI agent (20 s)**: in Claude with the Q-Pulse MCP server: "Create a 2 QUSDC payment link for the logo and tell me when it's paid." Pay it; Claude reports the payer and the transaction.
7. **Proof (30 s)**: the leaderboard and Q-Pulse's own traction page (its badge is in the README), status page (5 RPC nodes, live block), verified billing contract.

(Steps 5–7 make the demo run over 3 minutes: drop step 4 if time is short.)

## Ideas after the hackathon

- Postgres + multiple indexer workers; a hosted free tier for the whole ecosystem.
- Address-activity triggers and NFT (ERC-721) triggers.
- Sanctions and counterparty screening and QIE ID trust-score filters, once QIE ships those APIs (on the Dec 2026 roadmap).
- A "notify me" button any QIE dApp can embed for its own users.
- Payment links with line items and receipts; recurring payment links (subscriptions) in QUSDC.
- Traction pages that also count token volume and internal calls (needs a trace API on QIE).
