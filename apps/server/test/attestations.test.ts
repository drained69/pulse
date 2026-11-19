/**
 * Traction attestations end to end, on a local anvil chain:
 * real PulseAttestations contract, the server's snapshot + anchoring loop,
 * the public proof API, and the verify-traction CLI against a fake explorer.
 * Uses anvil's well-known local test key only.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { serve } from "@hono/node-server";
import { createPublicClient, createWalletClient, http, keccak256, stringToHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import {
  ATTESTATIONS_ABI,
  buildTree,
  contractsHash,
  epochOf,
  leafHash,
  processProof,
  proofFor,
  recountFromExplorer,
  rootOf,
  txSetHash,
  type LeafData,
} from "../src/attest-core.ts";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { buildApp, buildServices } from "../src/main.ts";
import { StaticNameResolver } from "../src/names.ts";

const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // anvil account #0 (public test key)
const PORT = 18545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;
const artifact = JSON.parse(readFileSync(new URL("../../../contracts/out/PulseAttestations.sol/PulseAttestations.json", import.meta.url), "utf8"));

const C1 = "0x00000000000000000000000000000000000000c1";
const C2 = "0x00000000000000000000000000000000000000c2";
const W = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const TX = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

describe("traction attestations", () => {
  let anvil: ChildProcess;
  let contract: Hex;
  let s: ReturnType<typeof buildServices>;
  let server: Server;
  let base = "";
  const now = Math.floor(Date.now() / 1000);
  // What the "chain" (fake explorer) shows: txs to contracts, newest first per contract.
  const chainTxs: { hash: string; to: string; from: string; block: number; ts: number; ok: boolean }[] = [];
  const explorer = createServer((req, res) => {
    const m = /\/api\/v2\/addresses\/(0x[0-9a-fA-F]{40})\/transactions/.exec(req.url ?? "");
    const items = chainTxs
      .filter((t) => m && t.to === m[1]!.toLowerCase())
      .sort((a, b) => b.block - a.block)
      .map((t) => ({ hash: t.hash, block_number: t.block, timestamp: new Date(t.ts * 1000).toISOString(), status: t.ok ? "ok" : "error", from: { hash: t.from }, to: { hash: t.to } }));
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ items, next_page_params: null }));
  });
  const pub = createPublicClient({ chain: foundry, transport: http(RPC) });

  before(async () => {
    anvil = spawn("anvil", ["--port", String(PORT), "--silent"], { stdio: "ignore" });
    for (let i = 0; i < 100; i++) {
      try {
        await pub.getBlockNumber();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const account = privateKeyToAccount(ANVIL_KEY);
    const wallet = createWalletClient({ account, chain: foundry, transport: http(RPC) });
    const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [account.address] });
    contract = (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
    await pub.request({ method: "anvil_mine" as never, params: ["0x5"] as never });

    await new Promise<void>((r) => explorer.listen(0, "127.0.0.1", r));
    const cfg = loadConfig({
      DB_PATH: ":memory:",
      RPC_URLS: RPC,
      CHAIN_ID: "31337",
      ATTESTATION_CONTRACT: contract,
      ATTESTER_PRIVATE_KEY: ANVIL_KEY,
      EXPLORER_API_URL: `http://127.0.0.1:${(explorer.address() as AddressInfo).port}`,
      TELEGRAM_BOT_TOKEN: "",
    } as NodeJS.ProcessEnv);
    s = buildServices(cfg, { db: openDb(":memory:"), names: new StaticNameResolver({}) });
    server = await new Promise<Server>((r) => {
      const srv = serve({ fetch: buildApp(s).fetch, port: 0, hostname: "127.0.0.1" }, () => r(srv as Server)) as Server;
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // Two projects; the indexer has stored everything up to block 4.
    const db = s.db;
    db.prepare("INSERT INTO users (id, address, plan, created_at) VALUES ('u1', ?, 'free', 0)").run(W(1));
    const addProject = (id: string, slug: string, contracts: string[]) =>
      db
        .prepare("INSERT INTO projects (id, user_id, slug, name, contracts, backfill_status, created_at, updated_at) VALUES (?, 'u1', ?, ?, ?, 'done', 0, 0)")
        .run(id, slug, slug, JSON.stringify(contracts));
    addProject("p1", "alpha", [C2, C1]);
    addProject("p2", "beta", [C2]);
    addProject("p3", "gamma", [W(99)]);
    const tx = (n: number, to: string, from: string, block: number, ts: number, ok = true) => {
      chainTxs.push({ hash: TX(n), to, from, block, ts, ok });
      for (const [pid, cs] of [["p1", [C1, C2]], ["p2", [C2]]] as const) {
        if ((cs as readonly string[]).includes(to))
          db.prepare("INSERT INTO project_txs (project_id, tx_hash, contract, wallet, block_number, ts, ok) VALUES (?, ?, ?, ?, ?, ?, ?)").run(pid, TX(n), to, from, block, ts, ok ? 1 : 0);
      }
    };
    tx(1, C1, W(10), 2, now - 3600);
    tx(2, C1, W(10), 3, now - 1800);
    tx(3, C2, W(11), 3, now - 1800);
    tx(4, C2, W(12), 4, now - 60, false); // reverted: not counted
    tx(5, C1, W(13), 2, now - 40 * 86400); // older than the 30-day window
    tx(6, C2, W(14), 9, now); // after the snapshot block
    s.indexer.setCursor(4);
  });

  after(() => {
    s?.attestations.stop();
    server?.close();
    explorer.close();
    anvil?.kill("SIGTERM");
  });

  it("matches the contract's leaf hashing and Merkle proofs", async () => {
    const leaf: LeafData = { slug: "alpha", contracts: [C1, C2], fromTs: 1, toBlock: 2, txCount: 3, walletCount: 2, txSetHash: txSetHash([TX(2), TX(1)]) };
    const onchain = await pub.readContract({
      address: contract,
      abi: [{ type: "function", name: "leafHash", stateMutability: "pure", inputs: ["bytes32", "bytes32", "uint64", "uint64", "uint32", "uint32", "bytes32"].map((type) => ({ type, name: "" })), outputs: [{ type: "bytes32", name: "" }] }] as const,
      functionName: "leafHash",
      args: [keccak256(stringToHex("alpha")), contractsHash([C2, C1]), 1n, 2n, 3, 2, leaf.txSetHash],
    });
    assert.equal(onchain, leafHash(leaf));
    // Proofs for every leaf of odd-sized trees fold back to the root.
    for (const n of [1, 2, 3, 5, 8, 13]) {
      const leaves = Array.from({ length: n }, (_, i) => keccak256(stringToHex(`leaf${i}`)));
      const layers = buildTree(leaves);
      leaves.forEach((l, i) => assert.equal(processProof(l, proofFor(layers, i)), rootOf(layers)));
    }
  });

  it("computes a snapshot from stored activity and anchors it on chain", async () => {
    await s.attestations.runOnce(now); // snapshot + send
    let [a] = s.attestations.list();
    assert.equal(a!.status, "sent");
    assert.equal(a!.leaves, 3);
    assert.equal(a!.snapshotBlock, 4);
    await s.attestations.runOnce(now); // confirm
    [a] = s.attestations.list();
    assert.equal(a!.status, "anchored");
    assert.equal(a!.epoch, epochOf(now));

    const [root, leaves, snapshotBlock] = await pub.readContract({ address: contract, abi: ATTESTATIONS_ABI, functionName: "attestations", args: [a!.epoch] });
    assert.equal(root, a!.root);
    assert.equal(leaves, 3);
    assert.equal(snapshotBlock, 4n);

    // A second run the same day changes nothing.
    await s.attestations.runOnce(now + 60);
    assert.equal(s.attestations.list().length, 1);
  });

  it("serves proofs the contract accepts, with the right numbers", async () => {
    const res = await fetch(`${base}/api/projects/alpha/proof`);
    assert.equal(res.status, 200);
    const p = (await res.json()) as { leaf: LeafData; leafHash: Hex; proof: Hex[]; attestation: { epoch: number; root: Hex } };
    assert.equal(p.leaf.txCount, 3, "reverted, too-old and after-snapshot txs are excluded");
    assert.equal(p.leaf.walletCount, 2);
    assert.equal(leafHash(p.leaf), p.leafHash);
    assert.ok(await pub.readContract({ address: contract, abi: ATTESTATIONS_ABI, functionName: "verify", args: [p.attestation.epoch, p.leafHash, p.proof] }));
    // Inflate the numbers: the proof no longer verifies.
    const fake = leafHash({ ...p.leaf, txCount: p.leaf.txCount + 100 });
    assert.equal(await pub.readContract({ address: contract, abi: ATTESTATIONS_ABI, functionName: "verify", args: [p.attestation.epoch, fake, p.proof] }), false);

    const beta = (await (await fetch(`${base}/api/projects/beta/proof`)).json()) as { leaf: LeafData };
    assert.deepEqual([beta.leaf.txCount, beta.leaf.walletCount], [1, 1]);
    const list = (await (await fetch(`${base}/api/attestations`)).json()) as { contract: string; attestations: { status: string }[] };
    assert.equal(list.contract.toLowerCase(), contract.toLowerCase());
    assert.equal(list.attestations[0]!.status, "anchored");
  });

  it("recounts from the explorer to exactly the attested numbers", async () => {
    const p = (await (await fetch(`${base}/api/projects/alpha/proof`)).json()) as { leaf: LeafData };
    const rc = await recountFromExplorer(s.cfg.explorerApiUrl, p.leaf);
    assert.deepEqual([rc.txCount, rc.walletCount, rc.txSetHash], [p.leaf.txCount, p.leaf.walletCount, p.leaf.txSetHash]);
  });

  const cli = (slug: string) =>
    new Promise<{ code: number; out: string }>((resolve) => {
      const child = spawn(process.execPath, [new URL("../bin/verify-traction.ts", import.meta.url).pathname, slug, "--api", base], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      child.on("close", (code) => resolve({ code: code ?? -1, out }));
    });

  it("verify-traction CLI passes on honest numbers", async () => {
    const r = await cli("alpha");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /All checks passed/);
  });

  it("verify-traction CLI fails when the server's numbers don't match the chain", async () => {
    // The chain has a successful tx the server never counted (or the server inflated nothing
    // but dropped one): either way the attested numbers are wrong and the CLI must say so.
    chainTxs.push({ hash: TX(50), to: C1, from: W(20), block: 3, ts: now - 100, ok: true });
    const r = await cli("alpha");
    chainTxs.pop();
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /✗ transaction count matches the chain {2}claimed 3, recounted 4/);
    assert.match(r.out, /✗ recounted numbers fold into the snapshot's Merkle root/);
  });
});
