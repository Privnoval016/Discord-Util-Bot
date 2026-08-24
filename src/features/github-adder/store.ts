import type { DatabaseSync } from "node:sqlite";

export type ApprovalMode = "moderator" | "auto";
export type RequestStatus = "pending" | "approved" | "denied" | "sent" | "failed";

export interface GuildConfig {
  guild_id: string;
  mod_role_id: string;
  audit_channel_id: string | null;
}

export interface AdderChannel {
  channel_id: string;
  guild_id: string;
  org: string;
  approval_mode: ApprovalMode;
  auto_mode_expires_at: number | null;
  last_scanned_message_id: string | null;
  enabled: number;
  created_by: string;
  created_at: number;
}

export interface InviteRequest {
  id: number;
  guild_id: string;
  channel_id: string;
  message_id: string | null;
  discord_user_id: string;
  github_login: string;
  github_user_id: number;
  org: string;
  status: RequestStatus;
  dry_run: number;
  decided_by: string | null;
  decided_at: number | null;
  error: string | null;
  created_at: number;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS guild_config (
    guild_id         TEXT PRIMARY KEY,
    mod_role_id      TEXT NOT NULL,
    audit_channel_id TEXT
  );

  CREATE TABLE IF NOT EXISTS adder_channel (
    channel_id           TEXT PRIMARY KEY,
    guild_id             TEXT NOT NULL,
    org                  TEXT NOT NULL,
    approval_mode        TEXT NOT NULL DEFAULT 'moderator'
                           CHECK (approval_mode IN ('moderator', 'auto')),
    auto_mode_expires_at INTEGER,
    enabled              INTEGER NOT NULL DEFAULT 1,
    created_by           TEXT NOT NULL,
    created_at           INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS invite_request (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id        TEXT NOT NULL,
    channel_id      TEXT NOT NULL,
    message_id      TEXT,
    discord_user_id TEXT NOT NULL,
    github_login    TEXT NOT NULL,
    github_user_id  INTEGER NOT NULL,
    org             TEXT NOT NULL,
    status          TEXT NOT NULL
                      CHECK (status IN ('pending','approved','denied','sent','failed')),
    dry_run         INTEGER NOT NULL DEFAULT 0,
    decided_by      TEXT,
    decided_at      INTEGER,
    error           TEXT,
    created_at      INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_request_pending
    ON invite_request (org, github_user_id, status);
  CREATE INDEX IF NOT EXISTS idx_request_user
    ON invite_request (discord_user_id, created_at);
`;

/**
 * Adds a column only if it is missing. SQLite has no ADD COLUMN IF NOT EXISTS,
 * and this runs on every boot against databases created before the column did.
 */
function ensureColumn(db: DatabaseSync, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

export function createStore(db: DatabaseSync) {
  db.exec(SCHEMA);
  ensureColumn(db, "invite_request", "dry_run", "dry_run INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "adder_channel", "last_scanned_message_id", "last_scanned_message_id TEXT");

  const q = {
    getGuild: db.prepare("SELECT * FROM guild_config WHERE guild_id = ?"),
    upsertGuild: db.prepare(`
      INSERT INTO guild_config (guild_id, mod_role_id, audit_channel_id)
      VALUES (?, ?, ?)
      ON CONFLICT(guild_id) DO UPDATE SET
        mod_role_id = excluded.mod_role_id,
        audit_channel_id = excluded.audit_channel_id
    `),

    getChannel: db.prepare("SELECT * FROM adder_channel WHERE channel_id = ? AND enabled = 1"),
    listChannels: db.prepare("SELECT * FROM adder_channel WHERE guild_id = ? AND enabled = 1"),
    upsertChannel: db.prepare(`
      INSERT INTO adder_channel
        (channel_id, guild_id, org, approval_mode, auto_mode_expires_at, enabled, created_by, created_at)
      VALUES (?, ?, ?, 'moderator', NULL, 1, ?, ?)
      ON CONFLICT(channel_id) DO UPDATE SET
        org = excluded.org, enabled = 1
    `),
    disableChannel: db.prepare("UPDATE adder_channel SET enabled = 0 WHERE channel_id = ?"),
    setMode: db.prepare(
      "UPDATE adder_channel SET approval_mode = ?, auto_mode_expires_at = ? WHERE channel_id = ?",
    ),
    setCursor: db.prepare(
      "UPDATE adder_channel SET last_scanned_message_id = ? WHERE channel_id = ?",
    ),
    allEnabledChannels: db.prepare("SELECT * FROM adder_channel WHERE enabled = 1"),

    insertRequest: db.prepare(`
      INSERT INTO invite_request
        (guild_id, channel_id, message_id, discord_user_id, github_login, github_user_id,
         org, status, dry_run, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    getRequest: db.prepare("SELECT * FROM invite_request WHERE id = ?"),
    setRequestMessage: db.prepare("UPDATE invite_request SET message_id = ? WHERE id = ?"),
    openForGithubUser: db.prepare(`
      SELECT * FROM invite_request
      WHERE org = ? AND github_user_id = ? AND dry_run = ?
        AND status IN ('pending','approved','sent')
      LIMIT 1
    `),
    openByLogin: db.prepare(`
      SELECT * FROM invite_request
      WHERE org = ? AND github_login = ? COLLATE NOCASE
        AND status IN ('pending','approved','sent')
      ORDER BY id DESC LIMIT 1
    `),
    lastRequestByUser: db.prepare(`
      SELECT created_at FROM invite_request
      WHERE discord_user_id = ? ORDER BY created_at DESC LIMIT 1
    `),
    countOpenByUser: db.prepare(`
      SELECT COUNT(*) AS n FROM invite_request
      WHERE discord_user_id = ? AND status = 'pending'
    `),
    /**
     * Guarded transition. The `WHERE status = 'pending'` clause is what makes
     * double-clicking Approve safe: only the first update touches a row, and
     * the caller checks `changes` before calling GitHub.
     */
    decide: db.prepare(`
      UPDATE invite_request
      SET status = ?, decided_by = ?, decided_at = ?
      WHERE id = ? AND status = 'pending'
    `),
    finish: db.prepare("UPDATE invite_request SET status = ?, error = ? WHERE id = ?"),
    expireStale: db.prepare(`
      UPDATE invite_request
      SET status = 'failed', error = 'expired without a decision'
      WHERE status = 'pending' AND created_at < ?
    `),
    listPending: db.prepare(`
      SELECT * FROM invite_request
      WHERE guild_id = ? AND status = 'pending'
      ORDER BY created_at ASC LIMIT 25
    `),
  };

  return {
    getGuildConfig(guildId: string): GuildConfig | null {
      return (q.getGuild.get(guildId) as GuildConfig | undefined) ?? null;
    },
    setGuildConfig(guildId: string, modRoleId: string, auditChannelId: string | null): void {
      q.upsertGuild.run(guildId, modRoleId, auditChannelId);
    },

    getAdderChannel(channelId: string): AdderChannel | null {
      return (q.getChannel.get(channelId) as AdderChannel | undefined) ?? null;
    },
    listAdderChannels(guildId: string): AdderChannel[] {
      return q.listChannels.all(guildId) as unknown as AdderChannel[];
    },
    addAdderChannel(channelId: string, guildId: string, org: string, createdBy: string): void {
      q.upsertChannel.run(channelId, guildId, org, createdBy, Date.now());
    },
    disableAdderChannel(channelId: string): void {
      q.disableChannel.run(channelId);
    },
    setApprovalMode(channelId: string, mode: ApprovalMode, expiresAt: number | null): void {
      q.setMode.run(mode, expiresAt, channelId);
    },
    /** Records how far the catch-up scan has read in this channel. */
    setScanCursor(channelId: string, messageId: string): void {
      q.setCursor.run(messageId, channelId);
    },
    listAllEnabledChannels(): AdderChannel[] {
      return q.allEnabledChannels.all() as unknown as AdderChannel[];
    },

    createRequest(input: {
      guildId: string;
      channelId: string;
      messageId: string | null;
      discordUserId: string;
      githubLogin: string;
      githubUserId: number;
      org: string;
      status: RequestStatus;
      dryRun: boolean;
    }): number {
      const res = q.insertRequest.run(
        input.guildId,
        input.channelId,
        input.messageId,
        input.discordUserId,
        input.githubLogin,
        input.githubUserId,
        input.org,
        input.status,
        input.dryRun ? 1 : 0,
        Date.now(),
      );
      return Number(res.lastInsertRowid);
    },
    getRequest(id: number): InviteRequest | null {
      return (q.getRequest.get(id) as InviteRequest | undefined) ?? null;
    },
    attachMessage(id: number, messageId: string): void {
      q.setRequestMessage.run(messageId, id);
    },
    /**
     * Dry-run and real records are separate ledgers. A dry run never contacted
     * GitHub, so its bookkeeping must not block a real invite (and vice versa).
     */
    findOpenRequestFor(org: string, githubUserId: number, dryRun: boolean): InviteRequest | null {
      return (
        (q.openForGithubUser.get(org, githubUserId, dryRun ? 1 : 0) as InviteRequest | undefined) ??
        null
      );
    },
    findOpenRequestByLogin(org: string, login: string): InviteRequest | null {
      return (q.openByLogin.get(org, login) as InviteRequest | undefined) ?? null;
    },
    lastRequestAt(discordUserId: string): number | null {
      const row = q.lastRequestByUser.get(discordUserId) as { created_at: number } | undefined;
      return row?.created_at ?? null;
    },
    openRequestCount(discordUserId: string): number {
      return (q.countOpenByUser.get(discordUserId) as { n: number }).n;
    },
    /** Returns true only for the caller that actually won the transition. */
    decide(id: number, status: "approved" | "denied", decidedBy: string): boolean {
      const res = q.decide.run(status, decidedBy, Date.now(), id);
      return Number(res.changes) === 1;
    },
    finish(id: number, status: "sent" | "failed", error: string | null): void {
      q.finish.run(status, error, id);
    },
    /** Retires a request so it stops blocking retries. */
    revoke(id: number, note: string): void {
      q.finish.run("denied", note, id);
    },
    /**
     * Retires pending requests nobody ever actioned.
     *
     * Without this a request whose approval message was deleted -- or simply
     * ignored -- blocks its requester permanently, since one open request is
     * all they are allowed.
     */
    expireStale(olderThan: number): number {
      return Number(q.expireStale.run(olderThan).changes);
    },
    listPendingRequests(guildId: string): InviteRequest[] {
      return q.listPending.all(guildId) as unknown as InviteRequest[];
    },
  };
}

export type Store = ReturnType<typeof createStore>;
