import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * SQLite via node:sqlite -- built into Node 22.5+, so there is no native module
 * to compile. That matters for ARM hosts (Oracle Cloud, Raspberry Pi) where
 * better-sqlite3 prebuilds are the usual deployment papercut.
 */
export function openDatabase(dataDir: string): DatabaseSync {
  const dir = isAbsolute(dataDir) ? dataDir : resolve(process.cwd(), dataDir);
  const file = join(dir, "bot.sqlite");
  mkdirSync(dirname(file), { recursive: true });

  const db = new DatabaseSync(file);
  // WAL survives an unclean kill far better than the default rollback journal,
  // which matters when the process is restarted by systemd on failure.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}
