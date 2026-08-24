import { type Interaction, MessageFlags } from "discord.js";
import { presentError } from "./errors.js";
import type { FeatureContext } from "./feature.js";
import type { LoadedFeatures } from "./registry.js";

/**
 * Single entry point for every interaction.
 *
 * The invariant this enforces: Discord ALWAYS gets exactly one response. An
 * unhandled throw here surfaces to users as "the application did not respond",
 * which is indistinguishable from the bot being down.
 */
export function createInteractionHandler(loaded: LoadedFeatures, ctx: FeatureContext) {
  return async function handleInteraction(interaction: Interaction): Promise<void> {
    try {
      if (interaction.isChatInputCommand()) {
        const command = loaded.commands.get(interaction.commandName);
        if (!command) {
          ctx.logger.warn({ command: interaction.commandName }, "Unknown command received");
          await interaction.reply({
            content: "That command isn't available right now. It may have been removed.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        await command.execute(interaction, ctx);
        return;
      }

      if (interaction.isMessageComponent() || interaction.isModalSubmit()) {
        const handler = loaded.components.find((c) => interaction.customId.startsWith(c.prefix));
        if (!handler) {
          // Usually a button on an old message whose feature was removed.
          ctx.logger.warn({ customId: interaction.customId }, "No handler for component");
          await interaction.reply({
            content: "This control has expired.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        await handler.execute(interaction, ctx);
      }
    } catch (err) {
      await respondWithError(interaction, err, ctx);
    }
  };
}

async function respondWithError(
  interaction: Interaction,
  err: unknown,
  ctx: FeatureContext,
): Promise<void> {
  const { userMessage, correlationId, internal } = presentError(err);

  if (internal !== null) {
    ctx.logger.error(
      { err: internal, correlationId, interaction: describeInteraction(interaction) },
      "Interaction handler failed",
    );
  }

  if (!interaction.isRepliable()) return;

  try {
    // Which reply method is valid depends on what the handler already did
    // before throwing, so branch on the interaction's own state.
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: userMessage, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content: userMessage, flags: MessageFlags.Ephemeral });
    }
  } catch (replyErr) {
    // The token expired (3s) or we raced another response. Nothing left to do
    // but record it -- re-throwing would take down the process.
    ctx.logger.error({ err: replyErr, correlationId }, "Failed to deliver error response");
  }
}

function describeInteraction(interaction: Interaction): Record<string, unknown> {
  return {
    type: interaction.type,
    guildId: interaction.guildId,
    userId: interaction.user.id,
    ...(interaction.isChatInputCommand() ? { command: interaction.commandName } : {}),
    ...(interaction.isMessageComponent() || interaction.isModalSubmit()
      ? { customId: interaction.customId }
      : {}),
  };
}
