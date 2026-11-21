# Q-Pulse

[![QIE traction](https://qpulse-production.up.railway.app/api/projects/q-pulse/badge.svg)](https://qpulse-production.up.railway.app/#/p/q-pulse) · [Live app](https://qpulse-production.up.railway.app) · [Network status](https://qpulse-production.up.railway.app/#/status) · [Leaderboard](https://qpulse-production.up.railway.app/#/explore)

**Real-time webhooks, Telegram and Discord alerts for QIE Blockchain.**
Get told the moment someone pays your `name.qie`, a large QUSDC transfer happens, a QIEDEX pair trades, or any contract emits an event. No polling and no indexer of your own.

> QIE Hackathon 3.0 · Developer Infrastructure & Tooling track

---

## Why

QIE's public RPC nodes don't push events (`eth_subscribe` → *"notifications not supported"*), and the explorer has a query API but no webhooks. So every QIE dApp that needs to know "did the payment arrive?" ends up writing its own polling loop.

Q-Pulse is that loop, done once and shared:

| | |
|---|---|
| 🪪 **Built on QIE ID** | Watch `shop.qie`, not a hex address. Senders appear by their QIE ID. Names are resolved through the official QIE ID contracts (via the QIE Wallet MCP) and re-checked every 10 minutes, so a repointed name is followed. |
| 📡 **`eth_subscribe` for QIE** | `wss://…/rpc` is a drop-in WebSocket RPC: viem's `watchContractEvent`, ethers' `contract.on()` and raw `eth_subscribe` work on QIE for the first time. One upstream poll fans out to every subscriber. |
| ⚡ **Fast, and measured** | QIE produces a block every ~4 s with CometBFT instant finality. The indexer reads every block across all five public RPC nodes, sends each call to the fastest healthy node, and fails over when one stalls or lags. The status page shows live p50/p95/p99 latency from block timestamp to WebSocket push, to detection and to webhook delivery. |
| 🔏 **Reliable** | Every event is stored before delivery. A restart resumes from the last fully stored block, and duplicates are dropped. Webhooks are HMAC-signed and retried 6 times over ~8.5 h. Any event can be replayed. |
| 🛡️ **Lookalike-safe** | QIE mainnet has unofficial tokens that copy the WQIE and WETH names. Payment hooks only count the official QUSDC/WQIE, and copycats are flagged in the payload. |
| 🔄 **QIEDEX-aware** | Swap alerts decode direction and amounts, with USD values from the official QIEDEX API. |
| 💳 **Paid on chain** | The Pro plan is paid in QUSDC through a small billing contract. The server reads its own `Subscribed` events to unlock plans, so billing runs through Q-Pulse itself. |

### QIE components used

QIE Wallet (sign-in, EIP-6963 `me.qiewallet`, payments) · QIE ID (`.qie` resolution and reverse lookup via the QIE Wallet MCP) · QUSDC (billing, payment triggers) · QIEDEX (pairs, prices, swap triggers) · QIE mainnet RPCs (all five, with health monitoring) · QIE explorer (links, and history import for traction pages).

---

## What's in the repo

```
apps/server     Indexer, delivery worker, Telegram bot, REST API, WebSocket RPC, attestations (Node 22+, Hono, SQLite, viem)
                bin/verify-traction.ts: check a traction page against the chain without trusting the server
apps/web        Dashboard (React + Vite): sign in with QIE Wallet, hooks, events, Telegram, API keys, plan, status, docs
packages/sdk    qpulse-sdk: typed API client + webhook signature verification
contracts       QPulseBilling.sol: pay for Pro in QUSDC; funds go straight to the treasury
                PulseAttestations.sol: append-only daily Merkle roots of every project's traction numbers
scripts         e2e-fork.sh: full end-to-end test on a local fork of QIE mainnet
```

### Triggers

**Per block** (seconds after the transaction):

| Type | Event | Fires when |
|---|---|---|
| `payment` | `payment.received` | Native QIE (successful tx) or a listed ERC-20 lands at a `name.qie` or address. Optional minimum. |
| `token_transfer` | `token.transfer` | A token moves, filtered by from / to / minimum (e.g. "QUSDC ≥ 1,000" whale alerts). |
| `swap` | `dex.swap` | A trade on a QIEDEX pair, with tokens in/out and USD value, optional minimum size. |
| `contract_event` | `contract.event` | Any of up to 12 events matching Solidity signatures, from one contract or all, with argument filters. |
| `wallet` | `wallet.activity` | Anything in or out of an address: QIE and token transfers, contract calls, deployments, and **failed transactions**. Lookalike addresses and zero-value transfers are flagged (address poisoning). |
| `liquidity` | `liquidity.drop` | **Rug-pull radar**: a QIEDEX pair's liquidity falls a chosen share (default 30%) below its 24-hour peak. Fires once, re-arms after it recovers. |

**Scheduled** (checked every minute; thresholds fire once on crossing and re-arm when they clear):

| Type | Event | Fires when |
|---|---|---|
| `balance` | `balance.threshold` | A QIE or token balance goes below or above an amount (e.g. a relayer's gas wallet runs low). |
| `price` | `price.threshold` | A token's QIEDEX USD price crosses a level. |
| `name_watch` | `name.changed` | A `name.qie` starts pointing to a different address or stops resolving (takeover warning). |
| `daily_digest` | `digest.daily` | Once a day: event count, totals per token and top counterparties of another hook (e.g. daily sales). |

### One-click templates

| For | Templates |
|---|---|
| Merchants | Shop payments · Daily sales summary |
| Developers | Low gas wallet · Contract admin changes (paused, upgraded, ownership, roles) · Failed calls to my contract |
| Treasuries & security | Watch my Safe (QIE Safe multisig, v1.3 and v1.4 events) · Token approvals by my wallet · Watch my .qie name · Watch a wallet · Address poisoning guard |
| Traders & community | QUSDC whale moves · New QIEDEX pairs · Rug-pull radar · WQIE price alert |

The dashboard links straight to a template with `#/hooks/new/<template>` (e.g. `#/hooks/new/safe`), which is handy for sharing in community channels.

### Payment links

A hosted checkout page for an exact amount of QUSDC, QIE or WQIE (`#/pay/<id>`). The customer pays with QIE Wallet in one click or scans an EIP-681 QR code; funds go straight to your wallet (or your `name.qie`, or a Safe). Create links from the dashboard, the API (`POST /api/invoices`), the SDK (`qp.invoices.create`) or an AI agent, and attach your own `metadata` such as an order id. A hook of type `invoice` sends `invoice.paid` to your webhook, Telegram or Discord the moment the payment confirms.

QIE transfers carry no memo, so when several links for the same amount are open each gets a few extra millionths (25.000001 QUSDC) and the payment is matched on recipient + token + exact amount. A payment arriving up to 24 hours after its link expired is still credited.

### Products: sell anything, unlock anything

A product is a permanent link and QR code (`#/buy/<id>`) for something sold again and again: a file, a licence key, a coffee, a locker. Every buyer gets their own 15-minute payment link with an exact amount, so payments are still matched without a memo. After paying, the buyer sees the product's **unlock content** (a download link, licence key or door code) on the checkout page, and only then.

Each sale fires `invoice.paid` with `data.product`, so a machine can act on it: [`examples/device-receiver`](examples/device-receiver) is a dependency-free receiver for a Raspberry Pi or any computer that verifies the signature and switches a relay. Each product also has a **device view** (`#/device/<id>`): a screen with the QR code and a lock that opens live when the product is paid, for demos and kiosks.

### Charge per request (HTTP 402)

Sell API calls to people and AI agents in QUSDC with one middleware from the SDK:

```ts
import { QPulse, paywall } from "qpulse-sdk";
const qp = new QPulse({ apiKey: process.env.QPULSE_KEY! });
app.get("/forecast", paywall({ client: qp, id: "forecast", amount: "0.05" }), handler);
```

A request without payment gets `402 Payment Required` with a payment link. The caller pays it with any QIE wallet and repeats the request with `X-QPulse-Payment: inv_…`. The middleware checks the link was made by this paywall at this price and is paid, then redeems it (`POST /api/invoices/:id/redeem`, atomic): one payment buys exactly one request, and a cheaper link from elsewhere can't be replayed.

### Scam guards

- **Address poisoning:** scammers send zero-value or dust transfers from an address that starts and ends like one you use, hoping you copy it from your history. Wallet and payment alerts carry a warning (and webhooks `data.security`) when a counterparty imitates an address the hook has seen, or when a token transfer is worth zero. Zero-value transfers never count as payments.
- **Rug-pull radar:** follows a QIEDEX pair's depth, √(reserve0 × reserve1), through every `Sync` event; swaps barely move it, removing liquidity does. Alerts once when it falls a chosen share below its 24-hour peak.

### Traction pages and leaderboard

Any project can get a public, live page (`#/p/<slug>`) and a README badge showing how many transactions and distinct wallets use its contracts: counted live by the indexer, with the last 90 days imported from the QIE explorer. Returning wallets, failed transactions and how concentrated activity is in the top 10 wallets are shown, so inflated numbers are visible. Pages created from the contract's deployer (or `owner()`) are marked **Verified**. Public pages are ranked on the leaderboard (`#/explore`) by wallets in the last 7 days.

**Provable, not just visible.** Once a day Q-Pulse commits every project's 30-day numbers to the chain:

1. At the indexer's cursor (every block up to it is fully stored), each project becomes a leaf: its slug, contracts, window (30 days up to block N), successful-transaction count, distinct wallets, and a hash of the **exact set of transaction hashes**.
2. The leaves form a Merkle tree (double-hashed leaves, sorted pairs: the OpenZeppelin convention) and the root goes to `PulseAttestations` on QIE. The contract is append-only: each day once, in order, never in the future, so history can't be rewritten or backdated.
3. Anyone checks a page without trusting Q-Pulse: recount the numbers from QIE's own explorer, hash them into a leaf, fold the proof, and compare with the root read straight from a QIE node (or call the contract's `verify`). The traction page does this in the browser (*Verify in your browser*), and so does the CLI:

```bash
pnpm verify-traction <slug> --api https://<your-app>
# ✓ transaction count matches the chain  claimed 39, recounted 39
# ✓ wallet count matches the chain  claimed 16, recounted 16
# ✓ exact transaction set matches
# ✓ recounted numbers fold into the snapshot's Merkle root
# ✓ on-chain root equals the recomputed root
# ✓ PulseAttestations.verify(epoch, leaf, proof) returns true
```

If the server dropped or invented a single transaction, the transaction-set hash differs and the proof no longer reaches the on-chain root.

### MCP server for AI agents

`/api/mcp` is a Model Context Protocol server (Streamable HTTP) so Claude and other agents can use QIE: `create_payment_link`, `wait_for_payment`, `create_alert`, `wait_for_event`, `get_events`, `create_product`, `resolve_qie_name`, `get_traction`, `network_status` and more (16 tools).

```bash
claude mcp add --transport http qpulse https://qpulse-production.up.railway.app/api/mcp --header "Authorization: Bearer qp_live_…"
```

Then: *"Create a 5 QUSDC payment link for the logo design and tell me when it's paid."*

### WebSocket JSON-RPC (`eth_subscribe` for QIE)

QIE's public nodes answer `eth_subscribe` with *"notifications not supported"*, and their filter ids (`eth_newFilter`) live on one node, so they break behind any load balancer. Q-Pulse serves standard JSON-RPC at `/rpc` that fixes both:

```ts
import { createPublicClient, webSocket } from "viem";

const client = createPublicClient({ transport: webSocket("wss://<your-app>/rpc") });
client.watchContractEvent({ address: QUSDC, abi, eventName: "Transfer", onLogs: console.log }); // just works
```

| Method | Where it is answered |
|---|---|
| `eth_subscribe("newHeads")`, `eth_subscribe("logs", {address, topics})`, `eth_unsubscribe` | WebSocket only. Served by the stream hub. |
| `eth_newFilter`, `eth_newBlockFilter`, `eth_getFilterChanges`, `eth_getFilterLogs`, `eth_uninstallFilter` | HTTP or WebSocket. Filters live in Q-Pulse, so polling clients (viem `http()` transport) work across all five nodes. Unpolled filters expire after 5 min. |
| `eth_chainId`, `net_version` | Answered locally. |
| every other `eth_*` / `net_*` / `web3_*` call | Forwarded to the RPC pool with failover. Signing/account methods are refused. |

How it works (`apps/server/src/stream.ts`):

- **One poll, many subscribers.** A single loop polls only while someone is subscribed and fans each new block out to every matching subscription.
- **One round trip per poll.** QIE's nodes take ~1–2 s per request, so each poll is a single JSON-RPC batch: the head, the next headers and their logs. A batch is answered by one node, so the data is consistent.
- **No silently empty blocks.** A block is pushed only once that node can serve its header, and its logs are checked against the header's hash and logs bloom. A node that has the header but not yet the logs makes the hub wait instead of emitting an empty block.
- **Final by construction.** CometBFT has no reorgs, so `removed` is always `false`.
- **Limits.** 20 connections and 25 req/s (burst 100) per IP, 100 subscriptions per connection, 256 KB messages, and slow consumers (4 MB unread) are disconnected.

### Destinations

Signed **webhook** (HTTPS POST) · **Telegram** (private chat, group or channel, linked with a one-time code) · **Discord** (channel webhook).

---

## Run it locally

Requirements: Node ≥ 22.18 (runs TypeScript directly), pnpm, and Foundry for the contract and the end-to-end test.

```bash
pnpm install
cp .env.example .env            # optional: add TELEGRAM_BOT_TOKEN
pnpm --filter @qpulse/web build
pnpm start                      # http://localhost:8787
```

For dashboard development with hot reload, run `pnpm --filter @qpulse/server dev` and `pnpm --filter @qpulse/web dev` (Vite proxies `/api` to the server).

## Tests

```bash
pnpm test        # server (85), SDK (6) and contract (18, incl. fuzz) tests
pnpm e2e         # end-to-end on an anvil fork of QIE mainnet
```

The end-to-end test forks QIE mainnet, deploys the billing contract, runs the whole server against the fork, creates payment links and a traction page, then sends real transactions: QUSDC to `qie.qie`, a native QIE payment, a QUSDC whale transfer, a QIEDEX swap through the real router, two token approvals, a Pro subscription, and a transaction that deliberately reverts. It creates 8 hooks (payment, whale, swap, contract event, wallet watch, approvals, balance, price) and checks:
- every webhook's signature and decoded content
- that a payment below the minimum does **not** fire
- that the reverted transaction is reported as failed
- that the balance alert fires once on crossing, not on every check
- that prices come live from QIEDEX
- that the on-chain payment unlocks Pro
- that the QUSDC and QIE transfers pay their payment links (and a different amount does not), with `invoice.paid` webhooks carrying the order id
- that the traction page counts the successful and failed calls to the billing contract
- that replaying every block after a restart creates no duplicate events, deliveries, traction rows or payments

Other suites worth knowing: `stream.test.ts` drives the WebSocket RPC with real viem clients (`watchBlocks`, `watchContractEvent` over `webSocket()`, and `eth_newFilter` polling over `http()`) against a fake node that can lag or serve headers before logs. `attestations.test.ts` deploys `PulseAttestations` on a local anvil chain, lets the server snapshot and anchor, checks the contract accepts the served proofs and rejects inflated numbers, then runs the `verify-traction` CLI against an honest and a tampered explorer.

---

## Deploy

### 1. Billing contract (required for the hackathon: it is the mainnet deployment)

```bash
cd contracts
forge install foundry-rs/forge-std --no-git
forge test
# Use a keystore (cast wallet import deployer --interactive); never paste a private key into a command.
TREASURY=0xYourSafeOnQIE forge script script/Deploy.s.sol --rpc-url qie --broadcast --account deployer
```

Verify it on the explorer (`mainnet.qie.digital`) so judges and users can read it. Then set `BILLING_CONTRACT` (and optionally `BILLING_START_BLOCK`) on the server. Ideally the treasury is the QIE Safe multisig (`safe.qie.digital`).

### 2. Server

Any host with a persistent disk works. The indexer must stay running, so don't use scale-to-zero.

**Fly.io**

```bash
fly launch --no-deploy --copy-config
fly volumes create data --size 1
fly secrets set PUBLIC_URL=https://qpulse-production.up.railway.app TELEGRAM_BOT_TOKEN=... BILLING_CONTRACT=0x...
fly deploy
```

**Docker anywhere**

```bash
docker build -t qpulse .
docker run -d -p 8787:8787 -v qpulse-data:/data --env-file .env qpulse
```

### 3. Telegram bot

Talk to [@BotFather](https://t.me/BotFather) → `/newbot` → put the token in `TELEGRAM_BOT_TOKEN`. The bot uses long polling, so no public webhook URL is needed. For a public community channel, add the bot as an admin and set `PUBLIC_ALERTS_CHAT_ID`: it then posts every QUSDC transfer above `PUBLIC_ALERTS_MIN_QUSDC` and every new QIEDEX pair.

---

## Using it from code

```ts
import { QPulse, verifyWebhook } from "qpulse-sdk";

const qp = new QPulse({ apiKey: process.env.QPULSE_KEY!, baseUrl: "https://qpulse-production.up.railway.app" });
await qp.onPayment("shop.qie", { url: "https://shop.example.com/qie-webhook" }, { minAmount: "1" });

// in your webhook route (use the RAW body)
const event = verifyWebhook({ body: rawBody, headers: req.headers, secret: process.env.QPULSE_SECRET! });
if (event.type === "payment.received") console.log(event.data.from.name, "paid", event.data.amount.display);
```

The full payload format, headers and examples in other languages are in the dashboard under **Docs**.

---

## Design notes

- **Exactly-once storage, at-least-once delivery.** The cursor only moves after a block range's events are committed. Events are unique per `(hook, tx hash, log index)`. Receivers should key on `event.id` or `tx.hash + logIndex`.
- **Finality and completeness.** QIE uses CometBFT, so blocks are final when produced and there are no reorgs to unwind. `CONFIRMATIONS` defaults to 0. QIE nodes store a block before their log index catches up, so a node can serve a header while `eth_getLogs` still returns nothing for it. Each indexer batch therefore asks one node for every header of the range plus all its logs, and checks each header's logs bloom: a block whose bloom says "has logs" with none returned (or a missing header, block or receipt) means the node is behind, so the range is retried on another node instead of being skipped.
- **Scheduled triggers** run on a 60-second timer (`CHECK_INTERVAL_MS`). Balances are read in one batched RPC call, and prices come from the QIEDEX API. If the QIE ID resolver is unreachable, a name watch skips that round instead of raising a false alarm.
- **Wallet watch noise control.** When a wallet's outgoing call already produced token transfers (a swap, a payment), only the transfers are reported, not an extra "contract call" event.
- **Native QIE.** Payments sent directly in a transaction are detected (only if the tx succeeded). QIE sent *by a contract* (internal transfers) is not, because the public RPC has no trace API. Token transfers from contracts are detected.
- **Security.** Webhook URLs are checked against private, loopback, link-local and metadata ranges before every delivery, and again at connect time (so DNS rebinding cannot reach internal hosts). Redirects are not followed. Sign-in uses a single-use, 10-minute EIP-4361-style message. Cookie-authenticated writes reject cross-origin requests. API keys and sessions are stored only as hashes. Text that strangers control (token symbols, string event arguments, reverse-resolved names) is reduced to plain text before it reaches Telegram or Discord, so a fake token or a contract event can't put a clickable phishing link into an alert.
- **Storage.** SQLite (WAL) through Node's built-in `node:sqlite`, so there are no native dependencies. For high volume, the same schema moves to Postgres.
- **Backups.** Once a day the server writes a consistent copy of the database (`VACUUM INTO`) to `backups/` next to it and keeps the last 7 (`BACKUP_DIR`, `BACKUP_KEEP`). The copies live on the same volume, so download one now and then for an off-site copy (`railway volume files`, or `fly ssh sftp`).
- **Your data.** Signed-in users can delete their account and everything it owns from Plan → Delete account (`DELETE /api/me`, session only, confirmed with the wallet address). Terms and privacy are at `#/terms` and `#/privacy`.

## Live on QIE mainnet

| | |
|---|---|
| Dashboard and API | https://qpulse-production.up.railway.app |
| WebSocket RPC | `wss://qpulse-production.up.railway.app/rpc` |
| `QPulseBilling` (verified) | [`0x16D687505037a0A3E2B882F2bBa45E772807BEde`](https://mainnet.qie.digital/address/0x16D687505037a0A3E2B882F2bBa45E772807BEde) |
| `PulseAttestations` (verified) | [`0x4A6AcE957b37378D1F9BA917dE131E9f203A4967`](https://mainnet.qie.digital/address/0x4A6AcE957b37378D1F9BA917dE131E9f203A4967) |

Both contracts were deployed in one step with `contracts/script/DeployAll.s.sol` (block 12057730).

## Status of the deliverable

- ✅ Server, dashboard, SDK and both contracts are complete and tested (unit, API, contract and fork end-to-end), deployed on QIE mainnet and verified.
- ✅ Telegram bot: [@QPulseAlertsBot](https://t.me/QPulseAlertsBot).
- ⏳ To do before submission: publish the SDK to npm and onboard real users. See [docs/LAUNCH.md](docs/LAUNCH.md).

## License

MIT
