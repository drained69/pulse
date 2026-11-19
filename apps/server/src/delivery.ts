import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import type { Metrics } from "./metrics.ts";
import { describe, type EventPayload } from "./payload.ts";
import { EVENT_ID_HEADER, EVENT_TYPE_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER, signatureHeader } from "./signing.ts";
import { assertPublicUrl, postWebhook } from "./ssrf.ts";
import { Telegram, TelegramError } from "./telegram.ts";
import { errMsg, log, nowSec, sleep } from "./util.ts";

/** Seconds to wait before attempt N+1. 7 attempts over ~8.5 hours. */
export const BACKOFF_SEC = [10, 60, 300, 1800, 7200, 21600];
export const MAX_ATTEMPTS = BACKOFF_SEC.length + 1;

type DeliveryRow = {
  id: string;
  event_id: string;
  hook_id: string;
  attempts: number;
  payload: string;
  channel_type: string;
  channel_config: string;
  secret: string;
  user_id: string;
};

export type AttemptResult = { ok: boolean; code: number | null; error: string | null; permanent?: boolean; latencyMs: number };

export class DeliveryWorker {
  private cfg: Config;
  private db: Db;
  private telegram: Telegram;
  /** Block → delivered latency samples (first attempts of live chain events only). */
  metrics: Metrics | null = null;
  private inFlight = new Set<string>();
  private stopped = false;
  private wake: (() => void) | null = null;

  constructor(cfg: Config, db: Db, telegram: Telegram) {
    this.cfg = cfg;
    this.db = db;
    this.telegram = telegram;
  }

  /** Nudge the worker after new deliveries are queued. */
  notify(): void {
    this.wake?.();
  }

  async attempt(channelType: string, channelConfig: Record<string, string>, payload: EventPayload, body: string, secret: string, userId: string): Promise<AttemptResult> {
    const started = performance.now();
    const ms = () => Math.round(performance.now() - started);
    try {
      if (channelType === "webhook") {
        const url = channelConfig.url!;
        await assertPublicUrl(url, this.cfg.allowPrivateWebhooks);
        const ts = nowSec();
        const status = await postWebhook(
          url,
          {
            "content-type": "application/json",
            "user-agent": "QPulse/1.0 (+https://github.com/drained69/pulse)",
            [SIGNATURE_HEADER]: signatureHeader(secret, ts, body),
            [TIMESTAMP_HEADER]: String(ts),
            [EVENT_ID_HEADER]: payload.id,
            [EVENT_TYPE_HEADER]: payload.type,
          },
          body,
          this.cfg.deliveryTimeoutMs,
          this.cfg.allowPrivateWebhooks,
        );
        const ok = status >= 200 && status < 300;
        return { ok, code: status, error: ok ? null : `HTTP ${status}`, latencyMs: ms() };
      }
      if (channelType === "telegram") {
        const chat = this.db.prepare("SELECT chat_id FROM telegram_chats WHERE id = ? AND user_id = ?").get(channelConfig.chatRef!, userId) as
          | { chat_id: string }
          | undefined;
        if (!chat) return { ok: false, code: null, error: "Telegram chat is no longer linked", permanent: true, latencyMs: ms() };
        if (!this.telegram.enabled) return { ok: false, code: null, error: "Telegram bot is not configured on this server", latencyMs: ms() };
        await this.telegram.sendEvent(chat.chat_id, payload);
        return { ok: true, code: 200, error: null, latencyMs: ms() };
      }
      if (channelType === "discord") {
        const { title, lines, emoji } = describe(payload);
        const res = await fetch(`${channelConfig.url}?wait=true`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            username: "Q-Pulse",
            embeds: [
              {
                title: `${emoji} ${title}`.slice(0, 256),
                description: lines.join("\n").slice(0, 4000),
                url: payload.type === "test" ? undefined : (payload.tx?.explorerUrl ?? payload.link),
                color: 0x7c5cff,
                footer: { text: payload.hook.name },
                timestamp: payload.createdAt,
              },
            ],
          }),
          signal: AbortSignal.timeout(this.cfg.deliveryTimeoutMs),
        });
        const ok = res.status >= 200 && res.status < 300;
        return { ok, code: res.status, error: ok ? null : `HTTP ${res.status}`, permanent: res.status === 404 || res.status === 401, latencyMs: ms() };
      }
      return { ok: false, code: null, error: `Unknown channel ${channelType}`, permanent: true, latencyMs: ms() };
    } catch (e) {
      const permanent = e instanceof TelegramError && (e.status === 400 || e.status === 403);
      return { ok: false, code: e instanceof TelegramError ? e.status : null, error: errMsg(e), permanent, latencyMs: ms() };
    }
  }

  private async runOne(d: DeliveryRow): Promise<void> {
    const payload = JSON.parse(d.payload) as EventPayload;
    const r = await this.attempt(d.channel_type, JSON.parse(d.channel_config), payload, d.payload, d.secret, d.user_id);
    const attempts = d.attempts + 1;
    if (r.ok) {
      this.db
        .prepare("UPDATE deliveries SET status='success', attempts=?, response_code=?, last_error=NULL, latency_ms=?, delivered_at=? WHERE id=?")
        .run(attempts, r.code, r.latencyMs, nowSec(), d.id);
      // Retries measure our backoff schedule, not pipeline speed; test events have no block.
      if (attempts === 1 && payload.tx?.blockNumber) this.metrics?.record("deliver", payload.tx.timestamp);
      return;
    }
    const giveUp = r.permanent || attempts >= MAX_ATTEMPTS;
    const next = nowSec() + (BACKOFF_SEC[attempts - 1] ?? 0);
    this.db
      .prepare("UPDATE deliveries SET status=?, attempts=?, response_code=?, last_error=?, latency_ms=?, next_attempt_at=? WHERE id=?")
      .run(giveUp ? "failed" : "pending", attempts, r.code, (r.error ?? "").slice(0, 500), r.latencyMs, next, d.id);
    log.info("delivery failed", { delivery: d.id, attempts, giveUp, error: r.error });
  }

  private due(limit: number): DeliveryRow[] {
    return this.db
      .prepare(
        `SELECT d.id, d.event_id, d.hook_id, d.attempts, e.payload, h.channel_type, h.channel_config, h.secret, h.user_id
         FROM deliveries d JOIN events e ON e.id = d.event_id JOIN hooks h ON h.id = d.hook_id
         WHERE d.status = 'pending' AND d.next_attempt_at <= ?
         ORDER BY d.next_attempt_at ASC LIMIT ?`,
      )
      .all(nowSec(), limit) as DeliveryRow[];
  }

  /** Process everything due right now. Exposed for tests. */
  async drain(): Promise<number> {
    let total = 0;
    for (;;) {
      const free = this.cfg.deliveryConcurrency - this.inFlight.size;
      if (free <= 0) break;
      const batch = this.due(free + this.inFlight.size).filter((d) => !this.inFlight.has(d.id)).slice(0, free);
      if (batch.length === 0) break;
      total += batch.length;
      await Promise.all(
        batch.map(async (d) => {
          this.inFlight.add(d.id);
          try {
            await this.runOne(d);
          } catch (e) {
            log.error("delivery crashed", { delivery: d.id, error: errMsg(e) });
          } finally {
            this.inFlight.delete(d.id);
          }
        }),
      );
    }
    return total;
  }

  async run(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.drain();
      } catch (e) {
        log.error("delivery loop error", { error: errMsg(e) });
      }
      await Promise.race([sleep(1000), new Promise<void>((r) => (this.wake = r))]);
      this.wake = null;
    }
  }

  stop(): void {
    this.stopped = true;
    this.wake?.();
  }
}
