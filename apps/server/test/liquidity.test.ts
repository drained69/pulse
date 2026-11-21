import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { depthOf, isqrt, PEAK_WINDOW_SEC, stepLiquidity } from "../src/liquidity.ts";
import { describe as describeEvent, type EventPayload } from "../src/payload.ts";
import { HookIndex, triggerSchemas, type HookRow } from "../src/triggers.ts";
import { TOPIC } from "../src/chain.ts";

describe("rug-pull radar", () => {
  it("measures depth as the integer square root of the reserves' product", () => {
    assert.equal(isqrt(0n), 0n);
    assert.equal(isqrt(99n), 9n);
    assert.equal(isqrt(10n ** 36n), 10n ** 18n);
    assert.equal(depthOf(4n, 9n), 6n);
  });

  it("fires once when depth falls the chosen share below its peak, then re-arms after recovery", () => {
    const t0 = 1_800_000_000;
    let s = stepLiquidity(null, 1000n, 30, t0);
    assert.equal(s.fire, null, "the first reading only sets the peak");
    s = stepLiquidity(s.state, 1200n, 30, t0 + 60); // liquidity added: new peak
    assert.equal(s.state.peak, "1200");
    s = stepLiquidity(s.state, 1000n, 30, t0 + 120); // -16.7%: under the threshold
    assert.equal(s.fire, null);
    s = stepLiquidity(s.state, 600n, 30, t0 + 180); // -50%: fire
    assert.equal(s.fire, 50);
    s = stepLiquidity(s.state, 500n, 30, t0 + 240); // still down: don't page again
    assert.equal(s.fire, null);
    s = stepLiquidity(s.state, 1150n, 30, t0 + 300); // back within 15%: re-arm
    assert.equal(s.state.armed, true);
    s = stepLiquidity(s.state, 700n, 30, t0 + 360);
    assert.ok(s.fire !== null && s.fire > 30, "fires again after re-arming");
  });

  it("forgets a peak older than 24 hours", () => {
    const t0 = 1_800_000_000;
    const old = stepLiquidity(null, 1000n, 30, t0).state;
    const s = stepLiquidity(old, 300n, 30, t0 + PEAK_WINDOW_SEC + 1);
    assert.equal(s.fire, null, "a slow decline over days is not a rug pull");
    assert.equal(s.state.peak, "300");
  });

  it("indexes Sync events of watched pairs and validates the config", () => {
    const pair = "0x73a3ccf7da7e473ed2e9994ae764f0e30f4e4dfe";
    assert.equal(triggerSchemas.liquidity.parse({ pair }).dropPercent, 30);
    assert.throws(() => triggerSchemas.liquidity.parse({ pair, dropPercent: 2 }));
    const hook = { id: "hk_l", user_id: "u", name: "Radar", trigger_type: "liquidity", trigger_config: JSON.stringify({ pair, dropPercent: 40 }), resolved: "{}", channel_type: "webhook", channel_config: "{}", secret: "s", active: 1 } as HookRow;
    const idx = HookIndex.build([hook]);
    assert.equal(idx.liquidityByPair.get(pair)?.[0]?.dropPercent, 40);
    assert.ok(idx.topics().includes(TOPIC.SYNC));
  });

  it("describes the alert", () => {
    const p = {
      id: "evt_1",
      type: "liquidity.drop",
      createdAt: "",
      hook: { id: "hk", name: "Radar" },
      chain: { id: 1990, network: "mainnet" },
      tx: null,
      data: { pair: "0x73a3ccf7da7e473ed2e9994ae764f0e30f4e4dfe", token0: { symbol: "WQIE" }, token1: { symbol: "QUSDC" }, dropPercent: 62.5, reserves: [{ display: "1,000 WQIE", raw: "1" }, { display: "160 QUSDC", raw: "1" }], liquidityUsd: 320 },
    } as unknown as EventPayload;
    const d = describeEvent(p);
    assert.equal(d.title, "Liquidity down 62.5% on WQIE/QUSDC (QIEDEX)");
    assert.match(d.lines[0]!, /1,000 WQIE \+ 160 QUSDC \(~\$320\)/);
  });
});
