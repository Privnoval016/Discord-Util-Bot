/**
 * Read-only diagnostic for "I typed a name and nothing happened".
 *
 * Connects, reports every precondition the message listener depends on, then
 * echoes incoming messages so you can see exactly what the bot receives.
 * Sends nothing to Discord and writes nothing to the database.
 *
 *   npm run doctor
 */
import { Client, GatewayIntentBits, PermissionsBitField } from "discord.js";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { loadEnv } from "../src/core/env.js";
import { effectiveMode } from "../src/features/github-adder/service.js";

const env = loadEnv();
const LISTEN_MS = 30_000;

const tick = (b: boolean) => (b ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m");

// --- 1. What is configured locally? ---
const db = new DatabaseSync(join(env.DATA_DIR, "bot.sqlite"));
const channels = db.prepare("SELECT * FROM adder_channel WHERE enabled = 1").all() as unknown as {
  channel_id: string;
  guild_id: string;
  org: string;
  approval_mode: string;
  auto_mode_expires_at: number | null;
}[];

console.log("\n\x1b[1mConfigured channels\x1b[0m");
if (channels.length === 0) {
  console.log("  \x1b[31mNone.\x1b[0m Run /github-adder setup first.");
  process.exit(1);
}
const watched = new Set(channels.map((c) => c.channel_id));
for (const c of channels) {
  const mode = effectiveMode(c.approval_mode, c.auto_mode_expires_at);
  const expiry =
    c.approval_mode === "auto" && c.auto_mode_expires_at
      ? ` (auto until ${new Date(c.auto_mode_expires_at).toLocaleTimeString()}${
          c.auto_mode_expires_at < Date.now() ? " — \x1b[31mEXPIRED\x1b[0m" : ""
        })`
      : c.approval_mode === "auto"
        ? " (auto, permanent)"
        : "";
  console.log(`  ${c.channel_id} → ${c.org} — effective mode: \x1b[1m${mode}\x1b[0m${expiry}`);
}
console.log(
  `\n  GITHUB_DRY_RUN = ${env.GITHUB_DRY_RUN}` +
    (env.GITHUB_DRY_RUN ? "  (invites are logged, not sent)" : ""),
);
db.close();

// --- 2. Can we connect, and with which intents? ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once("clientReady", async (c) => {
  console.log(`\n\x1b[1mConnection\x1b[0m`);
  console.log(`  ${tick(true)} Logged in as ${c.user.tag}`);
  console.log(`  ${tick(true)} MESSAGE_CONTENT intent allowed (login would fail otherwise)`);

  console.log(`\n\x1b[1mChannel permissions\x1b[0m`);
  for (const conf of channels) {
    try {
      const ch = await c.channels.fetch(conf.channel_id);
      if (!ch || !("guild" in ch) || !ch.guild) {
        console.log(`  ${tick(false)} ${conf.channel_id} — not visible to the bot`);
        continue;
      }
      const me = await ch.guild.members.fetchMe();
      const perms = "permissionsFor" in ch ? ch.permissionsFor(me) : null;
      const name = "name" in ch ? ch.name : conf.channel_id;
      console.log(`  #${name}`);
      for (const p of [
        "ViewChannel",
        "SendMessages",
        "EmbedLinks",
        "ReadMessageHistory",
      ] as const) {
        const has = perms?.has(PermissionsBitField.Flags[p]) ?? false;
        console.log(`      ${tick(has)} ${p}`);
      }
    } catch (err) {
      console.log(`  ${tick(false)} ${conf.channel_id} — ${(err as Error).message}`);
    }
  }

  console.log(`\n\x1b[1mListening ${LISTEN_MS / 1000}s — type in Discord now\x1b[0m\n`);
});

client.on("messageCreate", (m) => {
  if (m.author.bot) return;
  const inWatched = watched.has(m.channelId);
  const name = "name" in m.channel ? m.channel.name : "?";
  console.log(
    `  ${inWatched ? "\x1b[32mWATCHED\x1b[0m" : "\x1b[90mother  \x1b[0m"} #${name} (${m.channelId})  len=${m.content.length}  ${JSON.stringify(m.content.slice(0, 50))}`,
  );
  if (!inWatched)
    console.log(`      \x1b[33m^ not a configured channel — the bot ignores this\x1b[0m`);
  if (m.content.length === 0)
    console.log(`      \x1b[31m^ EMPTY BODY: MESSAGE CONTENT INTENT is off in the portal\x1b[0m`);
});

client.login(env.DISCORD_TOKEN).catch((err: Error) => {
  console.log(`\n  ${tick(false)} Login failed: ${err.message}`);
  if (/disallowed/i.test(err.message)) {
    console.log("\n  \x1b[31mMESSAGE CONTENT INTENT is not enabled.\x1b[0m");
    console.log(
      "  Developer Portal → your app → Bot → Privileged Gateway Intents → enable it, save, restart.\n",
    );
  }
  process.exit(1);
});

setTimeout(() => {
  console.log("\nDone.\n");
  void client.destroy().then(() => process.exit(0));
}, LISTEN_MS);
