import { Events } from "discord.js";
import { createClient } from "./core/client.js";
import { loadEnv } from "./core/env.js";
import { createInteractionHandler } from "./core/interactions.js";
import { createLogger } from "./core/logger.js";
import { loadFeatures } from "./core/registry.js";
import type { FeatureContext } from "./core/feature.js";
import { openDatabase } from "./lib/db.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger({
    level: env.LOG_LEVEL,
    pretty: env.NODE_ENV === "development",
  });

  const db = openDatabase(env.DATA_DIR);
  const ctx: FeatureContext = { db, env, logger };

  const client = createClient();
  const loaded = await loadFeatures(ctx);

  // Wire each feature's event handlers, wrapped so one feature throwing can
  // never take down the gateway connection for the others.
  for (const feature of loaded.features) {
    for (const event of feature.events ?? []) {
      const handler = async (...args: unknown[]) => {
        try {
          await (event.execute as (c: FeatureContext, ...a: unknown[]) => Promise<void>)(
            ctx,
            ...args,
          );
        } catch (err) {
          logger.error({ err, feature: feature.name, event: event.name }, "Event handler failed");
        }
      };
      if (event.once) client.once(event.name, handler);
      else client.on(event.name, handler);
    }
  }

  client.on(Events.InteractionCreate, createInteractionHandler(loaded, ctx));

  client.once(Events.ClientReady, (ready) => {
    logger.info(
      { user: ready.user.tag, guilds: ready.guilds.cache.size, features: loaded.features.length },
      "Bot ready",
    );
  });

  client.on(Events.Error, (err) => logger.error({ err }, "Discord client error"));
  client.on(Events.Warn, (msg) => logger.warn({ msg }, "Discord client warning"));

  // Exit rather than limp along in an undefined state; the supervisor
  // (systemd / Docker restart policy) brings us back clean.
  process.on("unhandledRejection", (reason) => {
    logger.fatal({ err: reason }, "Unhandled rejection — exiting");
    void shutdown(1);
  });
  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "Uncaught exception — exiting");
    void shutdown(1);
  });

  async function shutdown(code: number): Promise<void> {
    try {
      await client.destroy();
      db.close();
    } catch {
      // Already tearing down; nothing useful left to do.
    }
    process.exit(code);
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      logger.info({ signal }, "Shutting down");
      void shutdown(0);
    });
  }

  await client.login(env.DISCORD_TOKEN);
}

void main();
