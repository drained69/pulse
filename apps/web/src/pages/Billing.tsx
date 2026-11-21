import { useState } from "react";
import { createPublicClient, custom, formatUnits, parseAbi, parseUnits } from "viem";
import { api } from "../api.ts";
import { go, useApp } from "../App.tsx";
import { Alert, Spinner, useAsync } from "../ui.tsx";
import { connect, ensureChain, qieChain, walletClient } from "../wallet.ts";

const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);
const BILLING = parseAbi(["function subscribe(uint8 planId, uint32 periods, uint256 maxAmount) returns (uint64)"]);

type BillingInfo = { plan: { id: string; label: string }; paidUntil: number | null; subscriptions: { txHash: string; periods: number; amount: string; paidUntil: number; createdAt: number }[] };

/** Danger zone: delete the account after typing the wallet address. */
function DeleteAccount() {
  const { me, setMe } = useApp();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!me) return null;
  const matches = typed.trim().toLowerCase() === me.user.address.toLowerCase();
  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await api("DELETE", "/me", { confirm: typed.trim() });
      setMe(null);
      go("/");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="card" style={{ borderColor: "var(--bad)" }}>
      <h2>Delete account</h2>
      <p className="muted small">
        Deletes your hooks and their events, API keys, linked Telegram chats, payment links, products and traction pages. This can't be undone. Payments already made stay on
        chain, and a paid Pro period is not refunded. See <a href="#/privacy">Privacy</a>.
      </p>
      <label htmlFor="confirm-delete">
        Type your wallet address <span className="mono">{me.user.address}</span> to confirm
      </label>
      <div className="row">
        <input id="confirm-delete" className="mono" style={{ flex: 1, minWidth: 260 }} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="0x…" autoComplete="off" spellCheck={false} />
        <button className="btn danger" disabled={!matches || busy} onClick={remove}>
          {busy ? <Spinner /> : null} Delete account
        </button>
      </div>
      {error && (
        <div style={{ marginTop: 10 }}>
          <Alert kind="error">{error}</Alert>
        </div>
      )}
    </div>
  );
}

export function Billing() {
  const { config, me, reloadMe } = useApp();
  const info = useAsync(() => api<BillingInfo>("GET", "/billing"), []);
  const [periods, setPeriods] = useState(1);
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  if (!me) return null;

  const price = Number(config.proPriceQusdc);
  const used = me.usage.eventsThisMonth;
  const pct = Math.min(100, Math.round((used / me.plan.monthlyEvents) * 100));
  const pro = config.plans.pro;
  const free = config.plans.free;

  async function subscribe() {
    if (!config.billingContract) return;
    setError(null);
    setDone(null);
    try {
      setStep("Connecting wallet…");
      const { address, provider } = await connect();
      if (address.toLowerCase() !== me!.user.address.toLowerCase()) {
        throw new Error(`Switch your wallet to ${me!.user.address}, the account you signed in with. The plan goes to the paying address.`);
      }
      await ensureChain(provider, config.chainId, config.rpcUrl, config.explorerUrl);
      const chain = qieChain(config.chainId, config.rpcUrl, config.explorerUrl);
      const pub = createPublicClient({ chain, transport: custom(provider) });
      const wallet = walletClient(provider, address, config.chainId, config.rpcUrl, config.explorerUrl);
      const amount = parseUnits(config.proPriceQusdc, 6) * BigInt(periods);

      setStep("Checking your QUSDC balance…");
      const bal = await pub.readContract({ address: config.qusdc, abi: ERC20, functionName: "balanceOf", args: [address] });
      if (bal < amount) throw new Error(`You need ${formatUnits(amount, 6)} QUSDC and have ${formatUnits(bal, 6)}. Swap QIE for QUSDC on QIEDEX first.`);

      const allowance = await pub.readContract({ address: config.qusdc, abi: ERC20, functionName: "allowance", args: [address, config.billingContract] });
      if (allowance < amount) {
        setStep("Approve QUSDC in your wallet…");
        const h = await wallet.writeContract({ address: config.qusdc, abi: ERC20, functionName: "approve", args: [config.billingContract, amount] });
        setStep("Waiting for the approval to confirm…");
        await pub.waitForTransactionReceipt({ hash: h });
      }
      setStep("Confirm the payment in your wallet…");
      const tx = await wallet.writeContract({ address: config.billingContract, abi: BILLING, functionName: "subscribe", args: [1, periods, amount] });
      setStep("Waiting for the payment to confirm…");
      const receipt = await pub.waitForTransactionReceipt({ hash: tx });
      if (receipt.status !== "success") throw new Error("The payment transaction reverted");

      setStep("Payment confirmed. Unlocking Pro…");
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const m = await api<{ plan: { id: string } }>("GET", "/me");
        if (m.plan.id === "pro") break;
      }
      await reloadMe();
      await info.reload();
      setDone(`${config.explorerUrl}/tx/${tx}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message.split("\n")[0]! : String(e);
      setError(/reject|denied|4001/i.test(msg) ? "You cancelled the transaction." : msg);
    } finally {
      setStep(null);
    }
  }

  return (
    <div>
      <div className="topbar">
        <div>
          <h1>Plan</h1>
          <p className="muted" style={{ margin: 0 }}>
            Pay in QUSDC on QIE. The payment goes on chain to the Q-Pulse billing contract and unlocks your plan within seconds.
          </p>
        </div>
      </div>

      <div className="card">
        <div className="row between">
          <div>
            <div className="faint small">Current plan</div>
            <h2 style={{ margin: 0 }}>
              {me.plan.label}{" "}
              {me.plan.id === "pro" && me.plan.expiresAt && <span className="badge accent">until {new Date(me.plan.expiresAt * 1000).toLocaleDateString()}</span>}
            </h2>
          </div>
        </div>
        <div style={{ marginTop: 16 }}>
          <div className="row between small">
            <span>Events this month</span>
            <span className="mono">
              {used.toLocaleString()} / {me.plan.monthlyEvents.toLocaleString()}
            </span>
          </div>
          <div className="bar" style={{ marginTop: 6 }}>
            <span style={{ width: `${pct}%`, background: pct > 90 ? "var(--bad)" : undefined }} />
          </div>
          <div className="row between small" style={{ marginTop: 12 }}>
            <span>Hooks</span>
            <span className="mono">
              {me.usage.hooks} / {me.plan.maxHooks}
            </span>
          </div>
        </div>
      </div>

      <div className="grid two" style={{ marginTop: 16 }}>
        <div className="card">
          <h3>Free</h3>
          <div className="stat">
            <span className="n">$0</span>
          </div>
          <ul className="muted small">
            <li>{free.maxHooks} hooks</li>
            <li>{free.monthlyEvents.toLocaleString()} events a month</li>
            <li>Webhooks, Telegram and Discord</li>
            <li>Payment links, products and traction pages</li>
            <li>API, SDK, MCP for AI agents, WebSocket RPC</li>
          </ul>
        </div>
        <div className="card" style={{ borderColor: "var(--accent)" }}>
          <h3>Pro</h3>
          <div className="stat">
            <span className="n">{price} QUSDC</span> <span className="faint">/ {config.proPeriodDays} days</span>
          </div>
          <ul className="muted small">
            <li>{pro.maxHooks} hooks</li>
            <li>{pro.monthlyEvents.toLocaleString()} events a month</li>
            <li>Everything in Free</li>
            <li>Renewals stack: paying early adds to your current period</li>
            <li>No automatic renewal: you pay for each period yourself</li>
          </ul>
          {!config.billingContract ? (
            <Alert kind="warn">Billing is not configured on this server yet (BILLING_CONTRACT is not set).</Alert>
          ) : (
            <div className="stack">
              <div className="row">
                <label htmlFor="periods" style={{ margin: 0 }}>
                  Periods
                </label>
                <select id="periods" value={periods} onChange={(e) => setPeriods(Number(e.target.value))} style={{ width: 120 }}>
                  {[1, 3, 6, 12].map((n) => (
                    <option key={n} value={n}>
                      {n} × {config.proPeriodDays}d
                    </option>
                  ))}
                </select>
                <b className="right">{(price * periods).toLocaleString()} QUSDC</b>
              </div>
              <button className="btn primary" disabled={Boolean(step)} onClick={subscribe}>
                {step ? <Spinner /> : null} {step ?? (me.plan.id === "pro" ? "Extend Pro" : "Upgrade to Pro")}
              </button>
              <p className="small faint" style={{ margin: 0 }}>
                Need QUSDC?{" "}
                <a href="https://www.dex.qie.digital/" target="_blank" rel="noreferrer">
                  Swap QIE for QUSDC on QIEDEX
                </a>
                . Contract:{" "}
                <a href={`${config.explorerUrl}/address/${config.billingContract}`} target="_blank" rel="noreferrer" className="mono">
                  {config.billingContract.slice(0, 10)}…
                </a>
              </p>
            </div>
          )}
          {error && (
            <div style={{ marginTop: 10 }}>
              <Alert kind="error">{error}</Alert>
            </div>
          )}
          {done && (
            <div style={{ marginTop: 10 }}>
              <Alert kind="ok">
                Thanks! Pro is active.{" "}
                <a href={done} target="_blank" rel="noreferrer">
                  View the payment
                </a>
              </Alert>
            </div>
          )}
        </div>
      </div>

      {info.data && info.data.subscriptions.length > 0 && (
        <div className="card">
          <h2>Payments</h2>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Amount</th>
                <th>Paid until</th>
                <th>Tx</th>
              </tr>
            </thead>
            <tbody>
              {info.data.subscriptions.map((s) => (
                <tr key={s.txHash}>
                  <td>{new Date(s.createdAt * 1000).toLocaleDateString()}</td>
                  <td>{formatUnits(BigInt(s.amount), 6)} QUSDC</td>
                  <td>{new Date(s.paidUntil * 1000).toLocaleDateString()}</td>
                  <td>
                    <a href={`${config.explorerUrl}/tx/${s.txHash}`} target="_blank" rel="noreferrer" className="mono">
                      {s.txHash.slice(0, 10)}…
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <DeleteAccount />
    </div>
  );
}
