import { Icon } from "../icons.tsx";
import qrcode from "qrcode-generator";
import { useEffect, useMemo, useState } from "react";
import { parseAbi } from "viem";
import { api } from "../api.ts";
import { useApp } from "../App.tsx";
import { Alert, Copy, shortAddr, Spinner, timeAgo, useAsync } from "../ui.tsx";
import { connect, ensureChain, walletClient } from "../wallet.ts";
import { Products } from "./Shop.tsx";

export type Invoice = {
  id: string;
  url: string;
  status: "open" | "paid" | "expired" | "cancelled";
  description: string;
  recipient: { address: string; name: string | null };
  token: { symbol: string; address: string | null; decimals: number };
  amount: { raw: string; formatted: string; display: string };
  baseAmount: { raw: string; formatted: string };
  expiresAt: number;
  createdAt: number;
  successUrl: string | null;
  payment: { txHash: string; from: string; blockNumber: number; paidAt: number; late: boolean; explorerUrl: string } | null;
  metadata?: Record<string, unknown>;
  product: { id: string; name: string } | null;
  /** What the buyer gets once paid (a download link, licence key…). Null until paid. */
  unlock: string | null;
  chainId: number;
};

const ERC20 = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);

function useNow(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function left(sec: number): string {
  if (sec <= 0) return "expired";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return h ? `${h}h ${m}m` : `${m}:${String(s).padStart(2, "0")}`;
}

/** EIP-681 payment request: wallets that support it pre-fill recipient, token and amount. */
function paymentUri(inv: Invoice): string {
  return inv.token.address
    ? `ethereum:${inv.token.address}@${inv.chainId}/transfer?address=${inv.recipient.address}&uint256=${inv.amount.raw}`
    : `ethereum:${inv.recipient.address}@${inv.chainId}?value=${inv.amount.raw}`;
}

export function Qr({ text }: { text: string }) {
  const src = useMemo(() => {
    const q = qrcode(0, "M");
    q.addData(text);
    q.make();
    return q.createDataURL(5, 2);
  }, [text]);
  return <img className="qr" src={src} alt="Payment QR code" width={180} height={180} />;
}

// ───────── public checkout page ─────────

export function Checkout({ id }: { id: string }) {
  const { config } = useApp();
  const now = useNow();
  const [sent, setSent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { data, error: loadError } = useAsync(() => api<{ invoice: Invoice }>("GET", `/pay/${id}`), [id], 2000);
  const inv = data?.invoice;
  const status = inv && inv.status === "open" && inv.expiresAt <= now ? "expired" : inv?.status;

  const backUrl = inv?.successUrl && inv.payment ? `${inv.successUrl}${inv.successUrl.includes("?") ? "&" : "?"}invoice=${inv.id}&tx=${inv.payment.txHash}` : null;
  useEffect(() => {
    if (status !== "paid" || !backUrl) return;
    const t = setTimeout(() => window.location.assign(backUrl), 5000);
    return () => clearTimeout(t);
  }, [status, backUrl]);

  if (loadError) {
    return (
      <div className="checkout">
        <div className="card">
          <Alert kind="error">{loadError}</Alert>
        </div>
      </div>
    );
  }
  if (!inv) {
    return (
      <div className="checkout empty">
        <Spinner />
      </div>
    );
  }
  const merchant = inv.recipient.name ?? shortAddr(inv.recipient.address);

  async function pay() {
    if (!inv) return;
    setBusy(true);
    setError(null);
    try {
      const { address, provider } = await connect();
      await ensureChain(provider, config.chainId, config.rpcUrl, config.explorerUrl);
      const wallet = walletClient(provider, address, config.chainId, config.rpcUrl, config.explorerUrl);
      const to = inv.recipient.address as `0x${string}`;
      const hash = inv.token.address
        ? await wallet.writeContract({ address: inv.token.address as `0x${string}`, abi: ERC20, functionName: "transfer", args: [to, BigInt(inv.amount.raw)] })
        : await wallet.sendTransaction({ to, value: BigInt(inv.amount.raw) });
      setSent(hash);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(/reject|denied|4001/i.test(msg) ? "You cancelled the payment in your wallet." : /insufficient/i.test(msg) ? `Not enough ${inv.token.symbol} (or QIE for gas) in this wallet.` : msg.split("\n")[0]!);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="checkout-page">
    <div className="checkout">
      <div className="checkout-brand">
        <a className="brand" href="#/" style={{ fontSize: "1.1rem" }}>
          <img src="/favicon.svg" alt="" style={{ width: 22, height: 22 }} /> Q-Pulse
        </a>
        <span className="chip">
          <Icon name="lock" size={13} /> Secure checkout
        </span>
      </div>
      <div className="card stack checkout-card" style={{ gap: 18 }}>
        <div className="row between">
          <div>
            <div className="small faint">Pay</div>
            <div style={{ fontWeight: 700, fontSize: "1.1rem", color: "var(--ink)" }}>{merchant}</div>
          </div>
          {status === "open" && <span className="badge warn">Expires in {left(inv.expiresAt - now)}</span>}
          {status === "paid" && <span className="badge good">✓ Paid</span>}
          {status === "expired" && <span className="badge bad">Expired</span>}
          {status === "cancelled" && <span className="badge bad">Cancelled</span>}
        </div>

        {inv.product && <h2 style={{ margin: 0 }}>{inv.product.name}</h2>}
        {(() => {
          // A product checkout's description is "Name · description": the name is already the heading.
          const d = inv.product && inv.description.startsWith(`${inv.product.name} · `) ? inv.description.slice(inv.product.name.length + 3) : inv.description;
          return d && d !== inv.product?.name ? <div className="muted">{d}</div> : null;
        })()}

        <div className="amount">
          {inv.amount.formatted} <span>{inv.token.symbol}</span>
        </div>

        {status === "paid" && inv.unlock && (
          <div className="unlock-box">
            <div className="row" style={{ gap: 8 }}>
              <Icon name="unlock" size={18} /> <b>Your purchase</b>
            </div>
            {/^https?:\/\/\S+$/.test(inv.unlock) ? (
              <a className="btn primary lg" href={inv.unlock} target="_blank" rel="noopener noreferrer">
                Open your purchase <span className="arrow">→</span>
              </a>
            ) : (
              <div className="unlock-text">{inv.unlock}</div>
            )}
            <div className="row">
              <Copy text={inv.unlock} label="Copy" />
              <span className="small faint">Save it now: it is shown on this page only.</span>
            </div>
          </div>
        )}

        {status === "paid" && inv.payment && (
          <div className="stack" style={{ gap: 10 }}>
            <Alert kind="ok">
              <b>Payment received.</b> Confirmed on QIE {timeAgo(inv.payment.paidAt)} from {shortAddr(inv.payment.from)}.{" "}
              <a href={inv.payment.explorerUrl} target="_blank" rel="noreferrer">
                View transaction
              </a>
            </Alert>
            {backUrl && (
              <a className="btn primary lg" href={backUrl}>
                Return to {merchant}
              </a>
            )}
          </div>
        )}

        {(status === "expired" || status === "cancelled") && (
          <Alert kind="warn">
            This payment link is {status}. Don't send anything to it; ask {merchant} for a new link. (If you already paid, your payment is still recognised.)
          </Alert>
        )}

        {status === "open" && (
          <>
            {sent ? (
              <Alert kind="info">
                <Spinner /> Payment sent. Waiting for QIE to confirm it (usually a few seconds)…{" "}
                <a href={`${config.explorerUrl}/tx/${sent}`} target="_blank" rel="noreferrer">
                  Transaction
                </a>
              </Alert>
            ) : (
              <button className="btn primary lg" onClick={pay} disabled={busy}>
                {busy ? <Spinner /> : null} Pay with QIE Wallet
              </button>
            )}
            {error && <Alert kind="error">{error}</Alert>}

            <details className="manual">
              <summary>Pay from another wallet or your phone</summary>
              <div className="row" style={{ alignItems: "flex-start", gap: 18, marginTop: 12 }}>
                <Qr text={paymentUri(inv)} />
                <div className="stack grow" style={{ gap: 10 }}>
                  <div>
                    <div className="small faint">Send exactly</div>
                    <div className="row">
                      <code className="mono">
                        {inv.amount.formatted} {inv.token.symbol}
                      </code>
                      <Copy text={inv.amount.formatted} />
                    </div>
                  </div>
                  <div>
                    <div className="small faint">To</div>
                    <div className="row">
                      <code className="mono small grow">{inv.recipient.address}</code>
                      <Copy text={inv.recipient.address} />
                    </div>
                  </div>
                  <div className="small faint">
                    On QIE {config.network} (chain {inv.chainId}).
                    {inv.token.address ? ` Token: official ${inv.token.symbol} ${shortAddr(inv.token.address)}.` : ""}
                    {inv.amount.raw !== inv.baseAmount.raw ? " The last digits of the amount identify your payment, so send it exactly." : ""}
                  </div>
                </div>
              </div>
            </details>
          </>
        )}
      </div>
      <div className="checkout-trust">
        <span>
          <Icon name="check" size={14} /> Settles on QIE mainnet in seconds
        </span>
        <span>
          <Icon name="check" size={14} /> Goes straight to {merchant}
        </span>
        <span>
          <Icon name="check" size={14} /> No account needed
        </span>
      </div>
    </div>
    </div>
  );
}

// ───────── merchant: create and track links ─────────

const EXPIRY = [
  [15, "15 minutes"],
  [60, "1 hour"],
  [1440, "1 day"],
  [10080, "7 days"],
  [43200, "30 days"],
] as const;

export function PaymentLinks() {
  const { me } = useApp();
  const list = useAsync(() => api<{ invoices: Invoice[]; totals: { symbol: string; paid: number; total: number; decimals: number }[] }>("GET", "/invoices"), [], 4000);
  const [form, setForm] = useState({ amount: "", token: "QUSDC", description: "", recipient: "", expires: 60 });
  const [created, setCreated] = useState<Invoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const hasHook = useAsync(() => api<{ hooks: { trigger: { type: string } }[] }>("GET", "/hooks"), []);
  const notified = hasHook.data?.hooks.some((h) => h.trigger.type === "invoice");

  return (
    <div>
      <div className="topbar">
        <div>
          <h1>Payment links</h1>
          <p className="muted" style={{ margin: 0 }}>
            Send a customer a link, they pay with QIE Wallet or a QR code, and you're told the moment it settles. Funds go straight to your wallet.
          </p>
        </div>
      </div>

      {list.data && list.data.totals.length > 0 && (
        <div className="grid four" style={{ marginBottom: 16 }}>
          {list.data.totals.map((t) => (
            <div className="card stat" key={t.symbol}>
              <div className="l">Received in {t.symbol}</div>
              <div className="n">{(t.total / 10 ** t.decimals).toLocaleString(undefined, { maximumFractionDigits: 4 })}</div>
              <div className="small faint">
                {t.paid} paid link{t.paid === 1 ? "" : "s"}
              </div>
            </div>
          ))}
        </div>
      )}

      {hasHook.data && !notified && (
        <div style={{ marginBottom: 16 }}>
          <Alert kind="info">
            Want a Telegram message or a webhook when a link is paid? <a href="#/hooks/new/checkout">Create a “Payment link paid” hook</a>.
          </Alert>
        </div>
      )}

      <form
        className="card stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          setSaving(true);
          try {
            const r = await api<{ invoice: Invoice }>("POST", "/invoices", {
              amount: form.amount.trim(),
              token: form.token,
              description: form.description,
              recipient: form.recipient.trim() || undefined,
              expiresInMinutes: form.expires,
            });
            setCreated(r.invoice);
            setForm({ ...form, amount: "", description: "" });
            await list.reload();
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          } finally {
            setSaving(false);
          }
        }}
      >
        <h2 style={{ margin: 0 }}>New payment link</h2>
        <div className="grid three">
          <label className="field">
            <span>Amount</span>
            <input type="text" inputMode="decimal" required placeholder="25" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          </label>
          <label className="field">
            <span>Currency</span>
            <select value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })}>
              <option value="QUSDC">QUSDC (stablecoin)</option>
              <option value="QIE">QIE</option>
              <option value="WQIE">WQIE</option>
            </select>
          </label>
          <label className="field">
            <span>Expires after</span>
            <select value={form.expires} onChange={(e) => setForm({ ...form, expires: Number(e.target.value) })}>
              {EXPIRY.map(([m, l]) => (
                <option key={m} value={m}>
                  {l}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="field">
          <span>What it's for (shown to the customer)</span>
          <input type="text" maxLength={200} placeholder="e.g. Order #1001 · 2 coffees" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </label>
        <label className="field">
          <span>Pay to (optional)</span>
          <input
            type="text"
            placeholder={me?.user.qieName ?? me?.user.address ?? "name.qie or 0x…"}
            value={form.recipient}
            onChange={(e) => setForm({ ...form, recipient: e.target.value })}
          />
          <span className="hint">Defaults to your signed-in wallet. Use a name.qie or another address, e.g. your shop's Safe.</span>
        </label>
        {error && <Alert kind="error">{error}</Alert>}
        <div className="row">
          <button className="btn primary" type="submit" disabled={saving}>
            {saving ? "Creating…" : "Create link"}
          </button>
        </div>
        {created && (
          <Alert kind="ok">
            <div style={{ marginBottom: 8 }}>
              Link for <b>{created.amount.display}</b> ready. Send it to your customer:
            </div>
            <div className="row">
              <code className="mono small grow">{created.url}</code>
              <Copy text={created.url} />
              <a className="btn sm" href={`#/pay/${created.id}`} target="_blank" rel="noreferrer">
                Open
              </a>
            </div>
          </Alert>
        )}
      </form>

      <Products />

      <div className="card" style={{ marginTop: 16 }}>
        <h2>Your links</h2>
        {list.data && list.data.invoices.length === 0 && <p className="muted">No payment links yet.</p>}
        {list.data && list.data.invoices.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>For</th>
                  <th className="num">Amount</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.data.invoices.map((i) => (
                  <tr key={i.id}>
                    <td>
                      <div>{i.description || <span className="faint">No description</span>}</div>
                      <div className="small faint mono">{i.id}</div>
                    </td>
                    <td className="num mono">{i.amount.display}</td>
                    <td>
                      {i.status === "paid" && i.payment ? (
                        <a className="badge good" href={i.payment.explorerUrl} target="_blank" rel="noreferrer" title={`From ${i.payment.from}`}>
                          ✓ Paid {timeAgo(i.payment.paidAt)}
                          {i.payment.late ? " (late)" : ""}
                        </a>
                      ) : (
                        <span className={`badge ${i.status === "open" ? "warn" : "bad"}`}>{i.status === "open" ? "Waiting" : i.status === "expired" ? "Expired" : "Cancelled"}</span>
                      )}
                    </td>
                    <td className="small">{timeAgo(i.createdAt)}</td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <Copy text={i.url} label="Copy link" />{" "}
                      {i.status === "open" && (
                        <button
                          className="btn sm danger"
                          onClick={async () => {
                            if (!confirm("Cancel this payment link? The customer will see it as cancelled.")) return;
                            await api("POST", `/invoices/${i.id}/cancel`);
                            await list.reload();
                          }}
                        >
                          Cancel
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2>From your code</h2>
        <pre className="code">{`// Create a link at checkout, redirect the customer to it
const { invoice } = await fetch("${window.location.origin}/api/invoices", {
  method: "POST",
  headers: { authorization: "Bearer qp_live_…", "content-type": "application/json" },
  body: JSON.stringify({
    amount: "25", token: "QUSDC", description: "Order #1001",
    metadata: { orderId: "1001" },            // returned in the invoice.paid webhook
    successUrl: "https://shop.example/thanks", // customer returns here after paying
  }),
}).then((r) => r.json());
res.redirect(invoice.url);

// Then fulfil the order in your "Payment link paid" webhook:
// event.type === "invoice.paid" → event.data.invoice.metadata.orderId`}</pre>
      </div>
    </div>
  );
}
