# QIE Hooks

**Real-time webhooks, Telegram and Discord alerts for QIE Blockchain.**
Get told the moment someone pays your `name.qie`, a large QUSDC transfer happens, a QIEDEX pair trades, or any contract emits an event. No polling and no indexer of your own.

> QIE Hackathon 3.0 · Developer Infrastructure & Tooling track

---

## Why

QIE's public RPC nodes don't push events (`eth_subscribe` → *"notifications not supported"*), and the explorer has a query API but no webhooks. So every QIE dApp that needs to know "did the payment arrive?" ends up writing its own polling loop.

QIE Hooks is that loop, done once and shared:

| | |
|---|---|
| 🪪 **Built on QIE ID** | Watch `shop.qie`, not a hex address. Senders appear by their QIE ID. Names are resolved through the official QIE ID contracts (via the QIE Wallet MCP) and re-checked every 10 minutes, so a repointed name is followed. |
| ⚡ **Fast** | QIE has 1–2 s CometBFT finality. The indexer reads every block across all five public RPC nodes, sends each call to the fastest healthy node, and fails over when one stalls or lags. |
| 🔏 **Reliable** | Every event is stored before delivery. A restart resumes from the last fully stored block, and duplicates are dropped. Webhooks are HMAC-signed and retried 6 times over ~8.5 h. Any event can be replayed. |
| 🛡️ **Lookalike-safe** | QIE mainnet has unofficial tokens that copy the WQIE and WETH names. Payment hooks only count the official QUSDC/WQIE, and copycats are flagged in the payload. |
| 🔄 **QIEDEX-aware** | Swap alerts decode direction and amounts, with USD values from the official QIEDEX API. |
| 💳 **Paid on chain** | The Pro plan is paid in QUSDC through a small billing contract. The server reads its own `Subscribed` events to unlock plans, so billing runs through QIE Hooks itself. |

### QIE components used

QIE Wallet (sign-in, EIP-6963 `me.qiewallet`, payments) · QIE ID (`.qie` resolution and reverse lookup via the QIE Wallet MCP) · QUSDC (billing, payment triggers) · QIEDEX (pairs, prices, swap triggers) · QIE mainnet RPCs (all five, with health monitoring) · QIE explorer (links, and history import for traction pages).

---

## What's in the repo

```
apps/server     Indexer, delivery worker, Telegram bot, REST API (Node 22+, Hono, SQLite, viem)
apps/web        Dashboard (React + Vite): sign in with QIE Wallet, hooks, events, Telegram, API keys, plan, status, docs
packages/sdk    @qiehooks/sdk: typed API client + webhook signature verification
contracts       QieHooksBilling.sol (Foundry): pay for Pro in QUSDC; funds go straight to the treasury
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
| `wallet` | `wallet.activity` | Anything in or out of an address: QIE and token transfers, contract calls, deployments, and **failed transactions**. |

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
| Treasuries & security | Watch my Safe (QIE Safe multisig, v1.3 and v1.4 events) · Token approvals by my wallet · Watch my .qie name · Watch a wallet |
| Traders & community | QUSDC whale moves · New QIEDEX pairs · WQIE price alert |

The dashboard links straight to a template with `#/hooks/new/<template>` (e.g. `#/hooks/new/safe`), which is handy for sharing in community channels.

### Payment links

A hosted checkout page for an exact amount of QUSDC, QIE or WQIE (`#/pay/<id>`). The customer pays with QIE Wallet in one click or scans an EIP-681 QR code; funds go straight to your wallet (or your `name.qie`, or a Safe). Create links from the dashboard, the API (`POST /api/invoices`), the SDK (`qh.invoices.create`) or an AI agent, and attach your own `metadata` such as an order id. A hook of type `invoice` sends `invoice.paid` to your webhook, Telegram or Discord the moment the payment confirms.

QIE transfers carry no memo, so when several links for the same amount are open each gets a few extra millionths (25.000001 QUSDC) and the payment is matched on recipient + token + exact amount. A payment arriving up to 24 hours after its link expired is still credited.

### Traction pages and leaderboard

Any project can get a public, live page (`#/p/<slug>`) and a README badge showing how many transactions and distinct wallets use its contracts: counted live by the indexer, with the last 90 days imported from the QIE explorer. Returning wallets, failed transactions and how concentrated activity is in the top 10 wallets are shown, so inflated numbers are visible. Pages created from the contract's deployer (or `owner()`) are marked **Verified**. Public pages are ranked on the leaderboard (`#/explore`) by wallets in the last 7 days.

### MCP server for AI agents

`/api/mcp` is a Model Context Protocol server (Streamable HTTP) so Claude and other agents can use QIE: `create_payment_link`, `wait_for_payment`, `create_alert`, `wait_for_event`, `get_events`, `resolve_qie_name`, `get_traction`, `network_status` and more (14 tools).

```bash
claude mcp add --transport http qiehooks https://qiehooks.fly.dev/api/mcp --header "Authorization: Bearer qh_live_…"
```

Then: *"Create a 5 QUSDC payment link for the logo design and tell me when it's paid."*

### Destinations

Signed **webhook** (HTTPS POST) · **Telegram** (private chat, group or channel, linked with a one-time code) · **Discord** (channel webhook).

---

## Run it locally

Requirements: Node ≥ 22.18 (runs TypeScript directly), pnpm, and Foundry for the contract and the end-to-end test.

```bash
pnpm install
cp .env.example .env            # optional: add TELEGRAM_BOT_TOKEN
pnpm --filter @qiehooks/web build
pnpm start                      # http://localhost:8787
```

For dashboard development with hot reload, run `pnpm --filter @qiehooks/server dev` and `pnpm --filter @qiehooks/web dev` (Vite proxies `/api` to the server).

## Tests

```bash
pnpm test        # server (65), SDK (6) and contract (12, incl. fuzz) tests
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
fly secrets set PUBLIC_URL=https://qiehooks.fly.dev TELEGRAM_BOT_TOKEN=... BILLING_CONTRACT=0x...
fly deploy
```

**Docker anywhere**

```bash
docker build -t qiehooks .
docker run -d -p 8787:8787 -v qiehooks-data:/data --env-file .env qiehooks
```

### 3. Telegram bot

Talk to [@BotFather](https://t.me/BotFather) → `/newbot` → put the token in `TELEGRAM_BOT_TOKEN`. The bot uses long polling, so no public webhook URL is needed. For a public community channel, add the bot as an admin and set `PUBLIC_ALERTS_CHAT_ID`: it then posts every QUSDC transfer above `PUBLIC_ALERTS_MIN_QUSDC` and every new QIEDEX pair.

---

## Using it from code

```ts
import { QieHooks, verifyWebhook } from "@qiehooks/sdk";

const qh = new QieHooks({ apiKey: process.env.QIEHOOKS_KEY!, baseUrl: "https://qiehooks.fly.dev" });
await qh.onPayment("shop.qie", { url: "https://shop.example.com/qie-webhook" }, { minAmount: "1" });

// in your webhook route (use the RAW body)
const event = verifyWebhook({ body: rawBody, headers: req.headers, secret: process.env.QIEHOOKS_SECRET! });
if (event.type === "payment.received") console.log(event.data.from.name, "paid", event.data.amount.display);
```

The full payload format, headers and examples in other languages are in the dashboard under **Docs**.

---

## Design notes

- **Exactly-once storage, at-least-once delivery.** The cursor only moves after a block range's events are committed. Events are unique per `(hook, tx hash, log index)`. Receivers should key on `event.id` or `tx.hash + logIndex`.
- **Finality.** QIE uses CometBFT, so blocks are final when produced and there are no reorgs to unwind. `CONFIRMATIONS=1` is a safety margin, not a reorg window.
- **Scheduled triggers** run on a 60-second timer (`CHECK_INTERVAL_MS`). Balances are read in one batched RPC call, and prices come from the QIEDEX API. If the QIE ID resolver is unreachable, a name watch skips that round instead of raising a false alarm.
- **Wallet watch noise control.** When a wallet's outgoing call already produced token transfers (a swap, a payment), only the transfers are reported, not an extra "contract call" event.
- **Native QIE.** Payments sent directly in a transaction are detected (only if the tx succeeded). QIE sent *by a contract* (internal transfers) is not, because the public RPC has no trace API. Token transfers from contracts are detected.
- **Security.** Webhook URLs are checked against private, loopback, link-local and metadata ranges before every delivery, and again at connect time (so DNS rebinding cannot reach internal hosts). Redirects are not followed. Sign-in uses a single-use, 10-minute EIP-4361-style message. Cookie-authenticated writes reject cross-origin requests. API keys and sessions are stored only as hashes.
- **Storage.** SQLite (WAL) through Node's built-in `node:sqlite`, so there are no native dependencies. For high volume, the same schema moves to Postgres.

## Status of the deliverable

- ✅ Server, dashboard, SDK and billing contract are complete and tested (unit, API, contract and fork end-to-end).
- ⏳ To do before submission: deploy the billing contract to QIE mainnet and verify it, deploy the server, create the Telegram bot, publish the SDK to npm, and onboard real users. See [docs/LAUNCH.md](docs/LAUNCH.md).

## License

MIT
