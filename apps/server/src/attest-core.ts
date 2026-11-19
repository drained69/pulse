/**
 * Traction attestation math, shared by the server, the dashboard's "Verify" button and the
 * verify-traction CLI. Must match contracts/src/PulseAttestations.sol exactly.
 * Only depends on viem, so the browser can import it too.
 */
import { concat, encodeAbiParameters, getAddress, keccak256, parseAbi, stringToHex, type Hex } from "viem";

/** Days covered by each project's attested numbers. */
export const WINDOW_DAYS = 30;

/** One project's numbers. Everything needed to recompute its leaf from the chain. */
export type LeafData = {
  slug: string;
  /** Contract addresses, lowercase, ascending. */
  contracts: string[];
  /** Window start, unix seconds, inclusive (snapshot block time - 30 days). */
  fromTs: number;
  /** Window end, block number, inclusive (= the attestation's snapshot block). */
  toBlock: number;
  /** Successful transactions sent directly to the contracts in the window. */
  txCount: number;
  /** Distinct senders of those transactions. */
  walletCount: number;
  /** keccak256 of the ascending, concatenated transaction hashes. */
  txSetHash: Hex;
};

export const ATTESTATIONS_ABI = parseAbi([
  "function attest(uint32 epoch, bytes32 root, uint32 leaves, uint64 snapshotBlock)",
  "function attestations(uint32 epoch) view returns (bytes32 root, uint32 leaves, uint64 snapshotBlock, uint64 attestedAt)",
  "function latestEpoch() view returns (uint32)",
  "function attester() view returns (address)",
  "function verify(uint32 epoch, bytes32 leaf, bytes32[] proof) view returns (bool)",
  "function verifyStats(uint32 epoch, bytes32 slugHash, bytes32 contractsHash, uint64 fromTs, uint64 toBlock, uint32 txCount, uint32 walletCount, bytes32 txSetHash, bytes32[] proof) view returns (bool)",
  "error NotAttester()",
  "error EmptyRoot()",
  "error EpochNotAfterLatest(uint32 epoch, uint32 latest)",
  "error EpochInFuture(uint32 epoch)",
  "error SnapshotNotInPast(uint64 snapshotBlock)",
  "event Attested(uint32 indexed epoch, bytes32 indexed root, uint32 leaves, uint64 snapshotBlock)",
]);

export const epochOf = (unixSec: number): number => Math.floor(unixSec / 86400);
export const epochDate = (epoch: number): string => new Date(epoch * 86400 * 1000).toISOString().slice(0, 10);

export function sortedContracts(addrs: string[]): string[] {
  return [...new Set(addrs.map((a) => a.toLowerCase()))].sort();
}

export function contractsHash(addrs: string[]): Hex {
  return keccak256(encodeAbiParameters([{ type: "address[]" }], [sortedContracts(addrs).map((a) => getAddress(a))]));
}

export function txSetHash(hashes: string[]): Hex {
  const sorted = [...new Set(hashes.map((h) => h.toLowerCase()))].sort() as Hex[];
  return keccak256(sorted.length ? concat(sorted) : "0x");
}

/** Double-hashed leaf, identical to PulseAttestations.leafHash(). */
export function leafHash(d: LeafData): Hex {
  const inner = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint64" }, { type: "uint64" }, { type: "uint32" }, { type: "uint32" }, { type: "bytes32" }],
      [keccak256(stringToHex(d.slug)), contractsHash(d.contracts), BigInt(d.fromTs), BigInt(d.toBlock), d.txCount, d.walletCount, d.txSetHash],
    ),
  );
  return keccak256(inner);
}

export function hashPair(a: Hex, b: Hex): Hex {
  return keccak256(a.toLowerCase() < b.toLowerCase() ? concat([a, b]) : concat([b, a]));
}

/** Tree layers, leaves first. An odd node at the end of a layer is carried up unchanged. */
export function buildTree(leaves: Hex[]): Hex[][] {
  if (leaves.length === 0) throw new Error("empty tree");
  const layers: Hex[][] = [leaves];
  while (layers[layers.length - 1]!.length > 1) {
    const prev = layers[layers.length - 1]!;
    const next: Hex[] = [];
    for (let i = 0; i < prev.length; i += 2) next.push(i + 1 < prev.length ? hashPair(prev[i]!, prev[i + 1]!) : prev[i]!);
    layers.push(next);
  }
  return layers;
}

export const rootOf = (layers: Hex[][]): Hex => layers[layers.length - 1]![0]!;

export function proofFor(layers: Hex[][], index: number): Hex[] {
  const proof: Hex[] = [];
  let i = index;
  for (let level = 0; level < layers.length - 1; level++) {
    const sibling = layers[level]![i ^ 1];
    if (sibling) proof.push(sibling); // no sibling: carried up, nothing to hash
    i = Math.floor(i / 2);
  }
  return proof;
}

export function processProof(leaf: Hex, proof: Hex[]): Hex {
  return proof.reduce((acc, p) => hashPair(acc, p), leaf);
}

// ───────── independent recount ─────────

type ExplorerTx = { hash: string; block_number: number; timestamp: string; status: string | null; from: { hash: string }; to: { hash: string } | null };

export type Recount = { txCount: number; walletCount: number; txSetHash: Hex; pages: number };

/**
 * Recount a leaf's numbers from QIE's Blockscout explorer, independently of Q-Pulse:
 * successful transactions sent directly to the contracts, with fromTs <= time and block <= toBlock.
 */
export async function recountFromExplorer(
  explorerApiUrl: string,
  leaf: Pick<LeafData, "contracts" | "fromTs" | "toBlock">,
  opts: { fetch?: typeof fetch; maxPages?: number; onPage?: (n: number) => void } = {},
): Promise<Recount> {
  const get = opts.fetch ?? fetch;
  const hashes = new Set<string>();
  const wallets = new Set<string>();
  let pages = 0;
  for (const contract of leaf.contracts) {
    let next: Record<string, unknown> | null = {};
    while (next) {
      if (++pages > (opts.maxPages ?? 2000)) throw new Error("too many explorer pages");
      const qs = new URLSearchParams({ filter: "to" });
      for (const [k, v] of Object.entries(next)) if (v !== null && v !== undefined) qs.set(k, String(v));
      const res = await get(`${explorerApiUrl.replace(/\/$/, "")}/api/v2/addresses/${contract}/transactions?${qs}`);
      if (!res.ok) throw new Error(`explorer HTTP ${res.status}`);
      const page = (await res.json()) as { items: ExplorerTx[]; next_page_params: Record<string, unknown> | null };
      opts.onPage?.(pages);
      let older = false;
      for (const t of page.items) {
        const ts = Math.floor(Date.parse(t.timestamp) / 1000);
        if (ts < leaf.fromTs) {
          older = true; // newest first: everything after this is outside the window
          continue;
        }
        if (t.block_number > leaf.toBlock || t.status !== "ok") continue;
        if (t.to?.hash.toLowerCase() !== contract.toLowerCase()) continue;
        hashes.add(t.hash.toLowerCase());
        wallets.add(t.from.hash.toLowerCase());
      }
      next = older ? null : page.next_page_params;
    }
  }
  return { txCount: hashes.size, walletCount: wallets.size, txSetHash: txSetHash([...hashes]), pages };
}
