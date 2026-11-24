# Self-hosting Q-Pulse

The hosted service at https://qpulsev1.up.railway.app is free to use. Run your own when you want your data on your own server, your own Telegram bot, or different plan limits. Everything is in this repository and MIT-licensed.

**What you need:** Node 22.18+ and pnpm 9 (or Docker), about 1 GB of disk, and outbound HTTPS to QIE's public RPC nodes. Optional: Foundry to deploy your own contracts, a Telegram bot token.

## 1. Run it locally

```bash
pnpm install
cp .env.example .env
pnpm --filter @qpulse/web build
pnpm start                       # http://localhost:8787
```

With an empty `.env` the server indexes QIE mainnet from the latest block, serves the dashboard, the API, the MCP server and the WebSocket RPC, and runs free-only (no billing contract). Every option is listed in [`.env.example`](../.env.example).

## 2. Deploy your own contracts (optional)

Billing and daily traction proofs each need a contract on QIE. Both are deployed in one go by [`DeployAll.s.sol`](../contracts/script/DeployAll.s.sol). See [contracts/README.md](../contracts/README.md) for what each contract does.

1. **Deployer wallet.** Any QIE account with about 0.1 QIE. Import it into Foundry's encrypted keystore; you type the key into the prompt yourself, never on a command line:
   ```bash
   cast wallet import deployer --interactive
   ```
2. **Attester key.** A separate hot wallet that only ever holds gas for the daily post. Create a keystore with a password read once by the shell (Foundry's hidden prompt in `cast wallet new` has produced keystores that would not unlock):
   ```bash
   read -s "P?Attester keystore password: " && cast wallet new ~/.foundry/keystores --unsafe-password "$P" && unset P
   ```
3. **Deploy and fund the attester** (0.05 QIE by default; one post costs about 0.0002 QIE):
   ```bash
   cd contracts
   TREASURY=0xYourTreasury ATTESTER=0xAttesterAddress \
     forge script script/DeployAll.s.sol --rpc-url qie --broadcast --account deployer
   ```
   Optional variables: `PRO_PRICE_UNITS` (QUSDC units, default `9000000` = 9 QUSDC), `PRO_PERIOD_SECONDS` (default 30 days), `ATTESTER_FUNDING` (wei).
4. **Note the deploy block**, so the server imports any Pro payment made before it starts:
   ```bash
   jq -r '.receipts[0].blockNumber' broadcast/DeployAll.s.sol/1990/run-latest.json | cast to-dec
   ```
5. **Verify the source** on the QIE explorer (Blockscout):
   ```bash
   forge verify-contract 0xBilling src/QPulseBilling.sol:QPulseBilling --rpc-url qie \
     --verifier blockscout --verifier-url https://mainnet.qie.digital/api/ \
     --constructor-args $(cast abi-encode "constructor(address,address,uint256,uint32)" 0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5 0xYourTreasury 9000000 2592000)
   forge verify-contract 0xAttestations src/PulseAttestations.sol:PulseAttestations --rpc-url qie \
     --verifier blockscout --verifier-url https://mainnet.qie.digital/api/ \
     --constructor-args $(cast abi-encode "constructor(address)" 0xAttesterAddress)
   ```
6. **Rotating the attester** later (if the key leaks or runs low): `ATTESTATIONS=0x… NEW_ATTESTER=0x… forge script script/RotateAttester.s.sol --rpc-url qie --broadcast --account deployer`. It sets the new attester and funds it in one go.

Then set `BILLING_CONTRACT`, `BILLING_START_BLOCK`, `ATTESTATION_CONTRACT` and `ATTESTER_PRIVATE_KEY` on the server. Treat the attester key as a secret: pipe it into your host's secret store rather than pasting it into a shell history.

> QIE nodes answer `eth_fillTransaction` with only the intrinsic gas. The server therefore estimates gas itself before each attestation; if you write your own scripts with viem, do the same.

## 3. Telegram bot (optional)

In Telegram open **@BotFather** → `/newbot`, choose a name and a username, and copy the token. Set `TELEGRAM_BOT_TOKEN` (and `TELEGRAM_BOT_USERNAME` without the `@`). The bot uses long polling, so no public webhook URL is needed. `/setuserpic` with [`docs/brand/bot-avatar.png`](brand/bot-avatar.png) gives it the Q-Pulse icon.

## 4. Deploy the server

Run it close to QIE's public RPC nodes (US East): every block needs a few round trips, so a server far away adds latency to every alert.

### Railway

```bash
railway init --name qpulse
railway add --service qpulse --variables "DB_PATH=/data/qpulse.db" --variables "QIE_NETWORK=mainnet" \
  --variables "PORT=8787" --variables "RAILWAY_RUN_UID=0"
railway service link qpulse
railway service scale us-east=1                 # one region; remove any other the project created
railway volume add --mount-path /data             # volumes are root-owned, hence RAILWAY_RUN_UID=0
railway domain --port 8787
railway variable set PUBLIC_URL=https://<your-domain> --skip-deploys
railway up --detach --service qpulse
```

Set secrets without echoing them, for example `cast wallet private-key --account attester | railway variable set ATTESTER_PRIVATE_KEY --stdin`, then `railway service redeploy`. On Railway the server reads the client IP from `x-real-ip` automatically.

### Fly.io

```bash
fly launch --no-deploy --copy-config              # fly.toml uses region ewr (New Jersey)
fly volumes create data --size 1 --region ewr
fly secrets set PUBLIC_URL=https://<name>.fly.dev TELEGRAM_BOT_TOKEN=… BILLING_CONTRACT=0x… \
  BILLING_START_BLOCK=… ATTESTATION_CONTRACT=0x…
fly secrets set ATTESTER_PRIVATE_KEY=0x…          # type it yourself
fly deploy
```

### Any server with Docker

```bash
docker build -t qpulse .
docker run -d -p 8787:8787 -v qpulse-data:/data --env-file .env -e DB_PATH=/data/qpulse.db qpulse
```

Put it behind HTTPS (Caddy, nginx or a load balancer) and set `CLIENT_IP_HEADER` to the header your proxy overwrites with the real client IP, so rate limits work per visitor.

## 5. Check it works

- `https://<your-domain>/#/status` shows 5 of 5 healthy RPC nodes and an indexer lag of 0 within a minute.
- `cast block-number --rpc-url wss://<your-domain>/rpc` prints the current QIE block (the WebSocket RPC works).
- Your bot answers `/start`.
- Sign in, create a hook, press **Send test**.
- `pnpm e2e` runs the whole server against a local fork of QIE mainnet with real transactions (needs Foundry's `anvil`).

## Operations

- **Backups:** the server snapshots the SQLite database once a day into `BACKUP_DIR` (default: a `backups` folder next to the database) and keeps the last `BACKUP_KEEP` (default 7). Copy them off the machine.
- **Upgrades:** pull, rebuild and restart. Schema migrations run on start-up and only ever add.
- **Restarts are safe:** the indexer resumes from the last fully stored block and duplicates are dropped, so no event is lost or delivered twice by a restart.
- **Retention:** events and their deliveries are kept for `EVENT_RETENTION_DAYS` (default 30).
