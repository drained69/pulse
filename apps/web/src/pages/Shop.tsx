import { useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import { go, useApp } from "../App.tsx";
import { Icon } from "../icons.tsx";
import { Alert, Copy, shortAddr, Spinner, timeAgo, useAsync } from "../ui.tsx";
import { Qr, type Invoice } from "./Pay.tsx";

/** Reusable payment links: one permanent link or printed QR per product, a fresh checkout per buyer. */
export type Product = {
  id: string;
  url: string;
  deviceUrl: string;
  name: string;
  description: string;
  price: { amount: string; symbol: string; display: string };
  recipient: { address: string; name: string | null };
  unlockContent: string | null;
  active: boolean;
  sold: number;
  lastSoldAt: number | null;
  createdAt: number;
};
type PublicProduct = Pick<Product, "id" | "url" | "name" | "description" | "price" | "recipient" | "active" | "lastSoldAt"> & { chainId: number };

// ───────── merchant: create and manage products (on the Payment links page) ─────────

export function Products() {
  const { me } = useApp();
  const list = useAsync(() => api<{ products: Product[] }>("GET", "/products"), [], 6000);
  const empty = { name: "", amount: "", token: "QUSDC", description: "", unlockContent: "", recipient: "" };
  const [form, setForm] = useState(empty);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [qrFor, setQrFor] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  async function update(id: string, method: string, body?: unknown) {
    setPending(id);
    setError(null);
    try {
      await api(method, `/products/${id}`, body);
      await list.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
    }
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api("POST", "/products", {
        name: form.name.trim(),
        amount: form.amount.trim(),
        token: form.token,
        description: form.description.trim(),
        unlockContent: form.unlockContent.trim() || null,
        recipient: form.recipient.trim() || undefined,
      });
      setForm(empty);
      setOpen(false);
      await list.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const products = list.data?.products ?? [];
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="row between">
        <div>
          <h2 style={{ marginBottom: 4 }}>Products</h2>
          <p className="muted small" style={{ margin: 0, maxWidth: 680 }}>
            A permanent link or QR code you can share, print or stick on a machine. Every buyer gets their own checkout, and after paying they see what they
            bought: a download link, a licence key or a door code. Your “Payment link paid” hooks fire with the product, so a device can unlock itself.
          </p>
        </div>
        {!open && (
          <button className="btn primary" onClick={() => setOpen(true)}>
            <Icon name="plus" size={16} /> New product
          </button>
        )}
      </div>

      {open && (
        <form className="stack" style={{ marginTop: 16 }} onSubmit={create}>
          <div className="grid three">
            <label className="field">
              <span>Name</span>
              <input type="text" required maxLength={80} placeholder="e.g. Locker 1, Logo pack, Coffee" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </label>
            <label className="field">
              <span>Price</span>
              <input type="text" inputMode="decimal" required placeholder="2" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
            </label>
            <label className="field">
              <span>Currency</span>
              <select value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })}>
                <option value="QUSDC">QUSDC (stablecoin)</option>
                <option value="QIE">QIE</option>
                <option value="WQIE">WQIE</option>
              </select>
            </label>
          </div>
          <label className="field">
            <span>Description (shown to buyers)</span>
            <input type="text" maxLength={200} placeholder="e.g. Opens for 30 seconds after payment" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </label>
          <label className="field">
            <span>Unlocked after payment (optional, only the buyer sees it)</span>
            <textarea maxLength={2000} placeholder="A download link, licence key, door code or a thank-you note" value={form.unlockContent} onChange={(e) => setForm({ ...form, unlockContent: e.target.value })} />
          </label>
          <label className="field">
            <span>Pay to (optional)</span>
            <input type="text" placeholder={me?.user.qieName ?? me?.user.address ?? "name.qie or 0x…"} value={form.recipient} onChange={(e) => setForm({ ...form, recipient: e.target.value })} />
          </label>
          <div className="row">
            <button className="btn primary" type="submit" disabled={saving}>
              {saving ? <Spinner /> : null} Create product
            </button>
            <button className="btn ghost" type="button" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {(error || list.error) && <Alert kind="error">{error ?? list.error}</Alert>}
      {list.loading && <Spinner />}
      {list.data && products.length === 0 && !open && <p className="muted" style={{ marginTop: 16, marginBottom: 0 }}>No products yet.</p>}
      {products.length > 0 && (
        <div className="stack" style={{ marginTop: 16 }}>
          {products.map((p) => (
            <div className="product-row" key={p.id}>
              <div className="grow">
                <div className="row" style={{ gap: 8 }}>
                  <b>{p.name}</b>
                  <span className="badge accent">{p.price.display}</span>
                  {!p.active && <span className="badge">Paused</span>}
                  {p.unlockContent && (
                    <span className="badge">
                      <Icon name="unlock" size={13} /> Unlock content
                    </span>
                  )}
                </div>
                <div className="small faint" style={{ marginTop: 4 }}>
                  {p.sold} sold{p.lastSoldAt ? ` · last ${timeAgo(p.lastSoldAt)}` : ""} · pays {p.recipient.name ?? shortAddr(p.recipient.address)}
                </div>
                {qrFor === p.id && (
                  <div className="row" style={{ marginTop: 12, alignItems: "flex-start" }}>
                    <Qr text={p.url} />
                    <div className="small muted" style={{ maxWidth: 320 }}>
                      Print this QR code or show it on a screen. It always opens a fresh checkout for <b>{p.name}</b>.
                    </div>
                  </div>
                )}
              </div>
              <div className="row" style={{ gap: 6, justifyContent: "flex-end" }}>
                <Copy text={p.url} label="Copy link" />
                <button className="btn sm" onClick={() => setQrFor(qrFor === p.id ? null : p.id)}>
                  QR
                </button>
                <a className="btn sm" href={`#/device/${p.id}`} target="_blank" rel="noreferrer">
                  Device view
                </a>
                <button
                  className="btn sm"
                  disabled={pending !== null}
                  onClick={() => void update(p.id, "PATCH", { active: !p.active })}
                >
                  {p.active ? "Pause" : "Resume"}
                </button>
                <button
                  className="btn sm danger"
                  disabled={pending !== null}
                  onClick={() => {
                    if (!confirm(`Delete “${p.name}”? Its link and QR code stop working.`)) return;
                    void update(p.id, "DELETE");
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ───────── public: the product's permanent link ─────────

const LAST_CHECKOUT = (id: string) => `qp_checkout_${id}`;

export function BuyPage({ id }: { id: string }) {
  const { data, error } = useAsync(() => api<{ product: PublicProduct }>("GET", `/shop/${id}`), [id]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const p = data?.product;

  async function checkout() {
    setBusy(true);
    setErr(null);
    try {
      // Reuse this browser's open checkout, so a reload doesn't reserve a second amount.
      let saved: string | null = null;
      try {
        saved = localStorage.getItem(LAST_CHECKOUT(id));
      } catch {
        /* storage unavailable */
      }
      if (saved) {
        const cur = await api<{ invoice: Invoice }>("GET", `/pay/${saved}`).catch(() => null);
        if (cur?.invoice.status === "open" && cur.invoice.expiresAt > Date.now() / 1000 + 60) return go(`/pay/${saved}`);
      }
      const r = await api<{ invoice: Invoice }>("POST", `/shop/${id}/buy`);
      try {
        localStorage.setItem(LAST_CHECKOUT(id), r.invoice.id);
      } catch {
        /* storage unavailable */
      }
      go(`/pay/${r.invoice.id}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main id="main-content" tabIndex={-1} className="checkout-page">
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
          {error && <Alert kind="error">{error}</Alert>}
          {!p && !error && <Spinner />}
          {p && (
            <>
              <div>
                <div className="small faint">Buy from {p.recipient.name ?? shortAddr(p.recipient.address)}</div>
                <h1 style={{ margin: "4px 0 0", fontSize: "1.8rem" }}>{p.name}</h1>
              </div>
              {p.description && <div className="muted">{p.description}</div>}
              <div className="amount">
                {p.price.amount} <span>{p.price.symbol}</span>
              </div>
              {p.active ? (
                <button className="btn primary lg" onClick={checkout} disabled={busy}>
                  {busy ? <Spinner /> : null} Continue to payment <span className="arrow">→</span>
                </button>
              ) : (
                <Alert kind="warn">This product is not on sale right now.</Alert>
              )}
              {err && <Alert kind="error">{err}</Alert>}
              <div className="small faint">You get your own payment link with an exact amount, valid for 15 minutes. Pay with QIE Wallet or any wallet.</div>
            </>
          )}
        </div>
      </div>
    </main>
  );
}

// ───────── public: demo device that unlocks when its product is paid ─────────

export function DevicePage({ id }: { id: string }) {
  const { data, error } = useAsync(() => api<{ product: PublicProduct }>("GET", `/shop/${id}`), [id], 2000);
  const p = data?.product;
  const baseline = useRef<number | null | undefined>(undefined);
  const [unlockedAt, setUnlockedAt] = useState<number | null>(null);
  const [, tick] = useState(0);

  useEffect(() => {
    if (!p) return;
    if (baseline.current === undefined) baseline.current = p.lastSoldAt; // only sales after the page opened unlock it
    else if (p.lastSoldAt !== null && p.lastSoldAt !== baseline.current) {
      baseline.current = p.lastSoldAt;
      setUnlockedAt(Date.now());
    }
  }, [p?.lastSoldAt]);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, []);
  const open = unlockedAt !== null && Date.now() - unlockedAt < 12_000;

  return (
    <main id="main-content" tabIndex={-1} className="device-page">
      <div className="device">
        <div className="device-head">
          <span className="brand" style={{ fontSize: "1rem" }}>
            <img src="/favicon.svg" alt="" style={{ width: 20, height: 20 }} /> Q-Pulse device
          </span>
          <span className="chip">
            <span className={`dot ${p && !error ? "live" : ""}`} style={{ color: error ? "var(--bad)" : "var(--good)" }} /> {error ? "Connection interrupted" : p ? "Listening on QIE" : "Connecting…"}
          </span>
        </div>
        {error && <Alert kind="error">{error}</Alert>}
        {!p && !error && <Spinner />}
        {p && (
          <div className="device-body">
            <div className={`lock ${open ? "open" : ""}`} aria-live="polite">
              <Icon name={open ? "unlock" : "lock"} size={72} />
              <div className="lock-state">{open ? "Unlocked" : "Locked"}</div>
              <div className="small">{open ? "Payment confirmed on QIE. Enjoy!" : `Pay ${p.price.display} to open`}</div>
            </div>
            <div className="device-pay">
              <h1 style={{ margin: 0, fontSize: "1.45rem" }}>{p.name}</h1>
              {p.description && <p className="muted" style={{ margin: 0 }}>{p.description}</p>}
              <Qr text={p.url} />
              <div className="small faint">Scan with your phone to pay {p.price.display}</div>
            </div>
          </div>
        )}
        <div className="small faint device-foot">
          Demo screen: it opens when a payment for this product confirms on QIE. A real lock or machine does the same with the signed <code>invoice.paid</code> webhook (see Docs).
        </div>
      </div>
    </main>
  );
}
