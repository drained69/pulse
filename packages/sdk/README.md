# qpulse-sdk

Typed client, webhook verification and a pay-per-request middleware for [Q-Pulse](https://github.com/drained69/pulse): real-time webhooks, Telegram and Discord alerts, payment links and products for QIE Blockchain.

- Zero runtime dependencies, ESM, TypeScript types included.
- Talks to the hosted server (`https://qpulsev1.up.railway.app`) by default, or to your own.
- Get an API key from the dashboard: **Settings → API keys** (starts with `qp_live_`).

```bash
npm install qpulse-sdk
```

## Hooks

```ts
import { QPulse } from "qpulse-sdk";

const qp = new QPulse({ apiKey: process.env.QPULSE_KEY! }); // or { apiKey, baseUrl: "https://your-own-server" }

// Payments (QIE and QUSDC) to a QIE ID
const hook = await qp.onPayment("shop.qie", { url: "https://shop.example.com/qie-webhook" }, { minAmount: "1" });
console.log(hook.secret); // whsec_…  keep it to verify deliveries

// Large QUSDC transfers, posted to Discord
await qp.hooks.create({
  name: "QUSDC whales",
  trigger: { type: "token_transfer", config: { token: "QUSDC", minAmount: "1000" } },
  channel: { type: "discord", config: { url: "https://discord.com/api/webhooks/…" } },
});

// Any contract event
await qp.hooks.create({
  name: "Vault deposits",
  trigger: { type: "contract_event", config: { address: "0x…", event: "event Deposit(address indexed user, uint256 amount)" } },
  channel: { type: "webhook", config: { url: "https://example.com/hook" } },
});

// Rug-pull radar: alert when a QIEDEX pair loses 30% of its liquidity within 24 hours
await qp.hooks.create({
  name: "Pair liquidity",
  trigger: { type: "liquidity", config: { pair: "0x…", dropPercent: 30 } },
  channel: { type: "webhook", config: { url: "https://example.com/hook" } },
});
```

Trigger types: `payment`, `token_transfer`, `swap`, `contract_event`, `wallet`, `balance`, `price`, `name_watch`, `daily_digest`, `invoice`, `liquidity`. Channels: `webhook`, `telegram`, `discord`.

Also on `qp.hooks`: `list`, `get`, `update`, `pause`, `resume`, `delete`, `rotateSecret`, `test`, `events`. Replay any past event with `qp.events.replay(eventId)`.

## Verify webhooks

```ts
import express from "express";
import { verifyWebhook } from "qpulse-sdk";

app.post("/qie-webhook", express.raw({ type: "application/json" }), (req, res) => {
  const event = verifyWebhook({ body: req.body, headers: req.headers, secret: process.env.QPULSE_SECRET! });
  switch (event.type) {
    case "payment.received":
      if (event.data.security?.lookalikeOf) console.warn("address-poisoning attempt, ignore");
      else console.log(`${event.data.from.name ?? event.data.from.address} paid ${event.data.amount.display}`);
      break;
    case "invoice.paid":
      console.log(`order ${event.data.metadata?.orderId} paid`);
      break;
    case "liquidity.drop":
      console.warn(`pair ${event.data.pair} lost ${event.data.dropPercent}% of its liquidity`);
      break;
  }
  res.sendStatus(200);
});
```

`verifyWebhook` checks the HMAC-SHA256 signature over `<timestamp>.<raw body>` and rejects timestamps older than 5 minutes. It throws `WebhookVerificationError` on failure. Always pass the raw body. Deliveries can repeat (retries, replays): de-duplicate on `event.id`.

`signWebhook(secret, body)` produces valid headers for testing your receiver.

## Payment links

```ts
const link = await qp.invoices.create({ amount: "25", token: "QUSDC", description: "Order #1042", metadata: { orderId: "1042" } });
// send the payer to link.url (hosted checkout with QIE Wallet button and QR code)

const done = await qp.invoices.waitForPayment(link.id); // or listen for the invoice.paid webhook
console.log(done.status, done.payment?.txHash);
```

Also: `get`, `list({ status, limit })`, `cancel`, `redeem`. Funds go straight to the recipient wallet; Q-Pulse never holds them.

## Products

One permanent link or QR code per product; every buyer gets a fresh checkout, and `unlockContent` is shown only after paying.

```ts
const coffee = await qp.products.create({ name: "Coffee", amount: "2", token: "QUSDC", unlockContent: "Your code: 4821" });
console.log(coffee.url);       // share or print as a QR code
console.log(coffee.deviceUrl); // a screen that unlocks when this product is paid
```

Each sale fires `invoice.paid` with `data.product`, so a webhook can open a real device. A signed receiver for a Raspberry Pi or similar is in [`examples/device-receiver`](https://github.com/drained69/pulse/tree/main/examples/device-receiver).

## Pay-per-request APIs (HTTP 402)

Charge people or AI agents per API call, in QUSDC on QIE:

```ts
import express from "express";
import { QPulse, paywall } from "qpulse-sdk";

const qp = new QPulse({ apiKey: process.env.QPULSE_KEY! });
const app = express();

app.get("/api/forecast", paywall({ client: qp, id: "forecast", amount: "0.05" }), (req, res) => {
  res.json({ forecast: "sunny" });
});
```

A request without a payment gets `402 Payment Required` with a payment link in the body. The caller pays it with any QIE wallet and repeats the request with the header `X-QPulse-Payment: <link id>`. The middleware checks that the link was made by this paywall, for this price, and is paid, then redeems it atomically: one payment buys exactly one request. For other frameworks use `checkPayment(options, headerValue)`, which returns `{ paid: true, invoice }` or the 402 status, headers and body to send.

## Traction and names

```ts
const { stats } = await qp.traction.get("patungan"); // public traction numbers
const board = await qp.traction.leaderboard();
const address = await qp.resolve("shop.qie");        // QIE ID → address
```

## Errors

API errors throw `QPulseError` with `status` (HTTP code) and `message`.

## Requirements

Node 18+ (uses the global `fetch` and `node:crypto`), or any runtime with `fetch`. MIT licence.
