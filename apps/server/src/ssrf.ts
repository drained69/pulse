import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";

/** Private, loopback, link-local, CGNAT and cloud-metadata ranges a webhook must never reach. */
const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) blocked.addSubnet(net, prefix, "ipv6");

function isBlockedIp(ip: string): boolean {
  const mapped = ip.toLowerCase().startsWith("::ffff:") ? ip.slice(7) : ip;
  const fam = isIP(mapped);
  if (fam === 4) return blocked.check(mapped, "ipv4");
  if (fam === 6) return blocked.check(mapped, "ipv6");
  return true;
}

/** Throws if the URL is not a public http(s) endpoint. Checked again before every delivery. */
export async function assertPublicUrl(raw: string, allowPrivate: boolean): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only http and https URLs are allowed");
  if (url.username || url.password) throw new Error("URLs with credentials are not allowed");
  if (allowPrivate) return;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    throw new Error("Webhook URL must be publicly reachable");
  }
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
  if (addrs.length === 0) throw new Error("Webhook host does not resolve");
  for (const a of addrs) if (isBlockedIp(a.address)) throw new Error("Webhook URL resolves to a private or reserved address");
}

type LookupCb = (err: NodeJS.ErrnoException | null, address?: string | { address: string; family: number }[], family?: number) => void;

/**
 * DNS lookup used for the actual connection. Re-checks every resolved address, so a
 * domain that passes `assertPublicUrl` and then re-binds to a private IP is still refused.
 */
export function safeLookup(hostname: string, options: unknown, callback?: LookupCb): void {
  const cb = (typeof options === "function" ? options : callback) as LookupCb;
  const all = typeof options === "object" && options !== null && (options as { all?: boolean }).all === true;
  lookup(hostname, { all: true, verbatim: true }).then(
    (addrs) => {
      if (addrs.length === 0 || addrs.some((a) => isBlockedIp(a.address))) {
        const err = new Error("Webhook URL resolves to a private or reserved address") as NodeJS.ErrnoException;
        err.code = "EBLOCKED";
        return cb(err);
      }
      if (all) cb(null, addrs);
      else cb(null, addrs[0]!.address, addrs[0]!.family);
    },
    (e: NodeJS.ErrnoException) => cb(e),
  );
}

/** POST a body to a webhook URL without following redirects. Returns the HTTP status. */
export function postWebhook(raw: string, headers: Record<string, string>, body: string, timeoutMs: number, allowPrivate: boolean): Promise<number> {
  const url = new URL(raw);
  const mod = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      url,
      {
        method: "POST",
        headers: { ...headers, "content-length": String(Buffer.byteLength(body)) },
        signal: AbortSignal.timeout(timeoutMs),
        ...(allowPrivate ? {} : { lookup: safeLookup as never }),
      },
      (res) => {
        res.resume(); // discard the response body
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", (e) => reject(e.name === "AbortError" ? new Error(`Timed out after ${timeoutMs} ms`) : e));
    req.end(body);
  });
}
