# Discord Util Bot

A self-hosted Discord bot built around a plugin architecture: every capability is a
self-contained folder under `src/features/`, discovered at boot. Adding a feature
requires no changes to core code.

**Requires** Node 22.5+ — persistence uses the built-in `node:sqlite`, so there are no
native modules to compile (which matters on ARM hosts).

|                |                                                                                                |
| -------------- | ---------------------------------------------------------------------------------------------- |
| **Features**   | [`github-adder`](src/features/github-adder/) — GitHub org invite queue · `ping` — health check |
| **Deployment** | [`deploy/`](deploy/) — hosting options, systemd, Docker                                        |
| **Stack**      | TypeScript · discord.js 14 · Octokit · `node:sqlite` · pino · zod                              |

---

## Architecture

```
src/
├── index.ts              Entrypoint: env → client → features → login
├── core/
│   ├── env.ts            zod schema for all config; exits at boot if invalid
│   ├── client.ts         Discord client; intents and cache limits
│   ├── feature.ts        The Feature contract (extension point)
│   ├── registry.ts       Discovers src/features/*, wires everything
│   ├── interactions.ts   Single dispatcher; guarantees one response
│   ├── logger.ts         pino with a secret-redaction list
│   ├── errors.ts         UserFacingError vs internal + correlation IDs
│   └── deploy-commands.ts
├── lib/
│   ├── db.ts             SQLite handle (WAL, foreign keys)
│   ├── github.ts         Octokit with App auth, retry, throttling
│   ├── quota.ts          Daily invite budget
│   └── ids.ts            Typed component custom_id encode/decode
└── features/
    ├── github-adder/     See its own README
    └── ping/
```

### The Feature contract

```ts
export interface Feature {
  name: string;
  description: string;
  enabled?: (env: Env) => boolean; // kill-switch without deleting code
  commands?: CommandModule[]; // slash commands
  events?: EventModule[]; // gateway events
  components?: ComponentHandler[]; // buttons/modals, matched by custom_id prefix
  init?: (ctx: FeatureContext) => Promise<void> | void; // migrations, timers
}
```

`registry.ts` globs `src/features/*/index.ts`, validates that no two features claim the
same command name or component prefix (it throws at boot if they do), then calls each
`init()`. Features receive a `FeatureContext` (`db`, `env`, `logger`) by injection, so
they are unit-testable without a gateway connection.

**To add a feature:** copy `src/features/ping/`, rename, export a manifest, run
`npm run deploy-commands`. Nothing in `core/` changes.

---

## Configuration

All config is environment variables, validated by `src/core/env.ts` at startup. The
process exits with a list of what is wrong rather than starting half-configured.
Copy `.env.example` to `.env`.

### Required

| Variable                                                      | Source                                                      |
| ------------------------------------------------------------- | ----------------------------------------------------------- |
| `DISCORD_TOKEN`                                               | Developer Portal → Bot → Reset Token                        |
| `DISCORD_APP_ID`                                              | Developer Portal → General Information                      |
| `GITHUB_APP_ID`                                               | GitHub App settings                                         |
| `GITHUB_ORG`                                                  | Organization login                                          |
| `GITHUB_INSTALLATION_ID`                                      | Trailing number of the App's install URL                    |
| `GITHUB_APP_PRIVATE_KEY_PATH` **or** `GITHUB_APP_PRIVATE_KEY` | `.pem` path (absolute — `~` is not expanded), or its base64 |

### Optional

| Variable                    | Default       | Effect                                                               |
| --------------------------- | ------------- | -------------------------------------------------------------------- |
| `DEV_GUILD_ID`              | —             | Registers commands to one guild (instant). Empty = global (up to 1h) |
| `GITHUB_DRY_RUN`            | `true`        | Log invitations instead of sending them                              |
| `GITHUB_DAILY_INVITE_LIMIT` | `40`          | Local budget, kept under GitHub's 50/day cap                         |
| `INVITE_COOLDOWN_SECONDS`   | `60`          | Per-user throttle                                                    |
| `REQUEST_EXPIRY_HOURS`      | `168`         | Abandoned requests retired after this                                |
| `DATA_DIR`                  | `./data`      | SQLite location                                                      |
| `LOG_LEVEL`                 | `info`        | pino level                                                           |
| `NODE_ENV`                  | `development` | `development` enables pretty logs                                    |

---

## Operations

| Command                          | Purpose                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `npm run dev`                    | Run with watch-reload                                                                                              |
| `npm start`                      | Run compiled build (`npm run build` first)                                                                         |
| `npm run deploy-commands`        | Register slash commands — **required after any command definition change**                                         |
| `npm run check-github`           | Verify App auth, installation, and `members: write` without sending anything                                       |
| `npm run doctor`                 | Diagnose "I typed a name and nothing happened": config, login, intents, per-channel permissions, live message echo |
| `npm test` / `npm run typecheck` | 70 unit tests; strict typecheck                                                                                    |

`check-github` and `doctor` are read-only. Neither sends a Discord message nor writes to
the database.

### Running locally

`./run.sh` wraps the npm scripts with preflight checks — Node version, dependencies,
`.env` completeness, placeholder detection, absolute-path validation on the private key,
and `.env` file permissions. It refuses to start rather than failing later with a
confusing error.

```bash
./run.sh setup       # deps + .env scaffold
./run.sh check       # verify GitHub credentials and Discord connectivity
./run.sh commands    # register slash commands
./run.sh             # run with watch-reload
./run.sh prod        # build and run the compiled bundle

./run.sh status      # is it running?
./run.sh stop        # stop it
./run.sh restart     # stop, then start
./run.sh test        # typecheck, tests, format check
```

Starting refuses if an instance is already running — two processes sharing one bot token
both reply to everything, which is confusing to diagnose. `stop` sends SIGTERM so the bot
closes the gateway and the SQLite handle cleanly, escalating to SIGKILL only after 5s.

Process matching is scoped to this checkout: dev-mode commands embed the project path,
and a production `node dist/src/index.js` is confirmed by its working directory, so
unrelated node processes are never touched.

Each run prints whether `GITHUB_DRY_RUN` is on and whether the catch-up scan is
enabled, so the two settings that change real-world behaviour are never a surprise.

`GITHUB_DRY_RUN` defaults to `true`. Leave it on until the whole path is verified —
dry-run and real activity are tracked as **separate ledgers**, so a dry run never blocks
a later real invite and never spends the real daily budget.

---

## Security model

**Credentials.** `.gitignore` covers `.env`, `*.pem`, and `data/`. The logger carries an
explicit redaction list; Octokit attaches the outbound `Authorization` header to every
`RequestError`, and that path is redacted (verified against real serialized output).
Config is validated at boot.

**Least privilege.** Six Discord permissions (View Channel, Send Messages, Send Messages
in Threads, Embed Links, Read Message History, Add Reactions) and one GitHub permission
(`Members: write`). Intents are `Guilds`, `GuildMessages`, `MessageContent` — not
`GuildMembers` or `GuildPresences`.

**Message privacy.** The listener discards any message outside an explicitly configured
channel before doing any work. Message content is never logged — only the extracted
username, the minimum needed for an audit trail.

**Authorization is re-checked server-side.** A visible button is not permission to press
it. Moderator roles are refetched live on every click, and requests are pinned to the
guild they were created in.

**Failure containment.** Errors reaching Discord are plain language plus a correlation
ID; raw upstream responses go to the log only. Unhandled rejections exit the process so
a supervisor restarts it cleanly rather than continuing in an undefined state.

---

## Development

```bash
npm run test:watch
```

Tests avoid network and Discord entirely: the GitHub client is mocked at the Octokit
boundary and SQLite runs in-memory. Coverage centres on the parts where bugs are
expensive — username parsing, the request state machine, ledger separation, quota
rollover, and expiry.
