import type { Config } from "./config.ts";
import { type Db, kvGet, kvSet } from "./db.ts";
import { describe, type EventPayload } from "./payload.ts";
import { errMsg, escapeHtml, log, newId, nowSec, randomToken, sleep } from "./util.ts";

type TgChat = { id: number; type: string; title?: string; username?: string; first_name?: string };
type TgUpdate = {
  update_id: number;
  message?: { chat: TgChat; text?: string };
  channel_post?: { chat: TgChat; text?: string };
  my_chat_member?: unknown;
};

export class TelegramError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Telegram Bot API client and the `/start CODE` chat-linking flow. Long polling, so no public webhook is needed. */
export class Telegram {
  private cfg: Config;
  private db: Db;
  private stopped = false;

  constructor(cfg: Config, db: Db) {
    this.cfg = cfg;
    this.db = db;
  }

  get enabled(): boolean {
    return Boolean(this.cfg.telegramBotToken);
  }

  private async api<T>(method: string, body: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
    const res = await fetch(`${this.cfg.telegramApiBase}/bot${this.cfg.telegramBotToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
    if (!json.ok) throw new TelegramError(res.status, json.description ?? `HTTP ${res.status}`);
    return json.result as T;
  }

  async sendMessage(chatId: string, html: string, buttonUrl?: string, buttonText = "View on explorer"): Promise<void> {
    await this.api("sendMessage", {
      chat_id: chatId,
      text: html,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(buttonUrl ? { reply_markup: { inline_keyboard: [[{ text: buttonText, url: buttonUrl }]] } } : {}),
    });
  }

  async sendEvent(chatId: string, p: EventPayload): Promise<void> {
    const { title, lines, emoji } = describe(p);
    const body = [`${emoji} <b>${escapeHtml(title)}</b>`, ...lines.map((l) => escapeHtml(l)), `<i>${escapeHtml(p.hook.name)}</i>`].join("\n");
    const link = p.type === "test" ? undefined : (p.tx?.explorerUrl ?? p.link);
    await this.sendMessage(chatId, body, link, p.tx ? "View on explorer" : "Open");
  }

  /** A one-time code the user sends to the bot. Valid for 15 minutes. */
  createLinkCode(userId: string): { code: string; deepLink: string | null; expiresAt: number } {
    const code = randomToken(9).replace(/[-_]/g, "x");
    const expiresAt = nowSec() + 15 * 60;
    this.db.prepare("DELETE FROM telegram_link_codes WHERE expires_at < ?").run(nowSec());
    this.db.prepare("INSERT INTO telegram_link_codes (code, user_id, expires_at) VALUES (?, ?, ?)").run(code, userId, expiresAt);
    const deepLink = this.cfg.telegramBotUsername ? `https://t.me/${this.cfg.telegramBotUsername}?start=${code}` : null;
    return { code, deepLink, expiresAt };
  }

  /** Handle `/start CODE` or `/link CODE` from a private chat, group or channel. Returns the reply text. */
  handleText(chat: TgChat, text: string): string | null {
    const m = text.trim().match(/^\/(?:start|link)(?:@\w+)?(?:\s+([\w-]+))?/);
    if (!m) return null;
    const code = m[1];
    if (!code) {
      return "👋 This is the QIE Hooks bot. Open your QIE Hooks dashboard, click “Connect Telegram” and send the code here as <code>/link CODE</code>.";
    }
    const row = this.db.prepare("SELECT user_id, expires_at FROM telegram_link_codes WHERE code = ?").get(code) as
      | { user_id: string; expires_at: number }
      | undefined;
    if (!row || row.expires_at < nowSec()) return "⚠️ That code is invalid or expired. Create a new one in the dashboard.";
    const title = chat.title ?? (chat.username ? `@${chat.username}` : (chat.first_name ?? String(chat.id)));
    this.db
      .prepare(
        `INSERT INTO telegram_chats (id, user_id, chat_id, title, chat_type, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, chat_id) DO UPDATE SET title = excluded.title`,
      )
      .run(newId("tgc"), row.user_id, String(chat.id), title, chat.type, nowSec());
    this.db.prepare("DELETE FROM telegram_link_codes WHERE code = ?").run(code);
    return `✅ Linked <b>${escapeHtml(title)}</b> to QIE Hooks. Pick it as the destination when you create a hook.`;
  }

  async processUpdate(u: TgUpdate): Promise<void> {
    const msg = u.message ?? u.channel_post;
    if (!msg?.text) return;
    const reply = this.handleText(msg.chat, msg.text);
    if (reply) await this.sendMessage(String(msg.chat.id), reply).catch((e) => log.warn("telegram reply failed", { error: errMsg(e) }));
  }

  async run(): Promise<void> {
    if (!this.enabled) {
      log.info("telegram disabled (TELEGRAM_BOT_TOKEN not set)");
      return;
    }
    try {
      const me = await this.api<{ username: string }>("getMe", {});
      if (!this.cfg.telegramBotUsername) this.cfg.telegramBotUsername = me.username;
      log.info("telegram bot online", { username: me.username });
    } catch (e) {
      log.error("telegram getMe failed, bot disabled", { error: errMsg(e) });
      return;
    }
    let offset = Number(kvGet(this.db, "telegram_offset") ?? "0");
    while (!this.stopped) {
      try {
        const updates = await this.api<TgUpdate[]>(
          "getUpdates",
          { offset, timeout: 25, allowed_updates: ["message", "channel_post"] },
          35_000,
        );
        for (const u of updates) {
          offset = u.update_id + 1;
          await this.processUpdate(u);
        }
        if (updates.length) kvSet(this.db, "telegram_offset", String(offset));
      } catch (e) {
        log.warn("telegram polling error", { error: errMsg(e) });
        await sleep(5000);
      }
    }
  }

  stop(): void {
    this.stopped = true;
  }
}
