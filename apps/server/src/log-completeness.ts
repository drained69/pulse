import { keccak256, type Hex } from "viem";
import { hexToNum, type RpcLog } from "./chain.ts";

/** Reconstruct the Ethereum 2048-bit OR bloom of the returned log addresses/topics. */
export function logsBloomFor(logs: Pick<RpcLog, "address" | "topics">[]): Hex {
  const bytes = new Uint8Array(256);
  for (const log of logs) {
    for (const value of [log.address, ...log.topics]) {
      const hash = keccak256(value).slice(2);
      for (let offset = 0; offset < 12; offset += 4) {
        const bit = Number.parseInt(hash.slice(offset, offset + 4), 16) & 2047;
        bytes[255 - (bit >> 3)]! |= 1 << (bit & 7);
      }
    }
  }
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Reject internally inconsistent RPC answers before advancing a cursor. A bloom is an OR
 * filter, not a cryptographic completeness proof: logs with identical address/topics or
 * colliding bloom bits can still be omitted by an untrusted node without changing it.
 */
export function isCompleteBlockLogs(block: { number: string; hash: string; logsBloom?: string }, logs: RpcLog[]): boolean {
  try {
    const number = hexToNum(block.number);
    if (!Number.isSafeInteger(number) || number < 0 || typeof block.hash !== "string") return false;
    const seen = new Set<string>();
    for (const log of logs) {
      if (hexToNum(log.blockNumber) !== number || log.removed || (typeof log.blockHash !== "string" || log.blockHash.toLowerCase() !== block.hash.toLowerCase())) return false;
      const key = `${log.transactionHash.toLowerCase()}:${hexToNum(log.logIndex)}`;
      if (seen.has(key)) return false;
      seen.add(key);
    }
    // A missing mandatory bloom must not turn the consistency check off.
    if (typeof block.logsBloom !== "string" || !/^0x[0-9a-f]{512}$/i.test(block.logsBloom)) return false;
    return logsBloomFor(logs).toLowerCase() === block.logsBloom.toLowerCase();
  } catch {
    return false;
  }
}
