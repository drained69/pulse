import { getAddress, isAddress, verifyMessage } from "viem";
import { ensureUser, type UserRow } from "./billing.ts";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { HttpError } from "./hooks.ts";
import type { NameResolver } from "./names.ts";
import { newId, nowSec, randomToken, sha256 } from "./util.ts";

export const SESSION_COOKIE = "qp_session";

/** Sign-in message in the EIP-4361 (Sign-In with Ethereum) layout, signed with QIE Wallet or any EVM wallet. */
export function buildSignInMessage(cfg: Config, address: string, nonce: string, issuedAt: Date): string {
  const host = new URL(cfg.publicUrl).host;
  const exp = new Date(issuedAt.getTime() + 10 * 60_000);
  return [
    `${host} wants you to sign in with your QIE account:`,
    getAddress(address),
    "",
    "Sign in to Q-Pulse. This request does not send a transaction or cost any QIE.",
    "",
    `URI: ${cfg.publicUrl}`,
    "Version: 1",
    `Chain ID: ${cfg.chainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt.toISOString()}`,
    `Expiration Time: ${exp.toISOString()}`,
  ].join("\n");
}

export class AuthService {
  private cfg: Config;
  private db: Db;
  private names: NameResolver;

  constructor(cfg: Config, db: Db, names: NameResolver) {
    this.cfg = cfg;
    this.db = db;
    this.names = names;
  }

  createNonce(address: string): { message: string; nonce: string } {
    if (!isAddress(address)) throw new HttpError(400, "address must be a 0x address");
    const nonce = randomToken(12).replace(/[^a-zA-Z0-9]/g, "");
    const message = buildSignInMessage(this.cfg, address, nonce, new Date());
    this.db.prepare("DELETE FROM auth_nonces WHERE expires_at < ?").run(nowSec());
    this.db.prepare("INSERT INTO auth_nonces (nonce, address, message, expires_at) VALUES (?, ?, ?, ?)").run(nonce, getAddress(address), message, nowSec() + 600);
    return { message, nonce };
  }

  async verify(address: string, signature: string, nonce: string): Promise<{ token: string; user: UserRow }> {
    if (!isAddress(address) || !/^0x[0-9a-fA-F]+$/.test(signature)) throw new HttpError(400, "Bad address or signature");
    const row = this.db.prepare("SELECT * FROM auth_nonces WHERE nonce = ?").get(nonce) as
      | { nonce: string; address: string; message: string; expires_at: number }
      | undefined;
    if (!row || row.expires_at < nowSec() || row.address !== getAddress(address)) throw new HttpError(401, "Sign-in request expired. Try again.");
    this.db.prepare("DELETE FROM auth_nonces WHERE nonce = ?").run(nonce); // single use
    const ok = await verifyMessage({ address: getAddress(address), message: row.message, signature: signature as `0x${string}` }).catch(() => false);
    if (!ok) throw new HttpError(401, "Signature does not match this address");

    const user = ensureUser(this.db, address);
    // Don't hold sign-in on a slow resolver: keep the stored name if the lookup is slow or fails.
    const name = await Promise.race([
      this.names.reverse(user.address).catch(() => user.qie_name),
      new Promise<string | null>((r) => setTimeout(() => r(user.qie_name), 2000).unref()),
    ]);
    if (name !== user.qie_name) {
      this.db.prepare("UPDATE users SET qie_name = ? WHERE id = ?").run(name, user.id);
      user.qie_name = name;
    }
    const token = randomToken(32);
    this.db
      .prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .run(sha256(token), user.id, nowSec() + this.cfg.sessionDays * 86400, nowSec());
    return { token, user };
  }

  userForSession(token: string | undefined): UserRow | null {
    if (!token) return null;
    const row = this.db
      .prepare("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?")
      .get(sha256(token), nowSec()) as UserRow | undefined;
    return row ?? null;
  }

  logout(token: string | undefined): void {
    if (token) this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
  }

  createApiKey(userId: string, name: string): { id: string; key: string; prefix: string } {
    const count = (this.db.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ?").get(userId) as { n: number }).n;
    if (count >= 10) throw new HttpError(400, "At most 10 API keys per account");
    const key = `qp_live_${randomToken(24)}`;
    const id = newId("key");
    const prefix = key.slice(0, 14);
    this.db
      .prepare("INSERT INTO api_keys (id, user_id, name, key_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, userId, name.slice(0, 60) || "API key", sha256(key), prefix, nowSec());
    return { id, key, prefix };
  }

  userForApiKey(key: string): UserRow | null {
    const row = this.db
      .prepare("SELECT u.*, k.id AS key_id FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.key_hash = ?")
      .get(sha256(key)) as (UserRow & { key_id: string }) | undefined;
    if (!row) return null;
    this.db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(nowSec(), row.key_id);
    const { key_id: _k, ...user } = row;
    return user;
  }
}
