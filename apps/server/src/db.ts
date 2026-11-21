import { DatabaseSync } from "node:sqlite";

const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    address TEXT NOT NULL UNIQUE,
    qie_name TEXT,
    plan TEXT NOT NULL DEFAULT 'free',
    plan_expires_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE auth_nonces (
    nonce TEXT PRIMARY KEY,
    address TEXT NOT NULL,
    message TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE api_keys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  );
  CREATE TABLE telegram_link_codes (
    code TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE telegram_chats (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    chat_id TEXT NOT NULL,
    title TEXT NOT NULL,
    chat_type TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (user_id, chat_id)
  );
  CREATE TABLE hooks (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    trigger_type TEXT NOT NULL,
    trigger_config TEXT NOT NULL,
    resolved TEXT NOT NULL DEFAULT '{}',
    channel_type TEXT NOT NULL,
    channel_config TEXT NOT NULL,
    secret TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    fire_count INTEGER NOT NULL DEFAULT 0,
    last_fired_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX hooks_user ON hooks(user_id);
  CREATE TABLE events (
    id TEXT PRIMARY KEY,
    hook_id TEXT NOT NULL REFERENCES hooks(id) ON DELETE CASCADE,
    dedupe_key TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    block_number INTEGER,
    tx_hash TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (hook_id, dedupe_key)
  );
  CREATE INDEX events_hook ON events(hook_id, created_at DESC);
  CREATE TABLE deliveries (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    hook_id TEXT NOT NULL REFERENCES hooks(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    last_error TEXT,
    response_code INTEGER,
    latency_ms INTEGER,
    created_at INTEGER NOT NULL,
    delivered_at INTEGER
  );
  CREATE INDEX deliveries_due ON deliveries(status, next_attempt_at);
  CREATE INDEX deliveries_hook ON deliveries(hook_id, created_at DESC);
  CREATE TABLE usage (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    month TEXT NOT NULL,
    events INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, month)
  );
  CREATE TABLE kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE subscriptions (
    tx_hash TEXT NOT NULL,
    log_index INTEGER NOT NULL,
    address TEXT NOT NULL,
    plan_id INTEGER NOT NULL,
    periods INTEGER NOT NULL,
    amount TEXT NOT NULL,
    paid_until INTEGER NOT NULL,
    block_number INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (tx_hash, log_index)
  );
  `,
  `
  CREATE TABLE trigger_state (
    hook_id TEXT PRIMARY KEY REFERENCES hooks(id) ON DELETE CASCADE,
    state TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    website TEXT,
    contracts TEXT NOT NULL,
    verified_by TEXT,
    public INTEGER NOT NULL DEFAULT 1,
    backfill_status TEXT NOT NULL DEFAULT 'pending',
    backfill_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE project_txs (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    tx_hash TEXT NOT NULL,
    contract TEXT NOT NULL,
    wallet TEXT NOT NULL,
    block_number INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    ok INTEGER NOT NULL,
    value TEXT NOT NULL DEFAULT '0',
    method TEXT,
    PRIMARY KEY (project_id, tx_hash)
  ) WITHOUT ROWID;
  CREATE INDEX project_txs_ts ON project_txs (project_id, ts);
  CREATE INDEX project_txs_wallet ON project_txs (project_id, wallet);
  `,
  `
  CREATE TABLE invoices (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient TEXT NOT NULL,
    recipient_name TEXT,
    token TEXT NOT NULL,
    symbol TEXT NOT NULL,
    decimals INTEGER NOT NULL,
    amount_raw TEXT NOT NULL,
    base_amount_raw TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    metadata TEXT NOT NULL DEFAULT '{}',
    success_url TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    paid_at INTEGER,
    paid_tx TEXT,
    paid_from TEXT,
    paid_amount_raw TEXT,
    paid_block INTEGER
  );
  CREATE INDEX invoices_open ON invoices (status, recipient);
  CREATE INDEX invoices_user ON invoices (user_id, created_at);
  `,
  `
  CREATE TABLE latency_samples (
    series TEXT NOT NULL,
    at_ms INTEGER NOT NULL,
    ms INTEGER NOT NULL
  );
  CREATE INDEX latency_series ON latency_samples (series, at_ms);
  CREATE TABLE attestations (
    day INTEGER PRIMARY KEY,
    root TEXT NOT NULL,
    leaves TEXT NOT NULL,
    tx_hash TEXT,
    block_number INTEGER,
    created_at INTEGER NOT NULL
  );
  `,
  `
  ALTER TABLE attestations ADD COLUMN snapshot_block INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE attestations ADD COLUMN snapshot_ts INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE attestations ADD COLUMN status TEXT NOT NULL DEFAULT 'computed';
  ALTER TABLE attestations ADD COLUMN error TEXT;
  `,
  `
  ALTER TABLE attestations ADD COLUMN sent_at INTEGER;
  ALTER TABLE projects ADD COLUMN backfill_truncated INTEGER NOT NULL DEFAULT 0;
  `,
  `
  CREATE TABLE products (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    amount TEXT NOT NULL,
    token TEXT NOT NULL,
    recipient TEXT NOT NULL,
    recipient_name TEXT,
    unlock_content TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    sold INTEGER NOT NULL DEFAULT 0,
    last_sold_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX products_user ON products (user_id, created_at);
  ALTER TABLE invoices ADD COLUMN product_id TEXT;
  ALTER TABLE invoices ADD COLUMN redeemed_at INTEGER;
  CREATE INDEX invoices_product ON invoices (product_id, status);
  `,
];

export type Db = DatabaseSync;

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = db.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined;
  let version = row?.version ?? 0;
  if (!row) db.prepare("INSERT INTO schema_version (version) VALUES (0)").run();
  while (version < MIGRATIONS.length) {
    const sql = MIGRATIONS[version]!;
    tx(db, () => {
      db.exec(sql);
      db.prepare("UPDATE schema_version SET version = ?").run(version + 1);
    });
    version++;
  }
  return db;
}

/** Run `fn` inside a transaction. node:sqlite is synchronous, so this is atomic. */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function kvGet(db: Db, key: string): string | null {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function kvSet(db: Db, key: string, value: string): void {
  db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}
