import { ChannelType, type Client, type EmbedBuilder } from "discord.js";
import type { Logger } from "../../core/logger.js";
import type { Store } from "./store.js";

/**
 * Mirrors an outcome to the configured audit channel.
 *
 * Never throws: a misconfigured or deleted audit channel must not fail the
 * invite that already succeeded. Failures are logged and swallowed.
 */
export async function writeAudit(
  client: Client,
  store: Store,
  guildId: string,
  embed: EmbedBuilder,
  logger: Logger,
): Promise<void> {
  const config = store.getGuildConfig(guildId);
  if (!config?.audit_channel_id) return;

  try {
    const channel = await client.channels.fetch(config.audit_channel_id);
    if (!channel || channel.type !== ChannelType.GuildText) return;
    await channel.send({ embeds: [embed] });
  } catch (err) {
    logger.warn(
      { err, guildId, channelId: config.audit_channel_id },
      "Could not write audit entry",
    );
  }
}
