import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeAbiParameters, encodeEventTopics, getAddress } from "viem";
import { QIE_MAINNET, TRANSFER_EVENT, type RpcLog, type TokenInfo } from "../src/chain.ts";
import { describe as describeEvent, type EventPayload } from "../src/payload.ts";
import { looksAlike, poisoningSignal } from "../src/poisoning.ts";
import { HookIndex, matchLog, type HookRow } from "../src/triggers.ts";

const REAL = "0x1234567890abcdef1234567890abcdef1234abcd"; // an exchange deposit address the user pays often
const FAKE = "0x1234ffffffffffffffffffffffffffffffffabcd"; // same first and last 4 characters
const OTHER = "0x9999999999999999999999999999999999999999";
const SHOP = "0x172083F7f31f82e4B57bA8aCf9822C72BB35b174";

describe("address-poisoning guard", () => {
  it("spots an address that only looks like a known one", () => {
    assert.ok(looksAlike(FAKE, REAL));
    assert.ok(!looksAlike(REAL, REAL), "the same address is not a lookalike");
    assert.ok(!looksAlike(OTHER, REAL));
    assert.deepEqual(poisoningSignal(FAKE, null, [REAL]), { lookalikeOf: getAddress(REAL) });
    assert.equal(poisoningSignal(REAL, 5n, [REAL]), null);
    assert.deepEqual(poisoningSignal(OTHER, 0n, [REAL]), { zeroValue: true }, "a zero-value token transfer is flagged on its own");
    assert.equal(poisoningSignal(OTHER, null, [REAL]), null, "zero is normal for contract calls");
  });

  it("warns in the alert text", () => {
    const p = {
      id: "evt_1",
      type: "wallet.activity",
      createdAt: new Date().toISOString(),
      hook: { id: "hk_1", name: "My wallet" },
      chain: { id: 1990, network: "mainnet" },
      tx: null,
      data: {
        kind: "token_transfer",
        direction: "in",
        status: "success",
        wallet: { address: SHOP, name: null },
        from: { address: FAKE, name: null },
        to: { address: SHOP, name: null },
        token: { address: QIE_MAINNET.QUSDC, symbol: "QUSDC", decimals: 6, official: true },
        amount: { raw: "0", formatted: "0", display: "0 QUSDC", symbol: "QUSDC", valueUsd: 0 },
        security: { lookalikeOf: REAL, zeroValue: true },
      },
    } as unknown as EventPayload;
    const d = describeEvent(p);
    assert.equal(d.emoji, "🚨");
    assert.ok(d.lines.some((l) => /address poisoning/.test(l)));
    assert.ok(d.lines.some((l) => /Zero-value transfer/.test(l)));
  });

  it("never reports a zero-value transfer as a payment", async () => {
    const hook: HookRow = {
      id: "hk_pay",
      user_id: "usr_1",
      name: "Shop",
      trigger_type: "payment",
      trigger_config: JSON.stringify({ recipient: SHOP, assets: ["QUSDC"] }),
      resolved: "{}",
      channel_type: "webhook",
      channel_config: '{"url":"https://example.com"}',
      secret: "s",
      active: 1,
    };
    const idx = HookIndex.build([hook]);
    const log = (value: bigint): RpcLog => ({
      address: QIE_MAINNET.QUSDC.toLowerCase() as `0x${string}`,
      topics: encodeEventTopics({ abi: [TRANSFER_EVENT], args: { from: FAKE, to: SHOP } }) as `0x${string}`[],
      data: encodeAbiParameters([{ type: "uint256" }], [value]),
      blockNumber: "0x10",
      transactionHash: `0x${"ab".repeat(32)}`,
      transactionIndex: "0x0",
      logIndex: "0x0",
      blockHash: `0x${"cd".repeat(32)}`,
    });
    const qusdc: TokenInfo = { address: QIE_MAINNET.QUSDC, symbol: "QUSDC", decimals: 6, official: true };
    const tokenOf = async () => qusdc;
    const pairOf = async () => ({ token0: qusdc, token1: qusdc, priceUsd0: 1, priceUsd1: 1 });
    assert.equal((await matchLog(log(0n), idx, tokenOf, pairOf)).length, 0);
    assert.equal((await matchLog(log(1_000_000n), idx, tokenOf, pairOf)).length, 1);
  });
});
