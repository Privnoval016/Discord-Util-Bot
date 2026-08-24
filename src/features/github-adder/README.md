# github-adder

Turns a Discord channel into a GitHub organization invite queue. Post a username, and
the account is invited to the configured org — either after a moderator approves, or
immediately if auto mode is on.

> **Org membership grants access to private repositories.** Treat this as a
> privilege-granting tool, and read [Threat model](#threat-model) before enabling auto
> mode.

---

## Commands

`/github-adder` requires **Manage Server**. `/github-invite` is open to anyone who can
post in a configured channel.

| Command                 | Options                                        | Effect                                                        |
| ----------------------- | ---------------------------------------------- | ------------------------------------------------------------- |
| `/github-adder setup`   | `channel*` `org*` `mod-role*` `audit-channel?` | Marks a channel as an invite channel                          |
| `/github-adder mode`    | `channel*` `mode*` `duration?`                 | Switches approval mode                                        |
| `/github-adder status`  | —                                              | Channels, effective modes, invite budget                      |
| `/github-adder pending` | —                                              | Requests awaiting a decision + invitations GitHub still holds |
| `/github-adder revoke`  | `username*`                                    | Cancels a pending invitation, clears local state              |
| `/github-adder disable` | `channel*`                                     | Stops watching a channel                                      |
| `/github-invite`        | `username*`                                    | Requests an invite without message-listening                  |

`*` required · `?` optional

`/github-invite` only works **inside** a configured channel. It deliberately does not
fall back to "the first configured channel in the guild" — that would let anyone invoke
it from a channel they can see and inherit the adder channel's org and approval mode,
bypassing the channel permissions that gate who may request at all.

### Approval modes

```
/github-adder mode channel:#x mode:moderator                    # default
/github-adder mode channel:#x mode:auto duration:2h             # time-boxed
/github-adder mode channel:#x mode:auto duration:permanent      # standing
```

A timed window stores an expiry timestamp re-checked on every request, so it reverts on
its own — including across a restart. Durations over 24h are **refused rather than
silently capped**; `permanent` must be typed in full so it cannot be reached by
mistyping a duration. `/github-adder status` flags a permanent window with ⚠️.

---

## Request pipeline

```
message in watched channel  ─┐
                             ├─→  extract username
/github-invite <username>   ─┘         │
                                       ▼
                        ┌──────────────────────────────┐
                        │ 1. retire abandoned requests │
                        │ 2. per-user cooldown         │  no GitHub calls yet:
                        │ 3. daily org budget          │  cheap checks first
                        └──────────────┬───────────────┘
                                       ▼
                        ┌──────────────────────────────┐
                        │ 4. GET /users/{login}        │  → 404? no such account
                        │    reject type != "User"     │  → blocks orgs and bots
                        │ 5. GET /orgs/../memberships  │  → active? pending? stop
                        │ 6. duplicate check (ledger)  │
                        └──────────────┬───────────────┘
                                       ▼
                            moderator ──┴── auto
                                │           │
                     post embed │           │ POST /orgs/{org}/invitations
                     + buttons  │           │      { invitee_id }
                                │           ▼
                                │      confirmation embed
                                ▼
                        Approve / Deny  →  invite or retire
```

**Ordering is deliberate.** Throttles and budget are checked before any GitHub call, so
abuse costs nothing upstream. Username validation happens before that, via regex, so
ordinary chat in a watched channel is free and silent.

**Invitations use the numeric `invitee_id`**, not the login. GitHub's endpoint requires
it, and pinning to the ID closes the window where an account is renamed between
resolution and approval.

### What counts as a username

A github.com URL anywhere in a message wins outright. Otherwise the message must be
_nothing but_ a handle. Prose is ignored silently — ordinary words like `add`, `please`,
and `thanks` are all valid-looking GitHub logins, so scanning every token in a sentence
would invite the wrong person.

| Input                                                 | Result                 |
| ----------------------------------------------------- | ---------------------- |
| `octocat` · `@octocat` · `https://github.com/octocat` | ✅ `octocat`           |
| `github.com/octocat/repo`                             | ✅ `octocat` (owner)   |
| `please add octocat`                                  | ⬜ ignored             |
| `github.com/a and github.com/b`                       | ⬜ ignored (ambiguous) |
| `settings` · `-bad` · `a--b`                          | ❌ rejected            |

Validation is `/^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i` plus a reserved-path
deny-list (`settings`, `features`, `about`, …).

---

## Catch-up scan

On startup the bot processes usernames posted while it was offline — the common case when
running from a laptop that gets closed.

**The cursor is a Discord message ID, not a timestamp.** Snowflakes are Discord's own
pagination key (`after:`), they encode their own creation time, and they cannot drift
against the host clock the way a stored timestamp can. It lives in
`adder_channel.last_scanned_message_id` and is advanced by the live listener too, so a
restart never replays messages already handled online.

### Safety properties

| Property                                                                 | Why                                                                                                                                       |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| A channel seen for the first time is **not** back-scanned                | The cursor is set to the newest message and nothing is processed. Reading full history would retroactively invite everyone ever mentioned |
| Messages older than `BACKFILL_MAX_AGE_HOURS` (72) are skipped            | A username from three months ago should not trigger an invite today                                                                       |
| At most `BACKFILL_MAX_PER_CHANNEL` (25) requests per channel per startup | Bounds the blast radius of a long outage. Remaining messages are left for the next run                                                    |
| The cursor advances past **every** message examined                      | A message that always fails would otherwise be reprocessed on every startup, forever                                                      |
| One message failing does not abort the scan                              | Errors are per-message; expected outcomes (already a member, cooldown, duplicate) are counted as skips, not failures                      |
| The daily budget and per-user cooldown still apply                       | A catch-up cannot exceed limits a live run could not                                                                                      |
| Requests are raised in chronological order                               | The cursor only ever moves forward                                                                                                        |

Backfilled messages get a reply just like live ones, so moderator-mode requests still post
their Approve/Deny buttons. Set `BACKFILL_ENABLED=false` to turn the whole thing off.

---

## Data model

SQLite, created idempotently in `init()`. Migrations use `ensureColumn`, which checks
`PRAGMA table_info` — SQLite has no `ADD COLUMN IF NOT EXISTS`.

| Table            | Purpose                                                |
| ---------------- | ------------------------------------------------------ |
| `guild_config`   | Moderator role, audit channel                          |
| `adder_channel`  | Watched channels: org, approval mode, auto-mode expiry |
| `invite_request` | Every request and its outcome                          |
| `invite_quota`   | Per-org, per-UTC-day counter                           |

### Request states

```
pending ──approve──→ approved ──→ sent
   │                     └──────→ failed
   ├──deny────→ denied
   ├──revoke──→ denied
   └──expire──→ failed        (REQUEST_EXPIRY_HOURS, default 168)
```

`pending`, `approved`, and `sent` count as **open** and block a duplicate request for the
same GitHub account. `denied` and `failed` do not.

Expiry exists because one open request is all a user is allowed. Without it, a request a
moderator never actioned — or whose approval message was deleted, taking its buttons —
would block that person permanently. The sweep runs on every request and on
`/github-adder pending`, so simply looking at the queue unsticks people.

### Dry-run separation

`invite_request.dry_run` splits records into two ledgers. A dry run never contacted
GitHub, so its bookkeeping must not block a real invite, and a dry run never spends the
real daily budget. Flipping `GITHUB_DRY_RUN` to `false` therefore starts clean.

---

## Concurrency

Two moderators clicking Approve simultaneously, or Discord redelivering an interaction,
must not produce two invitations. The transition is a guarded update:

```sql
UPDATE invite_request SET status = ?, decided_by = ?, decided_at = ?
WHERE id = ? AND status = 'pending'
```

Only the caller whose update affected a row proceeds to call GitHub. The button handler
also defers immediately — the role fetch and GitHub call together can exceed Discord's
3-second interaction window, and a late response surfaces to users as "this interaction
failed".

---

## Threat model

| Risk                                         | Mitigation                                                                                   |
| -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Someone invites an account that isn't theirs | **Not mitigated.** No GitHub OAuth verification — see [Not implemented](#not-implemented)    |
| Anyone in the server invites people          | Channel permissions gate who can post; `/github-invite` is restricted to those same channels |
| Invite spam draining the 50/day cap          | Per-user cooldown, one open request each, local daily budget below GitHub's cap              |
| Non-moderator approving                      | Role refetched live on every click; buttons carry no authority                               |
| Double-invite from a double-click            | Guarded SQL transition; GitHub called only by the winner                                     |
| Decisions crossing servers                   | Requests pinned to their originating guild                                                   |
| Inviting an org or bot account               | `type !== "User"` rejected after lookup                                                      |
| Credential leaking into logs                 | pino redaction incl. `err.request.headers.authorization`                                     |
| Org internals leaking into a channel         | Errors mapped to plain language + correlation ID                                             |

**Auto mode removes the human check, not the throttles.** Cooldown, one-open-request,
and daily budget still apply, but anyone who can post in the channel can add anyone to
the org. Restrict channel posting accordingly.

---

## Failure modes

| Cause              | User sees                                                    |
| ------------------ | ------------------------------------------------------------ |
| 401 / 403          | "I'm not authorized to invite people to that organization."  |
| 404 on org         | "I can't reach the {org} organization."                      |
| 422                | "GitHub rejected the invitation." — usually the daily cap    |
| Local budget spent | "The daily invite budget for {org} is used up." + reset time |
| Network / 5xx      | Retried with backoff by Octokit, then a correlation ID       |

Raw GitHub error bodies are never echoed into a channel — they carry request URLs and
org internals. The full error goes to the log.

---

## Operational notes

**Nothing happens when I type a name.** Run `npm run doctor`. The usual cause is a
channel-level permission override denying **View Channel** — Discord does not deliver
`messageCreate` for channels a bot cannot see, so the event never arrives. Server-level
permissions from the OAuth invite do not override a channel's own settings.

**Empty message bodies** mean the `MESSAGE_CONTENT` intent is off. The listener logs this
once rather than on every message.

**Cancelling an invite.** `/github-adder revoke <username>` cancels the GitHub invitation
via `DELETE /orgs/{org}/memberships/{username}` and clears local state. The two halves are
independent, so it works whether the request is stuck locally, on GitHub, or both. It
recognizes dry-run records and skips the API call for them.

---

## Not implemented

- **GitHub OAuth verification.** Proving the Discord user owns the GitHub account would
  need a public HTTPS callback, which would change the bot from a pure outbound process
  into a service that terminates TLS. The trust model today is "whoever can post here is
  trusted to give their own username".
- **Enterprise Managed Users.** GitHub's invitation API is unavailable under EMU —
  members are provisioned only via SCIM from an identity provider. The feature cannot
  work there.
- **Membership sync.** Nothing reconciles a `sent` request with the invitee actually
  accepting; `/github-adder pending` shows GitHub's live list instead.

---

## Files

| File          | Role                                                   |
| ------------- | ------------------------------------------------------ |
| `index.ts`    | Feature manifest                                       |
| `commands.ts` | Slash command definitions and handlers                 |
| `listener.ts` | `messageCreate` handler, scoped to configured channels |
| `backfill.ts` | Startup catch-up scan for missed messages              |
| `buttons.ts`  | Approve/Deny — authorization and idempotency           |
| `flow.ts`     | Shared path for both entry points                      |
| `service.ts`  | GitHub calls, validation, error translation            |
| `store.ts`    | All SQL                                                |
| `username.ts` | Parsing and validation (pure)                          |
| `duration.ts` | Auto-window parsing (pure)                             |
| `views.ts`    | Embeds and buttons                                     |
| `audit.ts`    | Mirrors outcomes to the audit channel; never throws    |
| `deps.ts`     | Builds `ServiceDeps`; caches the Octokit client        |
