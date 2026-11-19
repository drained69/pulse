import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Webhook signatures. The receiver recomputes
 *   HMAC-SHA256(secret, `${timestamp}.${rawBody}`)
 * and compares it with the `v1=` value in the `QPulse-Signature` header.
 * The timestamp is in `QPulse-Timestamp` (unix seconds) to block replays.
 */
export const SIGNATURE_HEADER = "QPulse-Signature";
export const TIMESTAMP_HEADER = "QPulse-Timestamp";
export const EVENT_ID_HEADER = "QPulse-Event-Id";
export const EVENT_TYPE_HEADER = "QPulse-Event-Type";

export function sign(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export function signatureHeader(secret: string, timestamp: number, body: string): string {
  return `v1=${sign(secret, timestamp, body)}`;
}

export function verify(secret: string, header: string, timestamp: number, body: string, toleranceSec = 300, now = Math.floor(Date.now() / 1000)): boolean {
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > toleranceSec) return false;
  const expected = Buffer.from(sign(secret, timestamp, body), "hex");
  for (const part of header.split(",")) {
    const [k, v] = part.trim().split("=");
    if (k !== "v1" || !v || !/^[0-9a-f]+$/i.test(v)) continue;
    const got = Buffer.from(v, "hex");
    if (got.length === expected.length && timingSafeEqual(got, expected)) return true;
  }
  return false;
}
