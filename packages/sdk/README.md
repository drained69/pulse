# @qiepulse/sdk

Typed client and webhook verification for [QIE Pulse](../../README.md): real-time webhooks, Telegram and Discord alerts for QIE Blockchain.

```bash
npm install @qiepulse/sdk
```

## Create hooks

```ts
import { QieHooks } from "@qiepulse/sdk";

const qh = new QieHooks({ apiKey: process.env.QIEHOOKS_KEY!, baseUrl: "https://your-qiepulse-host" });

// Payments (QIE + QUSDC) to a QIE ID
const hook = await qh.onPayment("shop.qie", { url: "https://shop.example.com/qie-webhook" }, { minAmount: "1" });
console.log(hook.secret); // whsec_…  keep it to verify deliveries

// Large QUSDC transfers to Discord
await qh.hooks.create({
  name: "QUSDC whales",
  trigger: { type: "token_transfer", config: { token: "QUSDC", minAmount: "1000" } },
  channel: { type: "discord", config: { url: "https://discord.com/api/webhooks/…" } },
});

// Any contract event
await qh.hooks.create({
  name: "Vault deposits",
  trigger: { type: "contract_event", config: { address: "0x…", event: "event Deposit(address indexed user, uint256 amount)" } },
  channel: { type: "webhook", config: { url: "https://example.com/hook" } },
});
```

## Verify webhooks

```ts
import express from "express";
import { verifyWebhook } from "@qiepulse/sdk";

app.post("/qie-webhook", express.raw({ type: "application/json" }), (req, res) => {
  const event = verifyWebhook({ body: req.body, headers: req.headers, secret: process.env.QIEHOOKS_SECRET! });
  switch (event.type) {
    case "payment.received":
      console.log(`${event.data.from.name ?? event.data.from.address} paid ${event.data.amount.display}`);
      break;
    case "dex.swap":
      console.log(`${event.data.amountIn.display} → ${event.data.amountOut.display}`);
      break;
  }
  res.sendStatus(200);
});
```

`verifyWebhook` checks the HMAC-SHA256 signature over `<timestamp>.<raw body>` and rejects timestamps older than 5 minutes. It throws `WebhookVerificationError` on failure. Always pass the raw body.

`signWebhook(secret, body)` produces valid headers for testing your receiver.
