import { Events } from "discord.js";
import { createQuotaStore } from "../../lib/quota.js";
import { defineFeature, type EventModule } from "../../core/feature.js";
import { runBackfill } from "./backfill.js";
import { decisionButtons } from "./buttons.js";
import { commands } from "./commands.js";
import { messageListener } from "./listener.js";
import { createStore } from "./store.js";

/**
 * Runs once the gateway is up: processes usernames posted while the bot was
 * offline. Deferred to ready because it needs to fetch channels.
 */
const catchUp: EventModule<Events.ClientReady> = {
  name: Events.ClientReady,
  once: true,
  async execute(ctx, client) {
    await runBackfill(client, ctx);
  },
};

export default defineFeature({
  name: "github-adder",
  description: "Turns a channel into a GitHub organization invite queue.",
  commands,
  events: [messageListener, catchUp],
  components: [decisionButtons],
  init(ctx) {
    // Idempotent CREATE TABLE IF NOT EXISTS; each feature owns its own schema.
    createStore(ctx.db);
    createQuotaStore(ctx.db);
    if (ctx.env.GITHUB_DRY_RUN) {
      ctx.logger.warn("GITHUB_DRY_RUN is enabled — invitations will be logged, not sent.");
    }
  },
});
