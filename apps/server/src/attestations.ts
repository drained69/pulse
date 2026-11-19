import { createWalletClient, custom, decodeFunctionResult, defineChain, encodeFunctionData, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ATTESTATIONS_ABI,
  WINDOW_DAYS,
  buildTree,
  epochDate,
  epochOf,
  leafHash,
  proofFor,
  rootOf,
  sortedContracts,
  txSetHash,
  type LeafData,
} from "./attest-core.ts";
import { hexToNum, numToHex, type RpcBlock, type RpcReceipt } from "./chain.ts";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import type { Indexer } from "./indexer.ts";
import type { RpcPool } from "./rpc.ts";
import { errMsg, log, nowSec } from "./util.ts";

/**
 * Daily on-chain attestations of traction numbers.
 *
 * Once per UTC day: take the indexer's cursor (every block up to it is fully stored),
 * compute each project's 30-day numbers up to that block, build a Merkle tree of the
 * leaves and post the root to PulseAttestations. Anyone can then recompute a project's
 * numbers from the chain and check them against the root without trusting this server.
 *
 * Without ATTESTATION_CONTRACT / ATTESTER_PRIVATE_KEY the snapshots are still computed
 * and served (status "computed"); they are just not anchored on chain.
 */

export type AttestationStatus = "computed" | "sent" | "anchored" | "failed" | "superseded";

type Row = {
  day: number;
  root: string;
  leaves: string;
  tx_hash: string | null;
  block_number: number | null;
  created_at: number;
  snapshot_block: number;
  snapshot_ts: number;
  status: AttestationStatus;
  error: string | null;
  sent_at: number | null;
};

/** A sent attestation without a receipt after this long is re-sent. */
const SENT_TIMEOUT_SEC = 15 * 60;

export type PublicAttestation = {
  epoch: number;
  date: string;
  root: Hex;
  leaves: number;
  snapshotBlock: number;
  snapshotTs: number;
  status: AttestationStatus;
  txHash: string | null;
  blockNumber: number | null;
  error: string | null;
};

const DAY = 86400;

function toPublic(r: Row): PublicAttestation {
  return {
    epoch: r.day,
    date: epochDate(r.day),
    root: r.root as Hex,
    leaves: (JSON.parse(r.leaves) as unknown[]).length,
    snapshotBlock: r.snapshot_block,
    snapshotTs: r.snapshot_ts,
    status: r.status,
    txHash: r.tx_hash,
    blockNumber: r.block_number,
    error: r.error,
  };
}

export class AttestationService {
  private cfg: Config;
  private db: Db;
  private rpc: RpcPool;
  private indexer: Indexer;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private wake: (() => void) | null = null;

  constructor(cfg: Config, db: Db, rpc: RpcPool, indexer: Indexer) {
    this.cfg = cfg;
    this.db = db;
    this.rpc = rpc;
    this.indexer = indexer;
  }

  get anchoring(): boolean {
    return Boolean(this.cfg.attestationContract && this.cfg.attesterKey);
  }

  // ───────── snapshot ─────────

  /** Numbers for every project whose history import finished, up to and including `toBlock`. */
  computeLeaves(toBlock: number, toTs: number): LeafData[] {
    const fromTs = toTs - WINDOW_DAYS * DAY;
    const projects = this.db
      .prepare("SELECT id, slug, contracts FROM projects WHERE backfill_status = 'done' AND backfill_truncated = 0 ORDER BY slug")
      .all() as { id: string; slug: string; contracts: string }[];
    const txs = this.db.prepare("SELECT tx_hash, wallet FROM project_txs WHERE project_id = ? AND ok = 1 AND ts >= ? AND block_number <= ?");
    return projects.map((p) => {
      const rows = txs.all(p.id, fromTs, toBlock) as { tx_hash: string; wallet: string }[];
      return {
        slug: p.slug,
        contracts: sortedContracts(JSON.parse(p.contracts) as string[]),
        fromTs,
        toBlock,
        txCount: rows.length,
        walletCount: new Set(rows.map((r) => r.wallet)).size,
        txSetHash: txSetHash(rows.map((r) => r.tx_hash)),
      };
    });
  }

  /** Compute today's snapshot if it doesn't exist yet. Returns the epoch written, or null. */
  async snapshot(now = nowSec()): Promise<number | null> {
    const epoch = epochOf(now);
    if (this.db.prepare("SELECT 1 FROM attestations WHERE day = ?").get(epoch)) return null;
    const cursor = this.indexer.status.cursor;
    if (cursor === null || cursor <= 0) return null;
    const block = await this.rpc.call<RpcBlock | null>("eth_getBlockByNumber", [numToHex(cursor), false]);
    if (!block) return null;
    const leaves = this.computeLeaves(cursor, hexToNum(block.timestamp));
    if (leaves.length === 0) return null;
    const root = rootOf(buildTree(leaves.map(leafHash)));
    this.db
      .prepare(
        "INSERT INTO attestations (day, root, leaves, snapshot_block, snapshot_ts, status, created_at) VALUES (?, ?, ?, ?, ?, 'computed', ?)",
      )
      .run(epoch, root, JSON.stringify(leaves), cursor, hexToNum(block.timestamp), nowSec());
    // Only the newest snapshot can still be anchored (the contract only accepts later epochs).
    this.db.prepare("UPDATE attestations SET status = 'superseded' WHERE day < ? AND status IN ('computed','failed')").run(epoch);
    log.info("traction snapshot computed", { epoch, projects: leaves.length, root, block: cursor });
    return epoch;
  }

  // ───────── anchoring ─────────

  private wallet() {
    const chain = defineChain({
      id: this.cfg.chainId,
      name: "QIE",
      nativeCurrency: { name: "QIE", symbol: "QIE", decimals: 18 },
      rpcUrls: { default: { http: this.cfg.rpcUrls } },
    });
    // Requests go through the RpcPool, so sending gets the same failover as reading.
    const transport = custom({ request: ({ method, params }) => this.rpc.call(method, (params as unknown[]) ?? []) });
    return createWalletClient({ account: privateKeyToAccount(this.cfg.attesterKey as Hex), chain, transport });
  }

  /** Post the newest computed snapshot, and confirm sent ones. */
  async anchor(): Promise<void> {
    if (!this.anchoring) return;
    for (const r of this.db.prepare("SELECT * FROM attestations WHERE status = 'sent'").all() as Row[]) {
      const rc = await this.rpc.call<(RpcReceipt & { blockNumber: string }) | null>("eth_getTransactionReceipt", [r.tx_hash]);
      if (!rc) {
        // Never mined (dropped from the pool): try again. The pre-send chain check below
        // marks it anchored instead if the first transaction lands after all.
        if (r.sent_at && nowSec() - r.sent_at > SENT_TIMEOUT_SEC) {
          this.db.prepare("UPDATE attestations SET status = 'failed', error = 'transaction was not mined' WHERE day = ?").run(r.day);
        }
        continue;
      }
      if (rc.status === "0x1") {
        this.db.prepare("UPDATE attestations SET status = 'anchored', block_number = ?, error = NULL WHERE day = ?").run(hexToNum(rc.blockNumber), r.day);
        log.info("traction snapshot anchored", { epoch: r.day, tx: r.tx_hash });
      } else {
        this.db.prepare("UPDATE attestations SET status = 'failed', error = 'transaction reverted' WHERE day = ?").run(r.day);
      }
    }

    const next = this.db.prepare("SELECT * FROM attestations WHERE status IN ('computed','failed') ORDER BY day DESC LIMIT 1").get() as Row | undefined;
    if (!next) return;
    const contract = this.cfg.attestationContract!;
    try {
      const w = this.wallet();
      const onchain = await this.readAttestation(next.day);
      if (onchain && onchain.root !== "0x" + "0".repeat(64)) {
        // Already posted (e.g. the database was restored from a backup).
        const same = onchain.root.toLowerCase() === next.root.toLowerCase();
        this.db.prepare("UPDATE attestations SET status = ?, error = ? WHERE day = ?").run(same ? "anchored" : "failed", same ? null : `chain has a different root ${onchain.root}`, next.day);
        return;
      }
      const hash = await w.writeContract({
        address: contract,
        abi: ATTESTATIONS_ABI,
        functionName: "attest",
        args: [next.day, next.root as Hex, (JSON.parse(next.leaves) as unknown[]).length, BigInt(next.snapshot_block)],
      });
      this.db.prepare("UPDATE attestations SET status = 'sent', tx_hash = ?, sent_at = ?, error = NULL WHERE day = ?").run(hash, nowSec(), next.day);
      log.info("traction snapshot sent", { epoch: next.day, tx: hash });
    } catch (e) {
      const msg = errMsg(e).split("\n")[0]!.slice(0, 300);
      // EpochNotAfterLatest: a later day is already on chain, so this one can never be posted.
      const status = msg.includes("EpochNotAfterLatest") ? "superseded" : "failed";
      this.db.prepare("UPDATE attestations SET status = ?, error = ? WHERE day = ?").run(status, msg, next.day);
      log.warn("traction snapshot anchoring failed", { epoch: next.day, error: msg });
    }
  }

  async readAttestation(epoch: number): Promise<{ root: string; leaves: number; snapshotBlock: number; attestedAt: number } | null> {
    if (!this.cfg.attestationContract) return null;
    const data = encodeFunctionData({ abi: ATTESTATIONS_ABI, functionName: "attestations", args: [epoch] });
    const raw = await this.rpc.call<Hex>("eth_call", [{ to: this.cfg.attestationContract, data }, "latest"]);
    const [root, leaves, snapshotBlock, attestedAt] = decodeFunctionResult({ abi: ATTESTATIONS_ABI, functionName: "attestations", data: raw });
    return { root, leaves, snapshotBlock: Number(snapshotBlock), attestedAt: Number(attestedAt) };
  }

  // ───────── reads ─────────

  list(limit = 30): PublicAttestation[] {
    return (this.db.prepare("SELECT * FROM attestations ORDER BY day DESC LIMIT ?").all(Math.min(Math.max(limit, 1), 365)) as Row[]).map(toPublic);
  }

  /** The latest snapshot that includes `slug` (anchored ones first), with its Merkle proof. */
  proof(slug: string, epoch?: number) {
    const rows = (
      epoch !== undefined
        ? this.db.prepare("SELECT * FROM attestations WHERE day = ?").all(epoch)
        : this.db.prepare("SELECT * FROM attestations ORDER BY (status = 'anchored') DESC, day DESC LIMIT 7").all()
    ) as Row[];
    for (const r of rows) {
      const leaves = JSON.parse(r.leaves) as LeafData[];
      const i = leaves.findIndex((l) => l.slug === slug);
      if (i < 0) continue;
      const layers = buildTree(leaves.map(leafHash));
      return {
        attestation: toPublic(r),
        contract: this.cfg.attestationContract,
        chainId: this.cfg.chainId,
        leaf: leaves[i]!,
        leafHash: layers[0]![i]!,
        proof: proofFor(layers, i),
      };
    }
    return null;
  }

  // ───────── loop ─────────

  async runOnce(now = nowSec()): Promise<void> {
    await this.snapshot(now);
    await this.anchor();
  }

  async run(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.runOnce();
      } catch (e) {
        log.warn("attestation run failed", { error: errMsg(e) });
      }
      await new Promise<void>((r) => {
        this.wake = r;
        this.timer = setTimeout(r, this.cfg.attestIntervalMs);
      });
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.wake?.();
  }
}
