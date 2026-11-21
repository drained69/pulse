#!/usr/bin/env node
// Q-Pulse device receiver: unlock a lock, start a machine or vend something when a product is paid on QIE.
//
// 1. In Q-Pulse create a product (Payment links → Products) and a hook "Payment link paid" → Webhook,
//    pointing at this receiver (e.g. https://your-device.example/qpulse, behind HTTPS).
// 2. Run:  QPULSE_SECRET=whsec_… PRODUCT_ID=prd_… UNLOCK_CMD="gpioset gpiochip0 17=1; sleep 30; gpioset gpiochip0 17=0" node receiver.mjs
//    (no dependencies; Node 18+). Without UNLOCK_CMD it just logs "UNLOCK".
//
// It verifies the HMAC signature, rejects old or replayed events, ignores other products, and runs
// the unlock command once per payment.
import { createHmac, timingSafeEqual } from "node:crypto";
import { exec } from "node:child_process";
import { createServer } from "node:http";

const SECRET = process.env.QPULSE_SECRET ?? "";
const PRODUCT_ID = process.env.PRODUCT_ID ?? ""; // empty = any product
const UNLOCK_CMD = process.env.UNLOCK_CMD ?? "";
const PORT = Number(process.env.PORT ?? 8080);
const TOLERANCE_SEC = 300;
if (!SECRET.startsWith("whsec_")) {
  console.error("Set QPULSE_SECRET to the hook's signing secret (whsec_…), shown on the hook page.");
  process.exit(1);
}

/** Same check as qpulse-sdk's verifyWebhook: HMAC-SHA256 over `${timestamp}.${body}`. */
function verify(body, signature, timestamp) {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > TOLERANCE_SEC) return false;
  const expected = createHmac("sha256", SECRET).update(`${ts}.${body}`).digest();
  return String(signature ?? "")
    .split(",")
    .map((p) => p.trim().split("="))
    .some(([k, v]) => k === "v1" && /^[0-9a-f]{64}$/i.test(v ?? "") && timingSafeEqual(Buffer.from(v, "hex"), expected));
}

const done = new Set(); // payments already acted on (keep it in a file for a real device)

createServer((req, res) => {
  if (req.method !== "POST") return void res.writeHead(405).end();
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (c) => {
    body += c;
    if (body.length > 256 * 1024) req.destroy();
  });
  req.on("end", () => {
    if (!verify(body, req.headers["qpulse-signature"], req.headers["qpulse-timestamp"])) {
      return void res.writeHead(401).end("bad signature");
    }
    res.writeHead(200).end("ok"); // answer fast; Q-Pulse retries anything that isn't 2xx
    const event = JSON.parse(body);
    if (event.type !== "invoice.paid") return;
    const product = event.data?.product;
    if (!product || (PRODUCT_ID && product.id !== PRODUCT_ID)) return;
    const key = event.data.invoice.id; // one payment = one unlock, even if the event is delivered twice
    if (done.has(key)) return;
    done.add(key);
    console.log(`UNLOCK ${product.name}: ${event.data.amount.display} from ${event.data.from.name ?? event.data.from.address} (tx ${event.tx.hash})`);
    if (UNLOCK_CMD) exec(UNLOCK_CMD, (err) => err && console.error("unlock command failed:", err.message));
  });
}).listen(PORT, () => console.log(`Q-Pulse device receiver on :${PORT}${PRODUCT_ID ? ` for ${PRODUCT_ID}` : ""}`));
