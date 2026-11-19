import { createHmac, timingSafeEqual } from "node:crypto";
import type { QPulseEvent } from "./types.ts";

export const SIGNATURE_HEADER = "qpulse-signature";
export const TIMESTAMP_HEADER = "qpulse-timestamp";

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

type HeaderBag = Headers | Record<string, string | string[] | undefined>;

function header(h: HeaderBag, name: string): string | undefined {
  if (typeof (h as Headers).get === "function") return (h as Headers).get(name) ?? undefined;
  const bag = h as Record<string, string | string[] | undefined>;
  const key = Object.keys(bag).find((k) => k.toLowerCase() === name);
  const v = key ? bag[key] : undefined;
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Verify a Q-Pulse webhook and return the parsed event.
 *
 * Pass the RAW request body (string or Buffer), not re-serialised JSON:
 * the signature covers the exact bytes that were sent.
 *
 * ```ts
 * const event = verifyWebhook({ body: rawBody, headers: req.headers, secret: process.env.QPULSE_SECRET! });
 * if (event.type === "payment.received") console.log(event.data.amount.display);
 * ```
 */
export function verifyWebhook(opts: {
  body: string | Uint8Array;
  headers: HeaderBag;
  secret: string;
  /** Max age of the signature in seconds. Default 300. */
  toleranceSec?: number;
  now?: number;
}): QPulseEvent {
  const body = typeof opts.body === "string" ? opts.body : Buffer.from(opts.body).toString("utf8");
  const sigHeader = header(opts.headers, SIGNATURE_HEADER);
  const tsHeader = header(opts.headers, TIMESTAMP_HEADER);
  if (!sigHeader || !tsHeader) throw new WebhookVerificationError("Missing QPulse-Signature or QPulse-Timestamp header");
  const ts = Number(tsHeader);
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > (opts.toleranceSec ?? 300)) throw new WebhookVerificationError("Signature timestamp is too old");

  const expected = createHmac("sha256", opts.secret).update(`${ts}.${body}`).digest();
  const valid = sigHeader.split(",").some((part) => {
    const [k, v] = part.trim().split("=");
    if (k !== "v1" || !v || !/^[0-9a-f]+$/i.test(v)) return false;
    const got = Buffer.from(v, "hex");
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
  if (!valid) throw new WebhookVerificationError("Signature does not match");
  return JSON.parse(body) as QPulseEvent;
}

/** Sign a body the way Q-Pulse does. Useful for testing your receiver. */
export function signWebhook(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): Record<string, string> {
  const sig = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return { "QPulse-Signature": `v1=${sig}`, "QPulse-Timestamp": String(timestamp), "content-type": "application/json" };
}
