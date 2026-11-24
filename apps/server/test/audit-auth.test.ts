import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { buildApp, buildServices } from "../src/main.ts";
import { StaticNameResolver } from "../src/names.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });
function fixture() {
  const cfg = loadConfig({ DB_PATH: ":memory:", PUBLIC_URL: "https://qpulse.example", RPC_URLS: "http://127.0.0.1:1", QIEDEX_API_URL: "http://127.0.0.1:1" } as NodeJS.ProcessEnv);
  const s = buildServices(cfg, { db: openDb(":memory:"), names: new StaticNameResolver({}) });
  cleanup.push(() => s.db.close());
  return { s, app: buildApp(s) };
}

describe("audit: sign-in origin binding", () => {
  it("blocks login CSRF through a browser-submittable text/plain form without consuming the nonce", async () => {
    const { s, app } = fixture();
    const attacker = privateKeyToAccount(generatePrivateKey());
    const nonce = s.auth.createNonce(attacker.address);
    const signature = await attacker.signMessage({ message: nonce.message });
    // An HTML text/plain form can generate valid JSON by putting the '=' separator
    // inside an otherwise unused string property. No preflight or existing cookie is needed.
    const formBody = JSON.stringify({ address: attacker.address, nonce: nonce.nonce, signature, form: "=" }) + "\r\n";
    const forged = await app.request("/api/auth/verify", {
      method: "POST", headers: { origin: "https://attacker.example", "content-type": "text/plain" }, body: formBody,
    });
    assert.equal(forged.status, 403, "a foreign page must not install the attacker's session in the visitor's browser");
    assert.equal(forged.headers.get("set-cookie"), null);
    assert.equal((s.db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n, 0);
    const legitimate = await app.request("/api/auth/verify", {
      method: "POST", headers: { origin: "https://qpulse.example", "content-type": "application/json" }, body: formBody,
    });
    assert.equal(legitimate.status, 200);
    const cookie = legitimate.headers.get("set-cookie")!.split(";")[0]!;
    const me = await app.request("/api/me", { headers: { cookie } });
    assert.equal((await me.json() as any).user.address, attacker.address);
  });

  it("rejects forged host headers and scheme-downgraded origins on cookie-authenticated changes", async () => {
    const { s, app } = fixture();
    const account = privateKeyToAccount(generatePrivateKey());
    const nonce = s.auth.createNonce(account.address);
    const { token, user } = await s.auth.verify(account.address, await account.signMessage({ message: nonce.message }), nonce.nonce);
    for (const headers of [
      { origin: "https://attacker.example", "x-forwarded-host": "attacker.example" },
      { origin: "https://attacker.example", host: "attacker.example" },
      { origin: "http://qpulse.example", host: "qpulse.example" },
      { origin: "null", host: "qpulse.example" },
    ] as Record<string, string>[]) {
      const res = await app.request("/api/keys", {
        method: "POST", headers: { ...headers, cookie: `qp_session=${token}`, "content-type": "application/json" }, body: JSON.stringify({ name: "forged" }),
      });
      assert.equal(res.status, 403, JSON.stringify(headers));
    }
    assert.equal((s.db.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE user_id=?").get(user.id) as { n: number }).n, 0);
    const direct = await app.request("/api/keys", {
      method: "POST", headers: { cookie: `qp_session=${token}`, "content-type": "application/json" }, body: JSON.stringify({ name: "direct client" }),
    });
    assert.equal(direct.status, 201, "non-browser clients without Origin continue to work");
  });

  it("does not allow a foreign origin to log out a user", async () => {
    const { s, app } = fixture();
    const account = privateKeyToAccount(generatePrivateKey());
    const nonce = s.auth.createNonce(account.address);
    const { token } = await s.auth.verify(account.address, await account.signMessage({ message: nonce.message }), nonce.nonce);
    const forged = await app.request("/api/auth/logout", { method: "POST", headers: { origin: "https://attacker.example", cookie: `qp_session=${token}` } });
    assert.equal(forged.status, 403);
    assert.ok(s.auth.userForSession(token), "the legitimate session remains usable");
    const legitimate = await app.request("/api/auth/logout", { method: "POST", headers: { origin: "https://qpulse.example", cookie: `qp_session=${token}` } });
    assert.equal(legitimate.status, 200);
    assert.equal(s.auth.userForSession(token), null);
  });
});
