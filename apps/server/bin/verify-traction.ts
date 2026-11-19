#!/usr/bin/env node
/**
 * Check a QIE Pulse traction page against the chain, without trusting QIE Pulse.
 *
 *   node apps/server/bin/verify-traction.ts <slug> [--api https://app] [--rpc URL] [--explorer URL] [--epoch N]
 *
 * 1. Fetch the claimed numbers and Merkle proof from the QIE Pulse API.
 * 2. Recount them independently from QIE's explorer (Blockscout).
 * 3. Hash the RECOUNTED numbers into a leaf and fold the proof into a root.
 * 4. Read the root QIE Pulse posted on chain (PulseAttestations) straight from a QIE node,
 *    and ask the contract to verify the proof too.
 * Exit code 0 only if every check passes.
 */
import { createPublicClient, http, type Hex } from "viem";
import { ATTESTATIONS_ABI, epochDate, leafHash, processProof, recountFromExplorer, type LeafData } from "../src/attest-core.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const slug = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
if (!slug) {
  console.error("usage: verify-traction <slug> [--api URL] [--rpc URL] [--explorer URL] [--epoch N]");
  process.exit(2);
}
const api = (flag("api") ?? process.env.QIEPULSE_URL ?? "http://localhost:8787").replace(/\/$/, "");

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const green = (s: string) => (color ? `\x1b[32m${s}\x1b[0m` : s);
const red = (s: string) => (color ? `\x1b[31m${s}\x1b[0m` : s);
let failed = 0;
const check = (ok: boolean, label: string, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? green("✓") : red("✗")} ${label}${detail ? `  ${detail}` : ""}`);
};

type ProofResponse = {
  attestation: { epoch: number; root: Hex; snapshotBlock: number; status: string; txHash: string | null };
  contract: Hex | null;
  chainId: number;
  leaf: LeafData;
  leafHash: Hex;
  proof: Hex[];
  explorerApiUrl: string;
  rpcUrls: string[];
};

const epochQs = flag("epoch") ? `?epoch=${flag("epoch")}` : "";
const res = await fetch(`${api}/api/projects/${encodeURIComponent(slug)}/proof${epochQs}`);
if (!res.ok) {
  console.error(`QIE Pulse API: HTTP ${res.status} ${await res.text()}`);
  process.exit(1);
}
const p = (await res.json()) as ProofResponse;
const { leaf, attestation: a } = p;
console.log(`\n${slug}: snapshot ${epochDate(a.epoch)} (epoch ${a.epoch}), block ${leaf.toBlock}`);
console.log(`claimed: ${leaf.txCount} successful txs from ${leaf.walletCount} wallets to ${leaf.contracts.length} contract(s), ${new Date(leaf.fromTs * 1000).toISOString()} → block ${leaf.toBlock}\n`);

// 2. Independent recount.
const explorer = flag("explorer") ?? p.explorerApiUrl;
process.stdout.write(`recounting from ${explorer} … `);
const rc = await recountFromExplorer(explorer, leaf, { onPage: (n) => n % 10 === 0 && process.stdout.write(".") });
console.log(`${rc.pages} page(s)\n`);
check(rc.txCount === leaf.txCount, "transaction count matches the chain", `claimed ${leaf.txCount}, recounted ${rc.txCount}`);
check(rc.walletCount === leaf.walletCount, "wallet count matches the chain", `claimed ${leaf.walletCount}, recounted ${rc.walletCount}`);
check(rc.txSetHash === leaf.txSetHash, "exact transaction set matches", rc.txSetHash === leaf.txSetHash ? "" : `claimed ${leaf.txSetHash.slice(0, 12)}…, recounted ${rc.txSetHash.slice(0, 12)}…`);

// 3. Leaf from the RECOUNTED numbers, folded into a root.
const recounted: LeafData = { ...leaf, txCount: rc.txCount, walletCount: rc.walletCount, txSetHash: rc.txSetHash };
const myLeaf = leafHash(recounted);
const myRoot = processProof(myLeaf, p.proof);
check(myRoot.toLowerCase() === a.root.toLowerCase(), "recounted numbers fold into the snapshot's Merkle root", myRoot);

// 4. The root on chain, read directly from a QIE node.
if (!p.contract) {
  check(false, "snapshot is anchored on chain", "this QIE Pulse server has no attestation contract configured");
} else {
  const client = createPublicClient({ transport: http(flag("rpc") ?? p.rpcUrls[0]) });
  const chainId = await client.getChainId();
  check(chainId === p.chainId, "RPC is the expected chain", `chain ${chainId}`);
  const [root, leaves, snapshotBlock, attestedAt] = await client.readContract({ address: p.contract, abi: ATTESTATIONS_ABI, functionName: "attestations", args: [a.epoch] });
  const posted = BigInt(root) !== 0n;
  check(posted, "root is posted on chain", posted ? `${p.contract} at ${new Date(Number(attestedAt) * 1000).toISOString()} (${leaves} project${leaves === 1 ? "" : "s"})` : `epoch ${a.epoch} not posted yet (status: ${a.status})`);
  if (posted) {
    check(root.toLowerCase() === myRoot.toLowerCase(), "on-chain root equals the recomputed root", root);
    check(Number(snapshotBlock) === leaf.toBlock, "on-chain snapshot block matches the window", String(snapshotBlock));
    const ok = await client.readContract({ address: p.contract, abi: ATTESTATIONS_ABI, functionName: "verify", args: [a.epoch, myLeaf, p.proof] });
    check(ok, "PulseAttestations.verify(epoch, leaf, proof) returns true");
  }
}

console.log(failed ? red(`\n${failed} check(s) failed`) : green("\nAll checks passed: these numbers are on chain and match QIE's own explorer."));
process.exit(failed ? 1 : 0);
