import { Client, GatewayIntentBits, Options, Partials } from "discord.js";

/**
 * Least-privilege intents.
 *
 * MessageContent is privileged but self-serve below 10,000 installs; it is
 * required to read a username typed into a channel. GuildMembers and
 * GuildPresences are deliberately absent -- nothing here needs them, and each
 * one widens what the bot can see.
 */
export function createClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
    // Trim caches we never read. Members are not capped here: without the
    // GuildMembers intent the cache only ever holds members we saw in an
    // interaction, and discord.js needs the client's own member to resolve
    // its permissions.
    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      MessageManager: 50,
      PresenceManager: 0,
      ReactionManager: 0,
      GuildStickerManager: 0,
      GuildScheduledEventManager: 0,
    }),
    allowedMentions: { parse: [], repliedUser: false },
  });
}
