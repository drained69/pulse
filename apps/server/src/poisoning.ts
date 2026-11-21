import { getAddress } from "viem";

/**
 * Address poisoning: a scammer creates an address that starts and ends like one you use (wallets
 * often show only `0x1234…abcd`) and sends you a zero-value or dust transfer from it, so it appears
 * in your history. Next time you copy "your" address from the history, you pay the scammer.
 *
 * Q-Pulse flags a counterparty whose first 4 and last 4 hex characters match an address this hook
 * has already seen but which is a different address, and token transfers worth exactly zero.
 */

export type SecuritySignal = {
  /** The real address this counterparty imitates. */
  lookalikeOf?: string;
  /** A token transfer of 0: only ever used to plant an address in someone's history. */
  zeroValue?: boolean;
};

export function looksAlike(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x !== y && x.length === 42 && y.length === 42 && x.slice(2, 6) === y.slice(2, 6) && x.slice(-4) === y.slice(-4);
}

/**
 * @param counterparty the other side of the transfer (not the watched wallet)
 * @param tokenAmount  raw amount when this is a token transfer, else null (zero is normal for contract calls)
 * @param known        addresses this hook has dealt with before
 */
export function poisoningSignal(counterparty: string | null | undefined, tokenAmount: bigint | null, known: Iterable<string>): SecuritySignal | null {
  if (!counterparty) return null;
  const out: SecuritySignal = {};
  for (const k of known) {
    if (looksAlike(counterparty, k)) {
      out.lookalikeOf = getAddress(k);
      break;
    }
  }
  if (tokenAmount === 0n) out.zeroValue = true;
  return out.lookalikeOf || out.zeroValue ? out : null;
}
