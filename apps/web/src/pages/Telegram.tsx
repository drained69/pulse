import { useState } from "react";
import { api, type TgChat } from "../api.ts";
import { useApp } from "../App.tsx";
import { Alert, Copy, Spinner, timeAgo, useAsync } from "../ui.tsx";

export function TelegramPage() {
  const { config } = useApp();
  const chats = useAsync(() => api<{ chats: TgChat[] }>("GET", "/telegram/chats"), [], 3000);
  const [link, setLink] = useState<{ code: string; deepLink: string | null; expiresAt: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bot = config.telegram.botUsername;

  if (!config.telegram.enabled) {
    return (
      <div>
        <h1>Telegram</h1>
        <Alert kind="warn">Telegram alerts are currently unavailable. You can still send alerts to Discord or a webhook.</Alert>
      </div>
    );
  }

  return (
    <div>
      <div className="topbar">
        <div>
          <h1>Telegram</h1>
          <p className="muted" style={{ margin: 0 }}>
            Send alerts to yourself, a staff group or a public channel{bot ? <> through <b>@{bot}</b></> : null}.
          </p>
        </div>
        <button
          className="btn primary"
          onClick={async () => {
            setError(null);
            try {
              setLink(await api("POST", "/telegram/link"));
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            }
          }}
        >
          + Connect a chat
        </button>
      </div>
      {error && <Alert kind="error">{error}</Alert>}

      {link && (
        <div className="card">
          <h2>Link a chat</h2>
          <div className="grid two" style={{ marginTop: 12 }}>
            <div>
              <h3>Just you</h3>
              <p className="muted small">Open the bot and press Start.</p>
              {link.deepLink ? (
                <a className="btn primary" href={link.deepLink} target="_blank" rel="noreferrer">
                  Open @{bot} in Telegram
                </a>
              ) : (
                <p className="small">Send <code>/start {link.code}</code> to the bot.</p>
              )}
            </div>
            <div>
              <h3>A group or channel</h3>
              <p className="muted small">
                Add {bot ? <b>@{bot}</b> : "the bot"} to the group (for a channel, as an admin who can post), then send this message there:
              </p>
              <div className="row">
                <code className="mono" style={{ padding: "8px 10px", background: "var(--panel-2)", borderRadius: 8 }}>
                  /link {link.code}
                </code>
                <Copy text={`/link ${link.code}`} />
              </div>
            </div>
          </div>
          <p className="small faint" style={{ marginTop: 14 }}>
            The code works once and expires {new Date(link.expiresAt * 1000).toLocaleTimeString()}. This page updates when the chat is linked.
          </p>
        </div>
      )}

      <div className="card">
        <h2>Linked chats</h2>
        {chats.error && <Alert kind="error">{chats.error}</Alert>}
        {chats.loading && !chats.data && <Spinner />}
        {chats.data && chats.data.chats.length === 0 && <p className="muted">No chats yet.</p>}
        {chats.data && chats.data.chats.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Chat</th>
                  <th>Type</th>
                  <th>Linked</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {chats.data.chats.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <b>{c.title}</b>
                    </td>
                    <td>{c.chatType}</td>
                    <td>{timeAgo(c.createdAt)}</td>
                    <td style={{ textAlign: "right" }}>
                      <button
                        className="btn sm danger"
                        onClick={async () => {
                          if (!confirm(`Unlink ${c.title}? Hooks sending there will stop.`)) return;
                          try {
                            setError(null);
                            await api("DELETE", `/telegram/chats/${c.id}`);
                            await chats.reload();
                          } catch (e) {
                            setError(e instanceof Error ? e.message : String(e));
                          }
                        }}
                      >
                        Unlink
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
