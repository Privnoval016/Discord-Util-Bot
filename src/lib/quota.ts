import type { DatabaseSync } from "node:sqlite";

/**
 * Local guard on GitHub's org-invitation cap (50 per 24h, or 500 if the org is
 * on a paid plan or older than a month).
 *
 * We count locally and refuse below the real ceiling because GitHub reports the
 * breach as a bare 422 that is indistinguishable from other validation errors.
 * Better to stop ourselves with a clear message than to guess at theirs.
 */
export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function createQuotaStore(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS invite_quota (
      org   TEXT    NOT NULL,
      day   TEXT    NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (org, day)
    )
  `);

  const readStmt = db.prepare("SELECT count FROM invite_quota WHERE org = ? AND day = ?");
  const bumpStmt = db.prepare(`
    INSERT INTO invite_quota (org, day, count) VALUES (?, ?, 1)
    ON CONFLICT(org, day) DO UPDATE SET count = count + 1
  `);

  return {
    used(org: string, day = utcDay()): number {
      const row = readStmt.get(org, day) as { count: number } | undefined;
      return row?.count ?? 0;
    },

    remaining(org: string, limit: number, day = utcDay()): number {
      return Math.max(0, limit - this.used(org, day));
    },

    /** Call only after GitHub actually accepted the invitation. */
    record(org: string, day = utcDay()): void {
      bumpStmt.run(org, day);
    },
  };
}

export type QuotaStore = ReturnType<typeof createQuotaStore>;

/** UTC midnight, when GitHub's daily window and our counter both roll over. */
export function nextResetUnix(now: Date = new Date()): number {
  const reset = new Date(now);
  reset.setUTCHours(24, 0, 0, 0);
  return Math.floor(reset.getTime() / 1000);
}
