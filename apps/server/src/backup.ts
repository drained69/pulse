import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./db.ts";

const NAME = /^qpulse-\d{4}-\d{2}-\d{2}\.db$/;

/**
 * Write a consistent copy of the database to `dir` once per UTC day (`VACUUM INTO` takes a
 * snapshot without stopping writers in WAL mode) and keep the newest `keep` copies.
 * Returns the file written, or null when today's copy already exists or backups are off.
 * These copies sit on the same volume: they protect against bad writes and corruption, not
 * against losing the volume. Download them regularly for an off-site copy.
 */
export function backupDatabase(db: Db, dir: string, keep: number, now = new Date()): string | null {
  if (!dir || keep <= 0) return null;
  mkdirSync(dir, { recursive: true });
  const name = `qpulse-${now.toISOString().slice(0, 10)}.db`;
  if (readdirSync(dir).includes(name)) return null;
  const path = join(dir, name);
  db.prepare("VACUUM INTO ?").run(path);
  const copies = readdirSync(dir).filter((f) => NAME.test(f)).sort();
  for (const f of copies.slice(0, Math.max(0, copies.length - keep))) rmSync(join(dir, f));
  return path;
}
