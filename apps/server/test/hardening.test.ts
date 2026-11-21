import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeAbiParameters, encodeEventTopics, getAddress } from "viem";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupDatabase } from "../src/backup.ts";
import { applySubscriptionLog, ensureUser } from "../src/billing.ts";
import { SUBSCRIBED_EVENT, type RpcLog } from "../src/chain.ts";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { HookService } from "../src/hooks.ts";
import { InvoiceService } from "../src/invoices.ts";
import { StaticNameResolver } from "../src/names.ts";
import { argText, describe as describeEvent, type EventPayload } from "../src/payload.ts";
import { RpcPool } from "../src/rpc.ts";
import { MAX_FILTERS_PER_IP, RpcGateway, StreamHub } from "../src/stream.ts";
import { TokenService, safeSymbol } from "../src/tokens.ts";

const SHOP = getAddress("0x172083F7f31f82e4B57bA8aCf9822C72BB35b174");

describe("untrusted text in alerts", () => {
  it("reduces token symbols to a plain ticker", () => {
    assert.equal(safeSymbol("QUSDC"), "QUSDC");
    assert.equal(safeSymbol("USD.e"), "USDe");
    assert.equal(safeSymbol("[Claim airdrop](https://evil.xyz)"), "Claimairdrophttp");
    assert.equal(safeSymbol("visit evil.xyz now"), "visitevilxyznow");
    assert.equal(safeSymbol(""), "TOKEN");
    assert.equal(safeSymbol(42), "TOKEN");
    assert.ok(safeSymbol("A".repeat(100)).length <= 16);
  });

  it("defangs string event arguments so they cannot become links", () => {
    const t = argText("Your refund is at https://evil.xyz/claim [here](https://evil.xyz) @support_bot");
    assert.doesNotMatch(t, /https?:\/\//);
    assert.doesNotMatch(t, /evil\.xyz/);
    assert.doesNotMatch(t, /[[\]()@]/);
    assert.equal(argText("0x172083F7f31f82e4B57bA8aCf9822C72BB35b174"), "0x172083F7f31f82e4B57bA8aCf9822C72BB35b174");
    assert.equal(argText("123456789"), "123456789");
    assert.equal(argText(["1", "2", "3"]), "[3 items]");
    assert.ok(argText("x".repeat(500)).length < 70);
  });

  it("uses the defanged text in contract event alerts", () => {
    const p = {
      id: "evt_1",
      type: "contract.event",
      createdAt: new Date().toISOString(),
      hook: { id: "hk_1", name: "My contract" },
      chain: { id: 1990, network: "mainnet" },
      tx: null,
      data: { contract: SHOP, event: "Note", args: { text: "go to scam.example.com" } },
    } as EventPayload;
    const { lines } = describeEvent(p);
    assert.equal(lines.length, 1);
    assert.doesNotMatch(lines[0]!, /scam\.example/);
  });
});

describe("billing events", () => {
  const log = (planId: number): RpcLog => ({
    address: "0x9999999999999999999999999999999999999999",
    topics: encodeEventTopics({ abi: [SUBSCRIBED_EVENT], args: { account: SHOP, planId } }) as `0x${string}`[],
    data: encodeAbiParameters([{ type: "uint32" }, { type: "uint256" }, { type: "uint64" }], [1, 9_000_000n, BigInt(Math.floor(Date.now() / 1000) + 86400)]),
    blockNumber: "0x10",
    transactionHash: `0x${planId.toString().repeat(64)}`,
    transactionIndex: "0x0",
    logIndex: "0x0",
    blockHash: `0x${"00".repeat(32)}`,
  });

  it("only the Pro plan id unlocks Pro", () => {
    const db = openDb(":memory:");
    assert.equal(applySubscriptionLog(db, log(2)), null, "an unknown plan does not unlock Pro");
    assert.equal(ensureUser(db, SHOP).plan, "free");
    assert.ok(applySubscriptionLog(db, log(1)));
    assert.equal(ensureUser(db, SHOP).plan, "pro");
  });
});

describe("payment links", () => {
  it("a cancelled link keeps its amount, so a late payment can't settle a newer link", async () => {
    const cfg = loadConfig({ DB_PATH: ":memory:" } as NodeJS.ProcessEnv);
    const db = openDb(":memory:");
    const names = new StaticNameResolver({});
    const invoices = new InvoiceService(cfg, db, new HookService(cfg, db, names), names, new TokenService(new RpcPool(["http://127.0.0.1:1"]), "http://127.0.0.1:1"));
    const user = ensureUser(db, SHOP);
    const first = await invoices.create(user, { amount: "5" });
    invoices.cancel(user.id, first.id);
    const second = await invoices.create(user, { amount: "5" });
    assert.notEqual(second.amount.raw, first.amount.raw);
  });
});

describe("public RPC gateway", () => {
  it("limits server-side filters per client", async () => {
    const cfg = loadConfig({ DB_PATH: ":memory:", RPC_URLS: "http://127.0.0.1:1" } as NodeJS.ProcessEnv);
    const rpc = new RpcPool(cfg.rpcUrls, { timeoutMs: 200 });
    const hub = new StreamHub(rpc, null, { pollMs: 1_000_000 });
    const gw = new RpcGateway(cfg, rpc, hub);
    const make = (ip: string) => gw.handle({ jsonrpc: "2.0", id: 1, method: "eth_newBlockFilter", params: [] }, null, ip) as Promise<{ result?: string; error?: { code: number } }>;
    for (let i = 0; i < MAX_FILTERS_PER_IP; i++) assert.ok((await make("1.1.1.1")).result);
    const over = await make("1.1.1.1");
    assert.equal(over.error?.code, -32005);
    assert.ok((await make("2.2.2.2")).result, "other clients are not affected");
    gw.stop();
    hub.stop();
  });
});

describe("database backups", () => {
  it("writes one consistent copy per day and keeps the newest ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "qpulse-backup-"));
    try {
      const db = openDb(":memory:");
      ensureUser(db, SHOP);
      const day = (d: number) => new Date(Date.UTC(2026, 10, d, 12));
      const first = backupDatabase(db, dir, 3, day(1));
      assert.ok(first && existsSync(first));
      assert.equal(backupDatabase(db, dir, 3, day(1)), null, "one copy per day");
      for (const d of [2, 3, 4, 5]) backupDatabase(db, dir, 3, day(d));
      assert.deepEqual(readdirSync(dir).sort(), ["qpulse-2026-11-03.db", "qpulse-2026-11-04.db", "qpulse-2026-11-05.db"]);
      const copy = openDb(join(dir, "qpulse-2026-11-05.db"));
      assert.ok(copy.prepare("SELECT 1 FROM users WHERE address = ?").get(SHOP), "the copy is a working database");
      assert.equal(backupDatabase(db, "", 3, day(6)), null, "off when no directory is set");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
