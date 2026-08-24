import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { defineFeature } from "../../core/feature.js";

/**
 * Smallest possible feature. Exists to prove the registry contract end to end
 * and to give you a health check that doesn't touch GitHub.
 */
export default defineFeature({
  name: "ping",
  description: "Health check.",
  commands: [
    {
      data: new SlashCommandBuilder().setName("ping").setDescription("Check the bot is responsive"),
      async execute(interaction) {
        const latency = Math.round(interaction.client.ws.ping);
        await interaction.reply({
          content: `Up. Gateway latency ${latency}ms.`,
          flags: MessageFlags.Ephemeral,
        });
      },
    },
  ],
});
