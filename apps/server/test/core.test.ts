import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeAbiParameters, encodeEventTopics, getAddress, pad, parseAbiItem, toEventSelector } from "viem";
import { NATIVE_TOKEN, QIE_MAINNET, SWAP_EVENT, TRANSFER_EVENT, type RpcLog, type TokenInfo } from "../src/chain.ts";
import { signatureHeader, verify } from "../src/signing.ts";
import { assertPublicUrl, isBlockedIp, postWebhook, safeLookup } from "../src/ssrf.ts";
import { HookIndex, matchLog, matchNativeTx, parseEventSignature, type HookRow } from "../src/triggers.ts";
import { normalizeQieName } from "../src/names.ts";
import { describe as describeEvent, testPayload } from "../src/payload.ts";

const SHOP = "0x172083F7f31f82e4B57bA8aCf9822C72BB35b174";
const ALICE = "0x1111111111111111111111111111111111111111";
const PAIR = "0x73a3ccf7da7e473ed2e9994ae764f0e30f4e4dfe";

function hook(id: string, type: HookRow["trigger_type"], config: object, resolved: object = {}): HookRow {
  return {
    id,
    user_id: "usr_1",
    name: id,
    trigger_type: type,
    trigger_config: JSON.stringify(config),
    resolved: JSON.stringify(resolved),
    channel_type: "webhook",
    channel_config: '{"url":"https://example.com"}',
    secret: "s",
    active: 1,
  };
}

function transferLog(token: string, from: string, to: string, value: bigint, logIndex = 0): RpcLog {
  const topics = encodeEventTopics({ abi: [TRANSFER_EVENT], args: { from: from as `0x${string}`, to: to as `0x${string}` } }) as `0x${string}`[];
  return {
    address: token.toLowerCase() as `0x${string}`,
    topics,
    data: encodeAbiParameters([{ type: "uint256" }], [value]),
    blockNumber: "0x10",
    transactionHash: `0x${"ab".repeat(32)}`,
    transactionIndex: "0x0",
    logIndex: `0x${logIndex.toString(16)}`,
    blockHash: `0x${"cd".repeat(32)}`,
  };
}

const QUSDC_INFO: TokenInfo = { address: QIE_MAINNET.QUSDC, symbol: "QUSDC", decimals: 6, official: true };
const WQIE_INFO: TokenInfo = { address: QIE_MAINNET.WQIE, symbol: "WQIE", decimals: 18, official: true };
const tokenOf = async (a: string): Promise<TokenInfo> =>
  a.toLowerCase() === QIE_MAINNET.QUSDC.toLowerCase() ? QUSDC_INFO : a.toLowerCase() === QIE_MAINNET.WQIE.toLowerCase() ? WQIE_INFO : { address: getAddress(a), symbol: "FAKE", decimals: 18 };
const pairOf = async () => ({ token0: WQIE_INFO, token1: QUSDC_INFO, priceUsd0: 0.15, priceUsd1: 1 });

describe("signing", () => {
  it("round-trips and rejects tampering and stale timestamps", () => {
    const ts = 1_800_000_000;
    const body = '{"hello":"qie"}';
    const h = signatureHeader("whsec_test", ts, body);
    assert.ok(verify("whsec_test", h, ts, body, 300, ts + 10));
    assert.ok(!verify("whsec_test", h, ts, body.replace("qie", "eth"), 300, ts));
    assert.ok(!verify("whsec_other", h, ts, body, 300, ts));
    assert.ok(!verify("whsec_test", h, ts, body, 300, ts + 301));
    assert.ok(verify("whsec_test", `v0=abc, ${h}`, ts, body, 300, ts), "accepts one valid among several");
  });
});

describe("names", () => {
  it("normalizes QIE IDs", () => {
    assert.equal(normalizeQieName("Shop"), "shop.qie");
    assert.equal(normalizeQieName(" shop.QIE "), "shop.qie");
    assert.equal(normalizeQieName("bad name.qie"), null);
    assert.equal(normalizeQieName(""), null);
  });
});

describe("ssrf guard", () => {
  it("blocks private and reserved targets", async () => {
    for (const u of ["http://127.0.0.1/x", "http://10.1.2.3/", "http://169.254.169.254/latest", "http://[::1]/", "http://localhost:8080", "ftp://example.com", "http://user:pw@example.com"]) {
      await assert.rejects(assertPublicUrl(u, false), Error, u);
    }
  });
  it("blocks IPv6 forms that tunnel to private IPv4", () => {
    for (const ip of ["::1", "::", "::127.0.0.1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::a00:1", "2002:a00:1::1", "fd00::1", "fdaa:0:1::3", "fe80::1"]) {
      assert.ok(isBlockedIp(ip), ip);
    }
    for (const ip of ["8.8.8.8", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) assert.ok(!isBlockedIp(ip), ip);
  });
  it("re-checks DNS at connect time (DNS rebinding)", async () => {
    // A hostname that resolves to loopback is refused by the connection-time lookup too.
    const err = await new Promise<NodeJS.ErrnoException | null>((r) => safeLookup("localhost", { all: true }, (e) => r(e)));
    assert.equal(err?.code, "EBLOCKED");
    await assert.rejects(postWebhook("http://localhost:9/x", {}, "{}", 2000, false), /private or reserved/);
  });
  it("allows private targets only when explicitly enabled", async () => {
    await assertPublicUrl("http://127.0.0.1:9999/hook", true);
  });
});

describe("payment hooks", () => {
  const idx = HookIndex.build([
    hook("hk_pay", "payment", { recipient: "shop.qie", assets: ["QIE", "QUSDC"] }, { recipient: SHOP }),
    hook("hk_min", "payment", { recipient: SHOP, assets: ["QUSDC"], minAmount: "10" }),
    hook("hk_any", "payment", { recipient: SHOP, assets: ["QUSDC"], anyToken: true }),
  ]);

  it("matches QUSDC sent to a resolved .qie name", async () => {
    const m = await matchLog(transferLog(QIE_MAINNET.QUSDC, ALICE, SHOP, 25_000_000n), idx, tokenOf, pairOf);
    assert.deepEqual(m.map((x) => x.hook.id).sort(), ["hk_any", "hk_min", "hk_pay"]);
    assert.equal(m[0]!.type, "payment.received");
    assert.equal(m[0]!.data.amount, 25_000_000n);
  });

  it("applies minAmount in token units", async () => {
    const m = await matchLog(transferLog(QIE_MAINNET.QUSDC, ALICE, SHOP, 9_999_999n), idx, tokenOf, pairOf);
    assert.ok(!m.some((x) => x.hook.id === "hk_min"));
  });

  it("ignores lookalike tokens unless anyToken is set", async () => {
    const fake = "0x883E3098eF144f91818037936a722b8bd448074b";
    const m = await matchLog(transferLog(fake, ALICE, SHOP, 10n ** 18n), idx, tokenOf, pairOf);
    assert.deepEqual(m.map((x) => x.hook.id), ["hk_any"]);
  });

  it("matches native QIE transfers", () => {
    const m = matchNativeTx(
      { hash: `0x${"11".repeat(32)}`, from: ALICE, to: SHOP.toLowerCase() as `0x${string}`, value: "0xde0b6b3a7640000", input: "0x", transactionIndex: "0x0", blockNumber: "0x5" },
      idx,
    );
    assert.equal(m.length, 1);
    assert.equal(m[0]!.hook.id, "hk_pay");
    assert.deepEqual(m[0]!.data.token, NATIVE_TOKEN);
    assert.equal(m[0]!.dedupeKey.endsWith(":native"), true);
  });

  it("asks for native blocks only when needed", () => {
    assert.equal(idx.needsNativeTxs(), true);
    assert.equal(HookIndex.build([hook("a", "payment", { recipient: SHOP, assets: ["QUSDC"] })]).needsNativeTxs(), false);
  });

  it("ignores ERC-721 transfers (4 topics)", async () => {
    const l = transferLog(QIE_MAINNET.QUSDC, ALICE, SHOP, 1n);
    l.topics.push(pad("0x01"));
    assert.equal((await matchLog(l, idx, tokenOf, pairOf)).length, 0);
  });

  it("skips hooks whose name never resolved", () => {
    const i = HookIndex.build([hook("hk_bad", "payment", { recipient: "nobody.qie" })]);
    assert.equal(i.size, 0);
    assert.equal(i.errors[0]?.hookId, "hk_bad");
  });
});

describe("token transfer hooks", () => {
  it("filters by from, to and minimum", async () => {
    const idx = HookIndex.build([
      hook("hk_whale", "token_transfer", { token: "QUSDC", minAmount: "1000" }),
      hook("hk_from", "token_transfer", { token: "QUSDC", from: ALICE }),
    ]);
    const small = await matchLog(transferLog(QIE_MAINNET.QUSDC, ALICE, SHOP, 5_000_000n), idx, tokenOf, pairOf);
    assert.deepEqual(small.map((m) => m.hook.id), ["hk_from"]);
    const big = await matchLog(transferLog(QIE_MAINNET.QUSDC, SHOP, ALICE, 2_000_000_000n), idx, tokenOf, pairOf);
    assert.deepEqual(big.map((m) => m.hook.id), ["hk_whale"]);
  });
});

describe("swap hooks", () => {
  it("decodes direction and USD value, and applies minValueUsd", async () => {
    const idx = HookIndex.build([hook("hk_swap", "swap", { pair: PAIR }), hook("hk_big", "swap", { pair: PAIR, minValueUsd: 500 })]);
    const topics = encodeEventTopics({ abi: [SWAP_EVENT], args: { sender: QIE_MAINNET.QIEDEX_ROUTER, to: ALICE } }) as `0x${string}`[];
    const log: RpcLog = {
      ...transferLog(PAIR, ALICE, SHOP, 0n),
      topics,
      data: encodeAbiParameters(
        [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
        [0n, 15_000_000n, 99n * 10n ** 18n, 0n], // 15 QUSDC in, 99 WQIE out
      ),
    };
    const m = await matchLog(log, idx, tokenOf, pairOf);
    assert.deepEqual(m.map((x) => x.hook.id), ["hk_swap"]);
    assert.equal((m[0]!.data.tokenIn as TokenInfo).symbol, "QUSDC");
    assert.equal((m[0]!.data.tokenOut as TokenInfo).symbol, "WQIE");
    assert.equal(m[0]!.data.valueUsd, 15);
  });
});

describe("contract event hooks", () => {
  it("decodes any event and applies arg filters", async () => {
    const sig = "event Deposit(address indexed user, uint256 amount, string memo)";
    const ev = parseEventSignature(sig);
    const contract = "0x2222222222222222222222222222222222222222";
    const idx = HookIndex.build([
      hook("hk_dep", "contract_event", { address: contract, event: sig }),
      hook("hk_alice", "contract_event", { event: "Deposit(address indexed user, uint256 amount, string memo)", filters: { user: ALICE } }),
    ]);
    const mk = (user: string) => ({
      ...transferLog(contract, ALICE, SHOP, 0n),
      topics: encodeEventTopics({ abi: [ev], args: { user } } as never) as `0x${string}`[],
      data: encodeAbiParameters([{ type: "uint256" }, { type: "string" }], [42n, "order #7"]),
    });
    const a = await matchLog(mk(ALICE), idx, tokenOf, pairOf);
    assert.deepEqual(a.map((x) => x.hook.id).sort(), ["hk_alice", "hk_dep"]);
    assert.deepEqual((a[0]!.data.args as Record<string, unknown>).amount, "42");
    const b = await matchLog(mk(SHOP), idx, tokenOf, pairOf);
    assert.deepEqual(b.map((x) => x.hook.id), ["hk_dep"]);
    assert.ok(idx.topics().includes(toEventSelector(parseAbiItem(sig) as never)));
  });
});

describe("messages", () => {
  it("renders a readable test message", () => {
    const d = describeEvent(testPayload({ id: "hk_1", name: "Shop payments" }, { chainId: 1990, network: "mainnet", explorerUrl: "https://mainnet.qie.digital" }));
    assert.match(d.title, /Shop payments/);
    assert.match(d.lines[0]!, /shop\.qie received 25 QUSDC/);
  });
});

describe("wallet watch hooks", () => {
  const W = "0x3333333333333333333333333333333333333333";
  const idx = HookIndex.build([
    hook("hk_w", "wallet", { address: W }),
    hook("hk_in", "wallet", { address: W, direction: "in", includeFailed: false }),
  ]);
  const tx = (from: string, to: string | null, value: string, input = "0x") =>
    ({ hash: `0x${"77".repeat(32)}`, from, to, value, input, transactionIndex: "0x0", blockNumber: "0x9" }) as never;

  it("reports token transfers in and out of the wallet", async () => {
    const inn = await matchLog(transferLog(QIE_MAINNET.QUSDC, ALICE, W, 7_000_000n), idx, tokenOf, pairOf);
    assert.deepEqual(inn.map((m) => `${m.hook.id}:${m.data.direction}`).sort(), ["hk_in:in", "hk_w:in"]);
    const out = await matchLog(transferLog(QIE_MAINNET.QUSDC, W, ALICE, 7_000_000n), idx, tokenOf, pairOf);
    assert.deepEqual(out.map((m) => `${m.hook.id}:${m.data.direction}`), ["hk_w:out"]);
    assert.equal(out[0]!.type, "wallet.activity");
  });

  it("reports native transfers, contract calls and failed transactions", async () => {
    const { matchWalletTx } = await import("../src/triggers.ts");
    const sent = matchWalletTx(tx(W, ALICE, "0x1"), "success", idx);
    assert.deepEqual(sent.map((m) => [m.hook.id, m.data.kind, m.data.direction]), [["hk_w", "native_transfer", "out"]]);
    const call = matchWalletTx(tx(ALICE, W, "0x0", "0xa9059cbb0000"), "failed", idx);
    assert.deepEqual(call.map((m) => [m.hook.id, m.data.kind, m.data.status]), [["hk_w", "contract_call", "failed"]], "hk_in excludes failed txs");
    assert.equal(call[0]!.data.method, "0xa9059cbb");
    assert.equal(idx.needsNativeTxs(), true);
  });
});

describe("multi-event contract hooks", () => {
  it("matches any listed event and ignores filters an event does not have", async () => {
    const SAFE = "0x4444444444444444444444444444444444444444";
    const idx = HookIndex.build([
      hook("hk_safe", "contract_event", {
        address: SAFE,
        events: ["event AddedOwner(address indexed owner)", "event ChangedThreshold(uint256 threshold)"],
        filters: { owner: ALICE },
      }),
    ]);
    const owner = parseEventSignature("event AddedOwner(address indexed owner)");
    const thr = parseEventSignature("event ChangedThreshold(uint256 threshold)");
    const base = transferLog(SAFE, ALICE, SHOP, 0n);
    const a = await matchLog({ ...base, topics: encodeEventTopics({ abi: [owner], args: { owner: ALICE } } as never) as `0x${string}`[], data: "0x" }, idx, tokenOf, pairOf);
    const b = await matchLog({ ...base, topics: encodeEventTopics({ abi: [owner], args: { owner: SHOP } } as never) as `0x${string}`[], data: "0x" }, idx, tokenOf, pairOf);
    const c = await matchLog({ ...base, topics: encodeEventTopics({ abi: [thr] } as never) as `0x${string}`[], data: encodeAbiParameters([{ type: "uint256" }], [2n]) }, idx, tokenOf, pairOf);
    assert.equal(a.length, 1);
    assert.equal(b.length, 0, "owner filter applies to AddedOwner");
    assert.equal(c.length, 1, "owner filter does not block ChangedThreshold");
    assert.equal(c[0]!.data.event, "ChangedThreshold");
  });
});
