import { REST, Routes } from "discord.js";
import { loadEnv } from "./env.js";
import { createLogger } from "./logger.js";
import { loadFeatures } from "./registry.js";
import { openDatabase } from "../lib/db.js";

/**
 * Registers slash commands with Discord. Run after adding or changing a command.
 *
 * DEV_GUILD_ID set   -> guild-scoped, visible immediately (use while developing)
 * DEV_GUILD_ID empty -> global, can take up to an hour to propagate
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger({ level: env.LOG_LEVEL, pretty: true });
  const db = openDatabase(env.DATA_DIR);

  const { commands } = await loadFeatures({ db, env, logger });
  const body = [...commands.values()].map((c) => c.data.toJSON());

  const rest = new REST().setToken(env.DISCORD_TOKEN);
  const route = env.DEV_GUILD_ID
    ? Routes.applicationGuildCommands(env.DISCORD_APP_ID, env.DEV_GUILD_ID)
    : Routes.applicationCommands(env.DISCORD_APP_ID);

  await rest.put(route, { body });

  logger.info(
    { count: body.length, scope: env.DEV_GUILD_ID ? `guild ${env.DEV_GUILD_ID}` : "global" },
    `Registered: ${body.map((c) => `/${c.name}`).join(", ")}`,
  );
  db.close();
}

void main().catch((err) => {
  console.error("Command deployment failed:", err);
  process.exit(1);
});
