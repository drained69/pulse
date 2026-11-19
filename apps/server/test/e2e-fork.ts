/**
 * End-to-end test on a local fork of QIE mainnet (anvil).
 *
 * Real QIE state, real QUSDC/WQIE/QIEDEX contracts, real QIE ID names (via the
 * QIE Wallet MCP). We deploy the billing contract to the fork, run the full
 * server (indexer + delivery worker) against the fork, make transactions and
 * check that every hook delivers a correctly signed, correctly decoded webhook.
 *
 * Run: pnpm e2e   (needs anvil + forge from Foundry, and internet for the fork)
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createTestClient, createWalletClient, encodeFunctionData, getAddress, http, parseAbi, parseEther, publicActions, walletActions } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { QIE_MAINNET } from "../src/chain.ts";
import { loadConfig } from "../src/config.ts";
import { buildApp, buildServices } from "../src/main.ts";
import { verify } from "../src/signing.ts";

const FORK_URL = process.env.FORK_URL ?? "https://rpc1mainnet.qie.digital";
const PORT = 8645;
const RPC = `http://127.0.0.1:${PORT}`;
// Anvil's public default account #0 deploys; the user is a fresh random key. Local fork only, never real funds.
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const USER_KEY = generatePrivateKey();
const QUSDC_WHALE = "0x3EcD3b3fa22Cc251301BA78F4Ba014f78B6FE542";
const WQIE_QUSDC_PAIR = "0x73a3ccf7da7e473ed2e9994ae764f0e30f4e4dfe";
const NAME = "qie.qie";
const REPO = new URL("../../..", import.meta.url).pathname;

const ERC20 = parseAbi([
  "function transfer(address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);
const ROUTER = parseAbi(["function swapExactTokensForTokens(uint256,uint256,address[],address,uint256) returns (uint256[])"]);
const BILLING = parseAbi(["function subscribe(uint8,uint32,uint256) returns (uint64)", "function paidUntil(address) view returns (uint64)"]);

const step = (msg: string) => console.log(`\n▶ ${msg}`);
const ok = (msg: string) => console.log(`  ✔ ${msg}`);

async function waitFor<T>(label: string, fn: () => T | undefined | Promise<T | undefined>, timeoutMs = 60_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 400));
  }
}

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), "qiepulse-e2e-"));
  step(`Forking QIE mainnet from ${FORK_URL}`);
  const anvil = spawn("anvil", ["--fork-url", FORK_URL, "--port", String(PORT), "--silent", "--no-rate-limit"], { stdio: "inherit" });
  const cleanup = () => {
    anvil.kill("SIGTERM");
    rmSync(tmp, { recursive: true, force: true });
  };
  process.on("exit", cleanup);

  const test = createTestClient({ mode: "anvil", transport: http(RPC, { timeout: 60_000 }) }).extend(publicActions).extend(walletActions);
  await waitFor("anvil", async () => (await test.getChainId().catch(() => 0)) || undefined, 120_000);
  const chainId = await test.getChainId();
  const chain = { id: chainId, name: "QIE fork", nativeCurrency: { name: "QIE", symbol: "QIE", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
  const pub = createPublicClient({ chain, transport: http(RPC) });
  ok(`fork up, chain ${chainId}, block ${await pub.getBlockNumber()}`);

  step("Deploying QiePulseBilling to the fork");
  const treasury = "0x000000000000000000000000000000000000bEEF";
  const out = execFileSync(
    "forge",
    ["create", "src/QiePulseBilling.sol:QiePulseBilling", "--rpc-url", RPC, "--private-key", DEPLOYER_KEY, "--broadcast", "--constructor-args", QIE_MAINNET.QUSDC, treasury, "9000000", "2592000"],
    { cwd: join(REPO, "contracts"), encoding: "utf8" },
  );
  const billing = getAddress(out.match(/Deployed to: (0x[0-9a-fA-F]{40})/)![1]!);
  ok(`billing at ${billing}`);

  step("Starting a webhook receiver");
  type Hit = { headers: IncomingMessage["headers"]; body: string; json: any };
  const hits: Hit[] = [];
  const sink = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ headers: req.headers, body, json: JSON.parse(body) });
      res.writeHead(200).end("ok");
    });
  });
  await new Promise<void>((r) => sink.listen(0, "127.0.0.1", r));
  const sinkUrl = `http://127.0.0.1:${(sink.address() as AddressInfo).port}/hook`;

  step("Starting QIE Pulse against the fork");
  const startBlock = Number(await pub.getBlockNumber()) + 1;
  const cfg = loadConfig({
    ...process.env,
    // The first endpoint is dead on purpose: everything must fail over to the fork.
    RPC_URLS: `http://127.0.0.1:1,${RPC}`,
    CHAIN_ID: String(chainId),
    DB_PATH: join(tmp, "e2e.db"),
    PUBLIC_URL: "http://localhost:8799",
    ALLOW_PRIVATE_WEBHOOKS: "true",
    CONFIRMATIONS: "0",
    POLL_INTERVAL_MS: "300",
    CHECK_INTERVAL_MS: "1000",
    FREE_MAX_HOOKS: "20",
    START_BLOCK: String(startBlock),
    BILLING_CONTRACT: billing,
    TELEGRAM_BOT_TOKEN: "",
    // The fork's contracts aren't on the real explorer: history import fails, live counting must still work.
    EXPLORER_API_URL: "http://127.0.0.1:1",
  } as NodeJS.ProcessEnv);
  const s = buildServices(cfg);
  const app = buildApp(s);
  void s.indexer.run();
  void s.delivery.run();
  void s.checks.run();

  const user = privateKeyToAccount(USER_KEY);
  let cookie = "";
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`/api${path}`, {
      method,
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json()) as any;
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
    return { json, res };
  };

  const n = (await call("POST", "/auth/nonce", { address: user.address })).json;
  const v = await call("POST", "/auth/verify", { address: user.address, signature: await user.signMessage({ message: n.message }), nonce: n.nonce });
  cookie = v.res.headers.get("set-cookie")!.split(";")[0]!;
  ok(`signed in as ${user.address}`);

  step(`Creating hooks (recipient ${NAME} resolved through QIE ID)`);
  const mk = async (name: string, trigger: unknown) =>
    (await call("POST", "/hooks", { name, trigger, channel: { type: "webhook", config: { url: sinkUrl } } })).json.hook as { id: string; secret: string; trigger: any };
  const payHook = await mk("Payments to qie.qie", { type: "payment", config: { recipient: NAME, assets: ["QIE", "QUSDC"], minAmount: "1" } });
  const recipient = payHook.trigger.resolved.recipient as `0x${string}`;
  ok(`${NAME} → ${recipient}`);
  const whaleHook = await mk("QUSDC ≥ 100", { type: "token_transfer", config: { token: "QUSDC", minAmount: "100" } });
  const swapHook = await mk("WQIE/QUSDC swaps", { type: "swap", config: { pair: WQIE_QUSDC_PAIR } });
  const subHook = await mk("Billing events", {
    type: "contract_event",
    config: { address: billing, event: "event Subscribed(address indexed account, uint8 indexed planId, uint32 periods, uint256 amount, uint64 paidUntil)" },
  });
  const walletHook = await mk("User wallet", { type: "wallet", config: { address: user.address } });
  const approvalHook = await mk("User approvals", {
    type: "contract_event",
    config: { events: ["event Approval(address indexed owner, address indexed spender, uint256 value)"], filters: { owner: user.address } },
  });
  const balanceHook = await mk("User QUSDC > 100", { type: "balance", config: { address: user.address, asset: "QUSDC", above: "100" } });
  const priceHook = await mk("WQIE above $0.000001", { type: "price", config: { token: "WQIE", above: 0.000001 } });
  const invoiceHook = await mk("Payment links paid", { type: "invoice", config: {} });
  const secrets = new Map([payHook, whaleHook, swapHook, subHook, walletHook, approvalHook, balanceHook, priceHook, invoiceHook].map((h) => [h.id, h.secret]));

  step("Payment links and a traction page");
  const inv25 = (await call("POST", "/invoices", { amount: "25", recipient: NAME, description: "E2E order", metadata: { orderId: "e2e-1" } })).json.invoice;
  const invQie = (await call("POST", "/invoices", { amount: "1.5", token: "QIE", recipient: NAME })).json.invoice;
  const invOpen = (await call("POST", "/invoices", { amount: "25", recipient: NAME })).json.invoice;
  assert.equal(inv25.amount.formatted, "25");
  assert.equal(invOpen.amount.formatted, "25.000001", "second open link for the same amount gets a unique amount");
  ok(`payment links: ${inv25.amount.display}, ${invQie.amount.display}, ${invOpen.amount.display} to ${NAME}`);
  const project = (await call("POST", "/my/projects", { name: "E2E Billing", contracts: [billing] })).json.project;
  ok(`traction page /p/${project.slug} for the billing contract`);
  await new Promise((r) => setTimeout(r, 2500)); // let the balance check see 0 QUSDC first

  step("Sending transactions on the fork");
  await test.setBalance({ address: QUSDC_WHALE, value: parseEther("100") });
  await test.setBalance({ address: user.address, value: parseEther("100") });
  await test.impersonateAccount({ address: QUSDC_WHALE });

  const t1 = await test.writeContract({ account: QUSDC_WHALE, chain, address: QIE_MAINNET.QUSDC, abi: ERC20, functionName: "transfer", args: [recipient, 25_000_000n] });
  ok(`25 QUSDC → ${NAME}  ${t1}`);
  const t2 = await test.writeContract({ account: QUSDC_WHALE, chain, address: QIE_MAINNET.QUSDC, abi: ERC20, functionName: "transfer", args: [user.address, 150_000_000n] });
  ok(`150 QUSDC → user (whale alert)  ${t2}`);
  const t3 = await test.writeContract({ account: QUSDC_WHALE, chain, address: QIE_MAINNET.QUSDC, abi: ERC20, functionName: "transfer", args: [recipient, 500_000n] });
  ok(`0.5 QUSDC → ${NAME} (below minAmount, must NOT fire)  ${t3}`);

  const wallet = createWalletClient({ account: user, chain, transport: http(RPC) });
  const t4 = await wallet.sendTransaction({ to: recipient, value: parseEther("1.5") });
  ok(`1.5 QIE (native) → ${NAME}  ${t4}`);

  await wallet.writeContract({ address: QIE_MAINNET.QUSDC, abi: ERC20, functionName: "approve", args: [QIE_MAINNET.QIEDEX_ROUTER as `0x${string}`, 10_000_000n] });
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const t5 = await wallet.writeContract({
    address: QIE_MAINNET.QIEDEX_ROUTER as `0x${string}`,
    abi: ROUTER,
    functionName: "swapExactTokensForTokens",
    args: [10_000_000n, 0n, [QIE_MAINNET.QUSDC, QIE_MAINNET.WQIE], user.address, deadline],
  });
  ok(`QIEDEX swap 10 QUSDC → WQIE  ${t5}`);

  await wallet.writeContract({ address: QIE_MAINNET.QUSDC, abi: ERC20, functionName: "approve", args: [billing, 9_000_000n] });
  const t6 = await wallet.writeContract({ address: billing, abi: BILLING, functionName: "subscribe", args: [1, 1, 9_000_000n] });
  ok(`subscribe to Pro for 9 QUSDC  ${t6}`);
  for (const h of [t1, t2, t3, t4, t5, t6]) assert.equal((await pub.waitForTransactionReceipt({ hash: h })).status, "success");

  // A transaction that reverts (0 periods), sent without simulation so it lands on chain.
  const t7 = await wallet.sendTransaction({ to: billing, data: encodeFunctionData({ abi: BILLING, functionName: "subscribe", args: [1, 0, 0n] }), gas: 200_000n });
  assert.equal((await pub.waitForTransactionReceipt({ hash: t7 })).status, "reverted");
  ok(`failing call subscribe(1, 0) reverted on chain  ${t7}`);

  step("Waiting for deliveries");
  const byHook = (id: string) => hits.filter((h) => h.json.hook.id === id);
  await waitFor(
    "all webhooks",
    () =>
      byHook(payHook.id).length >= 2 &&
      byHook(whaleHook.id).length >= 1 &&
      byHook(swapHook.id).length >= 1 &&
      byHook(subHook.id).length >= 1 &&
      byHook(approvalHook.id).length >= 2 &&
      byHook(balanceHook.id).length >= 1 &&
      byHook(priceHook.id).length >= 1 &&
      byHook(invoiceHook.id).length >= 2 &&
      byHook(walletHook.id).some((h) => h.json.data.status === "failed"),
    90_000,
  );
  await new Promise((r) => setTimeout(r, 2500)); // catch any extra (wrong) deliveries

  for (const h of hits) {
    const secret = secrets.get(h.json.hook.id)!;
    assert.ok(verify(secret, String(h.headers["qiepulse-signature"]), Number(h.headers["qiepulse-timestamp"]), h.body), "signature verifies");
    assert.equal(h.headers["qiepulse-event-id"], h.json.id);
  }
  ok(`${hits.length} webhooks received, all signatures valid`);

  const pays = byHook(payHook.id).map((h) => h.json);
  assert.equal(pays.length, 2, "two payments (0.5 QUSDC below minimum is ignored)");
  const qusdcPay = pays.find((p) => p.data.token.symbol === "QUSDC")!;
  assert.equal(qusdcPay.type, "payment.received");
  assert.equal(qusdcPay.data.amount.display, "25 QUSDC");
  assert.equal(qusdcPay.data.amount.valueUsd, 25);
  assert.equal(qusdcPay.data.to.name, NAME);
  assert.equal(qusdcPay.tx.hash, t1);
  assert.ok(qusdcPay.tx.timestamp > 0);
  ok(`payment: ${qusdcPay.data.amount.display} to ${qusdcPay.data.to.name} from ${qusdcPay.data.from.address}`);
  const qiePay = pays.find((p) => p.data.token.symbol === "QIE")!;
  assert.equal(qiePay.data.amount.display, "1.5 QIE");
  assert.equal(qiePay.data.token.address, null);
  assert.equal(qiePay.tx.hash, t4);
  ok(`payment: ${qiePay.data.amount.display} native${qiePay.data.amount.valueUsd != null ? ` (~$${qiePay.data.amount.valueUsd})` : ""}`);

  const whales = byHook(whaleHook.id).map((h) => h.json);
  assert.ok(whales.some((w) => w.data.amount.display === "150 QUSDC"));
  assert.ok(whales.every((w) => Number(w.data.amount.formatted) >= 100), "only ≥100 QUSDC transfers");
  ok(`token transfer: ${whales.map((w) => w.data.amount.display).join(", ")}`);

  const swap = byHook(swapHook.id)[0]!.json;
  assert.equal(swap.type, "dex.swap");
  assert.equal(swap.data.tokenIn.symbol, "QUSDC");
  assert.equal(swap.data.tokenOut.symbol, "WQIE");
  assert.equal(swap.data.amountIn.display, "10 QUSDC");
  assert.equal(swap.tx.hash, t5);
  ok(`swap: ${swap.data.amountIn.display} → ${swap.data.amountOut.display} (~$${swap.data.valueUsd})`);

  const sub = byHook(subHook.id)[0]!.json;
  assert.equal(sub.data.event, "Subscribed");
  assert.equal(getAddress(sub.data.args.account), user.address);
  assert.equal(sub.data.args.amount, "9000000");
  ok(`contract event: Subscribed(${sub.data.args.account}, plan ${sub.data.args.planId})`);

  const wallets = byHook(walletHook.id).map((h) => h.json);
  const kinds = wallets.map((w) => `${w.data.kind}:${w.data.direction}:${w.data.status}`);
  const has = (k: string) => assert.ok(kinds.includes(k), `missing ${k} in ${JSON.stringify(kinds)}`);
  has("token_transfer:in:success"); // 150 QUSDC from the whale, WQIE from the swap
  has("token_transfer:out:success"); // QUSDC into the pair and to the treasury
  has("native_transfer:out:success"); // 1.5 QIE
  has("contract_call:out:success"); // approve() calls (no Transfer event)
  has("contract_call:out:failed"); // the reverted subscribe(1, 0)
  assert.ok(!wallets.some((w) => w.data.kind === "contract_call" && [t5, t6].includes(w.tx.hash)), "swap/subscribe calls summarised by their token transfers");
  const failed = wallets.find((w) => w.data.status === "failed")!;
  assert.equal(failed.tx.hash, t7);
  ok(`wallet watch: ${wallets.length} events (${[...new Set(kinds)].join(", ")})`);

  const approvals = byHook(approvalHook.id).map((h) => h.json);
  assert.equal(approvals.length, 2);
  assert.ok(approvals.every((a) => getAddress(a.data.args.owner) === user.address));
  ok(`approvals: ${approvals.map((a) => `spender ${a.data.args.spender}`).join(", ")}`);

  const bal = byHook(balanceHook.id).map((h) => h.json);
  assert.equal(bal.length, 1, "balance alert fires once on crossing, not on every check");
  assert.equal(bal[0].type, "balance.threshold");
  assert.equal(bal[0].tx, null);
  assert.ok(Number(bal[0].data.balance.formatted) > 100);
  ok(`balance alert: ${bal[0].data.balance.display} is above ${bal[0].data.threshold} QUSDC`);

  const price = byHook(priceHook.id)[0]!.json;
  assert.equal(price.type, "price.threshold");
  ok(`price alert: WQIE $${price.data.priceUsd} from QIEDEX`);

  const paid25 = (await call("GET", `/pay/${inv25.id}`)).json.invoice;
  const paidQie = (await call("GET", `/pay/${invQie.id}`)).json.invoice;
  const stillOpen = (await call("GET", `/pay/${invOpen.id}`)).json.invoice;
  assert.equal(paid25.status, "paid");
  assert.equal(paid25.payment.txHash, t1);
  assert.equal(paidQie.status, "paid");
  assert.equal(paidQie.payment.txHash, t4);
  assert.equal(stillOpen.status, "open", "a different amount must not pay it");
  const invEvents = byHook(invoiceHook.id).map((h) => h.json);
  assert.equal(invEvents.length, 2);
  const order = invEvents.find((e) => e.data.invoice.id === inv25.id);
  assert.equal(order.type, "invoice.paid");
  assert.deepEqual(order.data.invoice.metadata, { orderId: "e2e-1" });
  ok(`payment links paid by the real transfers (QUSDC ${t1.slice(0, 10)}…, QIE ${t4.slice(0, 10)}…), invoice.paid webhooks carry the order id`);

  const traction = await waitFor("traction counted", async () => {
    const r = (await call("GET", `/projects/${project.slug}`)).json;
    return r.stats.totals.txs >= 1 && r.stats.totals.failedTxs >= 1 ? r : undefined;
  });
  assert.equal(traction.stats.totals.txs, 1, "the subscribe call");
  assert.equal(traction.stats.totals.failedTxs, 1, "the reverted subscribe(1, 0)");
  assert.equal(traction.stats.totals.wallets, 1);
  assert.equal(traction.project.backfill.status, "failed", "explorer unreachable in this test");
  const badge = await app.request(`/api/projects/${project.slug}/badge.svg`);
  assert.match(await badge.text(), /1 tx · 1 wallets/);
  ok(`traction page: ${traction.stats.totals.txs} tx, ${traction.stats.totals.failedTxs} failed, ${traction.stats.totals.wallets} wallet, badge served`);

  const me = (await call("GET", "/me")).json;
  const onchain = await pub.readContract({ address: billing, abi: BILLING, functionName: "paidUntil", args: [user.address] });
  assert.equal(me.plan.id, "pro");
  assert.equal(me.plan.expiresAt, Number(onchain));
  ok(`plan unlocked by the on-chain payment: Pro until ${new Date(me.plan.expiresAt * 1000).toISOString()}`);

  const events = (await call("GET", `/hooks/${payHook.id}/events`)).json.events;
  assert.ok(events.every((e: any) => e.delivery.status === "success"));
  const status = (await call("GET", "/status")).json;
  ok(`indexer at block ${status.indexer.cursor}, ${status.totals.events} events, ${status.deliveries24h.successRate}% delivered`);

  step("Failure handling");
  const dead = status.rpc.find((r: any) => r.url === "http://127.0.0.1:1");
  assert.equal(dead.healthy, false, "dead endpoint marked unhealthy");
  assert.ok(status.rpc.find((r: any) => r.url === RPC).healthy);
  ok(`RPC failover: dead endpoint marked down (${dead.lastError}), all traffic served by the healthy one`);

  // Simulate a crash + restart that replays every block: a second server on the same database.
  s.indexer.stop();
  s.checks.stop();
  await new Promise((r) => setTimeout(r, 1500));
  const count = () =>
    s.db.prepare("SELECT (SELECT COUNT(*) FROM events) AS e, (SELECT COUNT(*) FROM deliveries) AS d, (SELECT COUNT(*) FROM project_txs) AS p, (SELECT COUNT(*) FROM invoices WHERE status = 'paid') AS i").get() as {
      e: number;
      d: number;
      p: number;
      i: number;
    };
  const beforeReplay = count();
  const s2 = buildServices(cfg);
  s2.indexer.setCursor(startBlock - 1);
  while ((await s2.indexer.tick()) > 0) {}
  const afterReplay = count();
  assert.deepEqual({ ...afterReplay }, { ...beforeReplay }, "replaying blocks must not create or deliver anything twice");
  ok(`restart replayed ${s2.indexer.status.blocksProcessed} blocks: ${afterReplay.e} events, ${afterReplay.d} deliveries, ${afterReplay.p} traction txs, ${afterReplay.i} paid links, no duplicates`);

  console.log("\n✅ End-to-end test on QIE mainnet fork passed\n");
  s.indexer.stop();
  s.delivery.stop();
  sink.close();
  cleanup();
  process.exit(0);
}

main().catch((e) => {
  console.error("\n❌ E2E failed:", e);
  process.exit(1);
});
