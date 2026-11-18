import { useState } from "react";
import { api } from "../api.ts";
import { Alert, Copy, timeAgo, useAsync } from "../ui.tsx";

type Key = { id: string; name: string; prefix: string; createdAt: number; lastUsedAt: number | null };

export function Keys() {
  const keys = useAsync(() => api<{ keys: Key[] }>("GET", "/keys"), []);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <div>
      <div className="topbar">
        <div>
          <h1>API keys</h1>
          <p className="muted" style={{ margin: 0 }}>
            Create and manage hooks from your own code with the <code>@qiehooks/sdk</code> package or plain HTTP.
          </p>
        </div>
      </div>

      <div className="card">
        <form
          className="row"
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            try {
              const r = await api<{ key: string }>("POST", "/keys", { name: name || "API key" });
              setCreated(r.key);
              setName("");
              await keys.reload();
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            }
          }}
        >
          <input type="text" placeholder="Key name, e.g. production server" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1, minWidth: 220 }} />
          <button className="btn primary" type="submit">
            Create key
          </button>
        </form>
        {error && (
          <div style={{ marginTop: 12 }}>
            <Alert kind="error">{error}</Alert>
          </div>
        )}
        {created && (
          <div style={{ marginTop: 14 }}>
            <Alert kind="ok">
              <div style={{ marginBottom: 8 }}>Copy this key now. It is shown only once.</div>
              <div className="row">
                <code className="mono" style={{ wordBreak: "break-all" }}>
                  {created}
                </code>
                <Copy text={created} />
              </div>
            </Alert>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Your keys</h2>
        {keys.data && keys.data.keys.length === 0 && <p className="muted">No keys yet.</p>}
        {keys.data && keys.data.keys.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Key</th>
                <th>Created</th>
                <th>Last used</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {keys.data.keys.map((k) => (
                <tr key={k.id}>
                  <td>{k.name}</td>
                  <td className="mono">{k.prefix}…</td>
                  <td>{timeAgo(k.createdAt)}</td>
                  <td>{timeAgo(k.lastUsedAt)}</td>
                  <td style={{ textAlign: "right" }}>
                    <button
                      className="btn sm danger"
                      onClick={async () => {
                        if (!confirm(`Revoke “${k.name}”? Code using it stops working.`)) return;
                        await api("DELETE", `/keys/${k.id}`);
                        await keys.reload();
                      }}
                    >
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>Use it from an AI agent (MCP)</h2>
        <p className="muted small">Give Claude or any MCP client tools to take payments and watch QIE. Paste your key in place of qh_live_…</p>
        <pre className="code">{`claude mcp add --transport http qiehooks ${window.location.origin}/api/mcp \\
  --header "Authorization: Bearer qh_live_…"`}</pre>
        <p className="small muted" style={{ marginTop: 10 }}>
          Then ask, for example: “Create a 5 QUSDC payment link for the logo design and tell me when it's paid.” More in <a href="#/docs">Docs</a>.
        </p>
      </div>

      <div className="card">
        <h2>Quick start</h2>
        <pre className="code">{`npm install @qiehooks/sdk

import { QieHooks } from "@qiehooks/sdk";
const qh = new QieHooks({ apiKey: process.env.QIEHOOKS_KEY, baseUrl: "${window.location.origin}" });

// Telegram/Discord/webhook alert when shop.qie is paid at least 1 QUSDC or QIE
await qh.onPayment("shop.qie", { url: "https://shop.example.com/qie-webhook" }, { minAmount: "1" });

// Any contract event, decoded
await qh.hooks.create({
  name: "Vault deposits",
  trigger: { type: "contract_event", config: { address: "0x…", event: "event Deposit(address indexed user, uint256 amount)" } },
  channel: { type: "webhook", config: { url: "https://example.com/hook" } },
});`}</pre>
        <p className="small muted" style={{ marginTop: 10 }}>
          Plain HTTP works too: send <code>Authorization: Bearer qh_live_…</code> to <code>{window.location.origin}/api/hooks</code>.
        </p>
      </div>
    </div>
  );
}
