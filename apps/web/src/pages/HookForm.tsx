import { useEffect, useState } from "react";
import { api, type Hook, type Pair, type TgChat } from "../api.ts";
import { go, useApp } from "../App.tsx";
import { EMPTY_FORM, TEMPLATES, type FormState, type TriggerType } from "../templates.ts";
import { Alert, CHANNEL_META, Spinner, TRIGGER_META, shortAddr, useAsync } from "../ui.tsx";

type ChannelType = Hook["channel"]["type"];

const isAddr = (v: string) => /^0x[0-9a-fA-F]{40}$/.test(v.trim());
const isName = (v: string) => v.trim().toLowerCase().endsWith(".qie");
const lines = (v: string) => v.split("\n").map((l) => l.trim()).filter(Boolean);

/** Shows what a name.qie resolves to, live. */
function NameHint({ value }: { value: string }) {
  const [state, setState] = useState<{ loading: boolean; address?: string | null; error?: string }>({ loading: false });
  useEffect(() => {
    if (!isName(value)) {
      setState({ loading: false });
      return;
    }
    setState({ loading: true });
    const t = setTimeout(async () => {
      try {
        const r = await api<{ address: string | null }>("GET", `/resolve?name=${encodeURIComponent(value.trim())}`);
        setState({ loading: false, address: r.address });
      } catch (e) {
        setState({ loading: false, error: e instanceof Error ? e.message : String(e) });
      }
    }, 450);
    return () => clearTimeout(t);
  }, [value]);
  if (!isName(value)) return null;
  if (state.loading) return <div className="hint">Looking up {value.trim()} on QIE ID…</div>;
  if (state.error) return <div className="hint" style={{ color: "var(--bad)" }}>{state.error}</div>;
  if (state.address === null) return <div className="hint" style={{ color: "var(--bad)" }}>{value.trim()} is not registered on QIE ID.</div>;
  if (state.address) return <div className="hint" style={{ color: "var(--good)" }}>✓ {value.trim()} → <span className="mono">{state.address}</span></div>;
  return null;
}

function AddressField({ id, label, value, onChange, hint, required }: { id: string; label: string; value: string; onChange: (v: string) => void; hint?: string; required?: boolean }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="text" placeholder="name.qie or 0x…" value={value} onChange={(e) => onChange(e.target.value)} required={required} />
      <NameHint value={value} />
      {value && !isName(value) && !isAddr(value) && <div className="hint">Enter a QIE ID (yourname.qie) or a 0x address.</div>}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

function fromHook(h: Hook): FormState {
  const c = h.trigger.config;
  const f: FormState = { ...EMPTY_FORM, name: h.name, type: h.trigger.type as TriggerType, channel: h.channel.type };
  switch (h.trigger.type as TriggerType) {
    case "payment": {
      const assets: string[] = c.assets ?? [];
      Object.assign(f, {
        recipient: c.recipient,
        assetQIE: assets.includes("QIE"),
        assetQUSDC: assets.includes("QUSDC"),
        extraTokens: assets.filter((a) => a !== "QIE" && a !== "QUSDC").join(", "),
        anyToken: Boolean(c.anyToken),
        minAmount: c.minAmount ?? "",
      });
      break;
    }
    case "token_transfer":
      Object.assign(f, { token: c.token, from: c.from ?? "", to: c.to ?? "", minAmount: c.minAmount ?? "" });
      break;
    case "swap":
      Object.assign(f, { pair: c.pair, minUsd: c.minValueUsd != null ? String(c.minValueUsd) : "" });
      break;
    case "contract_event":
      Object.assign(f, {
        contract: c.address ?? "",
        events: [...(c.event ? [c.event] : []), ...(c.events ?? [])].join("\n"),
        filters: Object.entries(c.filters ?? {}).map(([k, v]) => `${k}=${v}`).join("\n"),
      });
      break;
    case "wallet":
      Object.assign(f, { walletAddr: c.address, direction: c.direction ?? "both", includeFailed: c.includeFailed !== false, includeTokens: c.includeTokens !== false });
      break;
    case "balance":
      Object.assign(f, { balAddr: c.address, balAsset: c.asset ?? "QIE", balDir: c.below ? "below" : "above", balAmount: c.below ?? c.above ?? "" });
      break;
    case "price":
      Object.assign(f, { priceToken: c.token, priceDir: c.below !== undefined ? "below" : "above", priceValue: String(c.below ?? c.above ?? "") });
      break;
    case "name_watch":
      f.watchName = c.name;
      break;
    case "daily_digest":
      Object.assign(f, { digestSource: c.sourceHookId, digestHour: String(c.hourUtc ?? 8) });
      break;
  }
  if (h.channel.type === "webhook") f.recipient ||= "";
  return f;
}

export function HookForm({ id }: { id?: string }) {
  const { config, me, reloadMe } = useApp();
  const editing = Boolean(id);
  const [f, setF] = useState<FormState>(EMPTY_FORM);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((prev) => ({ ...prev, [k]: v }));
  const [url, setUrl] = useState("");
  const [discordUrl, setDiscordUrl] = useState("");
  const [chatRef, setChatRef] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);

  const chats = useAsync(() => api<{ chats: TgChat[] }>("GET", "/telegram/chats"), []);
  const pairs = useAsync(() => api<{ pairs: Pair[] }>("GET", "/pairs"), []);
  const myHooks = useAsync(() => api<{ hooks: Hook[] }>("GET", "/hooks"), []);

  useEffect(() => {
    if (!config.telegram.enabled && f.channel === "telegram") set("channel", "webhook");
  }, [config.telegram.enabled, f.channel]);
  useEffect(() => {
    if (!chatRef && chats.data?.chats[0]) setChatRef(chats.data.chats[0].id);
  }, [chats.data, chatRef]);

  // Template from the URL: #/hooks/new/<template>
  useEffect(() => {
    if (editing) return;
    const t = window.location.hash.split("/")[3];
    const tpl = TEMPLATES.find((x) => x.id === t);
    if (tpl) {
      setF({ ...EMPTY_FORM, channel: config.telegram.enabled ? "telegram" : "webhook", ...tpl.apply(me) });
      setPicked(tpl.id);
    }
  }, [editing]);

  useEffect(() => {
    if (!id) return;
    void api<{ hook: Hook }>("GET", `/hooks/${id}`).then(({ hook }) => {
      setF(fromHook(hook));
      if (hook.channel.type === "webhook") setUrl(hook.channel.config.url);
      if (hook.channel.type === "discord") setDiscordUrl(hook.channel.config.url);
      if (hook.channel.type === "telegram") setChatRef(hook.channel.config.chatRef);
    });
  }, [id]);

  function buildTrigger(): { type: TriggerType; config: Record<string, unknown> } {
    const min = f.minAmount.trim() || undefined;
    switch (f.type) {
      case "payment": {
        const assets = [...(f.assetQIE ? ["QIE"] : []), ...(f.assetQUSDC ? ["QUSDC"] : []), ...f.extraTokens.split(/[\s,]+/).filter(Boolean)];
        return { type: f.type, config: { recipient: f.recipient.trim(), assets, anyToken: f.anyToken, minAmount: min } };
      }
      case "token_transfer":
        return { type: f.type, config: { token: f.token.trim(), from: f.from.trim() || undefined, to: f.to.trim() || undefined, minAmount: min } };
      case "swap":
        return { type: f.type, config: { pair: f.pair.trim(), minValueUsd: f.minUsd.trim() ? Number(f.minUsd) : undefined } };
      case "contract_event": {
        const filters: Record<string, string> = {};
        for (const line of lines(f.filters)) {
          const [k, ...rest] = line.split("=");
          if (k?.trim() && rest.join("=").trim()) filters[k.trim()] = rest.join("=").trim();
        }
        return { type: f.type, config: { address: f.contract.trim() || undefined, events: lines(f.events), filters } };
      }
      case "wallet":
        return { type: f.type, config: { address: f.walletAddr.trim(), direction: f.direction, includeFailed: f.includeFailed, includeTokens: f.includeTokens } };
      case "balance":
        return { type: f.type, config: { address: f.balAddr.trim(), asset: f.balAsset.trim(), [f.balDir]: f.balAmount.trim() } };
      case "price":
        return { type: f.type, config: { token: f.priceToken.trim(), [f.priceDir]: Number(f.priceValue) } };
      case "name_watch":
        return { type: f.type, config: { name: f.watchName.trim() } };
      case "daily_digest":
        return { type: f.type, config: { sourceHookId: f.digestSource, hourUtc: Number(f.digestHour) } };
      case "invoice":
        return { type: f.type, config: {} };
    }
  }

  function buildChannel(): { type: ChannelType; config: Record<string, unknown> } {
    if (f.channel === "webhook") return { type: f.channel, config: { url: url.trim() } };
    if (f.channel === "discord") return { type: f.channel, config: { url: discordUrl.trim() } };
    return { type: f.channel, config: { chatRef } };
  }

  function defaultName(): string {
    switch (f.type) {
      case "payment":
        return `Payments to ${f.recipient.trim() || "my wallet"}`;
      case "token_transfer":
        return `${f.token} transfers${f.minAmount ? ` ≥ ${f.minAmount}` : ""}`;
      case "swap": {
        const p = pairs.data?.pairs.find((x) => x.address.toLowerCase() === f.pair.toLowerCase());
        return p ? `${p.token0.symbol}/${p.token1.symbol} swaps` : "QIEDEX swaps";
      }
      case "contract_event":
        return `${(lines(f.events)[0] ?? "Contract").replace(/^event\s+/, "").split("(")[0]} events`;
      case "wallet":
        return `Activity of ${f.walletAddr.trim() || "a wallet"}`;
      case "balance":
        return `${f.balAsset} balance ${f.balDir} ${f.balAmount || "…"}`;
      case "price":
        return `${f.priceToken} ${f.priceDir} $${f.priceValue || "…"}`;
      case "name_watch":
        return `Watch ${f.watchName.trim() || "a QIE ID"}`;
      case "daily_digest":
        return "Daily summary";
      case "invoice":
        return "Payment link paid";
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const payload = { name: f.name.trim() || defaultName(), trigger: buildTrigger(), channel: buildChannel() };
      const r = editing ? await api<{ hook: Hook }>("PATCH", `/hooks/${id}`, payload) : await api<{ hook: Hook }>("POST", "/hooks", payload);
      await reloadMe();
      go(`/hooks/${r.hook.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const scheduled = ["balance", "price", "name_watch", "daily_digest"].includes(f.type);

  return (
    <form onSubmit={submit}>
      <div className="topbar">
        <div>
          <a href={editing ? `#/hooks/${id}` : "#/hooks"} className="small">
            ← Back
          </a>
          <h1>{editing ? "Edit hook" : "New hook"}</h1>
        </div>
      </div>

      {!editing && (
        <div className="card">
          <h2>Start from a template</h2>
          <p className="muted small">Pick one to fill in the form, then adjust it. Or skip this and build your own below.</p>
          <div className="tiles" style={{ marginTop: 10 }}>
            {TEMPLATES.map((t) => (
              <button
                type="button"
                key={t.id}
                className={`tile ${picked === t.id ? "on" : ""}`}
                onClick={() => {
                  setF({ ...EMPTY_FORM, channel: f.channel, ...t.apply(me) });
                  setPicked(t.id);
                  setError(null);
                }}
              >
                <div className="t">
                  {t.icon} {t.title} <span className="badge right">{t.who}</span>
                </div>
                <div className="d">{t.desc}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="card">
        <h2>1. What should we watch?</h2>
        <div className="tiles" style={{ marginTop: 12 }}>
          {(Object.keys(TRIGGER_META) as TriggerType[]).map((t) => (
            <button type="button" key={t} className={`tile ${f.type === t ? "on" : ""}`} onClick={() => set("type", t)}>
              <div className="t">
                {TRIGGER_META[t]!.icon} {TRIGGER_META[t]!.label}
              </div>
              <div className="d">{TRIGGER_META[t]!.desc}</div>
            </button>
          ))}
        </div>

        <div style={{ marginTop: 20 }}>
          {f.type === "payment" && (
            <>
              <AddressField id="recipient" label="Recipient" value={f.recipient} onChange={(v) => set("recipient", v)} required />
              <div className="field">
                <label>Count payments in</label>
                <label className="check">
                  <input type="checkbox" checked={f.assetQIE} onChange={(e) => set("assetQIE", e.target.checked)} /> QIE (native)
                </label>
                <label className="check">
                  <input type="checkbox" checked={f.assetQUSDC} onChange={(e) => set("assetQUSDC", e.target.checked)} /> QUSDC
                </label>
                <label className="check">
                  <input type="checkbox" checked={f.anyToken} onChange={(e) => set("anyToken", e.target.checked)} /> Any other token
                </label>
                <input type="text" style={{ marginTop: 8 }} placeholder="Extra token addresses, comma separated (optional)" value={f.extraTokens} onChange={(e) => set("extraTokens", e.target.value)} />
                <div className="hint">Only the official QUSDC counts as QUSDC. Lookalike tokens are ignored unless you tick “Any other token”, and then they are flagged.</div>
              </div>
              <div className="field">
                <label htmlFor="min">Minimum amount (optional)</label>
                <input id="min" type="text" inputMode="decimal" placeholder="e.g. 1" value={f.minAmount} onChange={(e) => set("minAmount", e.target.value)} />
              </div>
            </>
          )}

          {f.type === "token_transfer" && (
            <>
              <div className="field">
                <label htmlFor="token">Token</label>
                <input id="token" type="text" placeholder="QUSDC, WQIE or a token address" value={f.token} onChange={(e) => set("token", e.target.value)} required />
              </div>
              <div className="grid two">
                <AddressField id="from" label="From (optional)" value={f.from} onChange={(v) => set("from", v)} />
                <AddressField id="to" label="To (optional)" value={f.to} onChange={(v) => set("to", v)} />
              </div>
              <div className="field">
                <label htmlFor="min2">Minimum amount (optional)</label>
                <input id="min2" type="text" inputMode="decimal" placeholder="e.g. 1000 for whale alerts" value={f.minAmount} onChange={(e) => set("minAmount", e.target.value)} />
              </div>
            </>
          )}

          {f.type === "swap" && (
            <>
              <div className="field">
                <label htmlFor="pair">QIEDEX pair</label>
                {pairs.loading ? (
                  <Spinner />
                ) : (
                  <select id="pair" value={f.pair} onChange={(e) => set("pair", e.target.value)} required>
                    <option value="">Choose a pair…</option>
                    {pairs.data?.pairs.map((p) => (
                      <option key={p.address} value={p.address}>
                        {p.token0.symbol}/{p.token1.symbol} · {shortAddr(p.address)}
                        {p.liquidityUsd ? ` · $${Math.round(p.liquidityUsd).toLocaleString()} liquidity` : ""}
                      </option>
                    ))}
                  </select>
                )}
                <div className="hint">Pairs and prices come from the official QIEDEX API.</div>
              </div>
              <div className="field">
                <label htmlFor="usd">Minimum trade size in USD (optional)</label>
                <input id="usd" type="number" min="0" step="any" placeholder="e.g. 100" value={f.minUsd} onChange={(e) => set("minUsd", e.target.value)} />
              </div>
            </>
          )}

          {f.type === "contract_event" && (
            <>
              <div className="field">
                <label htmlFor="sig">Event signatures, one per line</label>
                <textarea id="sig" style={{ minHeight: 110 }} placeholder="event Deposit(address indexed user, uint256 amount)" value={f.events} onChange={(e) => set("events", e.target.value)} required />
                <div className="hint">Copy them from the contract source. Mark indexed parameters with <code>indexed</code>. Up to 12.</div>
              </div>
              <div className="field">
                <label htmlFor="ca">Contract address {picked === "safe" || picked === "admin" ? "(your Safe / contract)" : "(optional)"}</label>
                <input
                  id="ca"
                  type="text"
                  placeholder="0x… (leave empty to match any contract)"
                  value={f.contract}
                  onChange={(e) => set("contract", e.target.value)}
                  required={picked === "safe" || picked === "admin"}
                />
              </div>
              <div className="field">
                <label htmlFor="filters">Argument filters (optional)</label>
                <textarea id="filters" placeholder={"user=0xabc…\namount=1000000"} value={f.filters} onChange={(e) => set("filters", e.target.value)} />
                <div className="hint">One per line, as name=value. A filter applies to every event that has that argument.</div>
              </div>
            </>
          )}

          {f.type === "wallet" && (
            <>
              <AddressField
                id="waddr"
                label="Wallet or contract"
                value={f.walletAddr}
                onChange={(v) => set("walletAddr", v)}
                required
                hint={picked === "failed" ? "Put your contract's address here: every call into it is reported, failed ones flagged." : undefined}
              />
              <div className="field">
                <label>Direction</label>
                {(["both", "in", "out"] as const).map((d) => (
                  <label className="check" key={d}>
                    <input type="radio" name="dir" checked={f.direction === d} onChange={() => set("direction", d)} /> {d === "both" ? "In and out" : d === "in" ? "Incoming only" : "Outgoing only"}
                  </label>
                ))}
              </div>
              <div className="field">
                <label className="check">
                  <input type="checkbox" checked={f.includeTokens} onChange={(e) => set("includeTokens", e.target.checked)} /> Token transfers
                </label>
                <label className="check">
                  <input type="checkbox" checked={f.includeFailed} onChange={(e) => set("includeFailed", e.target.checked)} /> Failed transactions
                </label>
                <div className="hint">Also reports native QIE transfers, contract calls and deployments. QIE sent by a contract (internal transfers) is not visible on QIE's public RPC.</div>
              </div>
            </>
          )}

          {f.type === "balance" && (
            <>
              <AddressField id="baddr" label="Wallet" value={f.balAddr} onChange={(v) => set("balAddr", v)} required />
              <div className="grid three">
                <div className="field">
                  <label htmlFor="basset">Asset</label>
                  <input id="basset" type="text" placeholder="QIE, QUSDC, WQIE or token address" value={f.balAsset} onChange={(e) => set("balAsset", e.target.value)} required />
                </div>
                <div className="field">
                  <label htmlFor="bdir">Alert when balance is</label>
                  <select id="bdir" value={f.balDir} onChange={(e) => set("balDir", e.target.value as FormState["balDir"])}>
                    <option value="below">below</option>
                    <option value="above">above</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="bamt">Amount</label>
                  <input id="bamt" type="text" inputMode="decimal" placeholder="e.g. 5" value={f.balAmount} onChange={(e) => set("balAmount", e.target.value)} required />
                </div>
              </div>
            </>
          )}

          {f.type === "price" && (
            <div className="grid three">
              <div className="field">
                <label htmlFor="ptok">Token</label>
                <input id="ptok" type="text" placeholder="WQIE, QIE or token address" value={f.priceToken} onChange={(e) => set("priceToken", e.target.value)} required />
              </div>
              <div className="field">
                <label htmlFor="pdir">Alert when price is</label>
                <select id="pdir" value={f.priceDir} onChange={(e) => set("priceDir", e.target.value as FormState["priceDir"])}>
                  <option value="above">above</option>
                  <option value="below">below</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="pval">USD</label>
                <input id="pval" type="number" min="0" step="any" placeholder="e.g. 0.2" value={f.priceValue} onChange={(e) => set("priceValue", e.target.value)} required />
              </div>
            </div>
          )}

          {f.type === "invoice" && (
            <p className="muted small" style={{ margin: 0 }}>
              Fires <code>invoice.paid</code> when a customer pays any of your <a href="#/payments">payment links</a>, with the link id, your
              metadata (e.g. order id), the payer and the transaction. Use a webhook to fulfil orders, or Telegram to tell your team.
            </p>
          )}
          {f.type === "name_watch" && (
            <div className="field">
              <label htmlFor="wname">QIE ID</label>
              <input id="wname" type="text" placeholder="yourname.qie" value={f.watchName} onChange={(e) => set("watchName", e.target.value)} required />
              <NameHint value={f.watchName} />
              <div className="hint">You get one alert whenever this name starts pointing somewhere else, or stops resolving.</div>
            </div>
          )}

          {f.type === "daily_digest" && (
            <div className="grid two">
              <div className="field">
                <label htmlFor="dsrc">Summarise this hook</label>
                <select id="dsrc" value={f.digestSource} onChange={(e) => set("digestSource", e.target.value)} required>
                  <option value="">Choose a hook…</option>
                  {myHooks.data?.hooks
                    .filter((h) => h.trigger.type !== "daily_digest" && h.id !== id)
                    .map((h) => (
                      <option key={h.id} value={h.id}>
                        {h.name}
                      </option>
                    ))}
                </select>
                {myHooks.data && myHooks.data.hooks.length === 0 && <div className="hint">Create a hook first (e.g. Shop payments), then summarise it.</div>}
              </div>
              <div className="field">
                <label htmlFor="dhour">Send at (UTC)</label>
                <select id="dhour" value={f.digestHour} onChange={(e) => set("digestHour", e.target.value)}>
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={String(h)}>
                      {String(h).padStart(2, "0")}:00 UTC
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {scheduled && <div className="hint">Checked every minute. Threshold alerts fire once when the condition becomes true, then re-arm when it clears.</div>}
        </div>
      </div>

      <div className="card">
        <h2>2. Where should we tell you?</h2>
        <div className="tiles" style={{ marginTop: 12 }}>
          {(Object.keys(CHANNEL_META) as ChannelType[]).map((c) => (
            <button
              type="button"
              key={c}
              className={`tile ${f.channel === c ? "on" : ""}`}
              onClick={() => set("channel", c)}
              disabled={c === "telegram" && !config.telegram.enabled}
              title={c === "telegram" && !config.telegram.enabled ? "Telegram is not configured on this server" : ""}
            >
              <div className="t">
                {CHANNEL_META[c]!.icon} {CHANNEL_META[c]!.label}
              </div>
              <div className="d">{c === "webhook" ? "Signed HTTPS POST to your server" : c === "telegram" ? "A message in a chat, group or channel" : "A message in a Discord channel"}</div>
            </button>
          ))}
        </div>
        <div style={{ marginTop: 20 }}>
          {f.channel === "webhook" && (
            <div className="field">
              <label htmlFor="url">Endpoint URL</label>
              <input id="url" type="url" placeholder="https://your-app.com/qie-webhook" value={url} onChange={(e) => setUrl(e.target.value)} required />
              <div className="hint">
                We POST JSON with a QPulse-Signature header. See <a href="#/docs">Docs</a> for how to verify it.
              </div>
            </div>
          )}
          {f.channel === "discord" && (
            <div className="field">
              <label htmlFor="durl">Discord webhook URL</label>
              <input id="durl" type="url" placeholder="https://discord.com/api/webhooks/…" value={discordUrl} onChange={(e) => setDiscordUrl(e.target.value)} required />
              <div className="hint">In Discord: Channel settings → Integrations → Webhooks → New Webhook → Copy URL.</div>
            </div>
          )}
          {f.channel === "telegram" && (
            <div className="field">
              <label htmlFor="chat">Telegram chat</label>
              {chats.data && chats.data.chats.length === 0 ? (
                <Alert kind="info">
                  No chats linked yet. <a href="#/telegram">Connect a Telegram chat</a> first, then come back.
                </Alert>
              ) : (
                <select id="chat" value={chatRef} onChange={(e) => setChatRef(e.target.value)} required>
                  {chats.data?.chats.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title} ({c.chatType})
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="field">
          <label htmlFor="name">Name</label>
          <input id="name" type="text" placeholder={defaultName()} value={f.name} onChange={(e) => set("name", e.target.value)} maxLength={80} />
        </div>
        {error && (
          <div style={{ marginBottom: 12 }}>
            <Alert kind="error">{error}</Alert>
          </div>
        )}
        <div className="row">
          <button className="btn primary" type="submit" disabled={saving}>
            {saving ? <Spinner /> : null} {editing ? "Save changes" : "Create hook"}
          </button>
          <a className="btn ghost" href={editing ? `#/hooks/${id}` : "#/hooks"}>
            Cancel
          </a>
        </div>
      </div>
    </form>
  );
}
