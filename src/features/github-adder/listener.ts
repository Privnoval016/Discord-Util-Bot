import { Events, type Message, MessageFlags } from "discord.js";
import { presentError } from "../../core/errors.js";
import type { EventModule } from "../../core/feature.js";
import { buildDeps } from "./deps.js";
import { runInviteFlow } from "./flow.js";
import { createStore } from "./store.js";
import { extractSoleUsername } from "./username.js";

/**
 * Watches configured channels for a GitHub username.
 *
 * The early returns matter as much as the logic: this handler sees every
 * message in every server the bot is in, so it discards anything outside a
 * configured channel before doing any work, and never logs message content.
 */
/** One-shot guard so a missing intent warns once, not once per message. */
let warnedAboutIntent = false;

export const messageListener: EventModule<Events.MessageCreate> = {
  name: Events.MessageCreate,

  async execute(ctx, message: Message) {
    if (message.author.bot || !message.inGuild()) return;

    const store = createStore(ctx.db);
    const channel = store.getAdderChannel(message.channelId);
    if (!channel) return; // not a watched channel -- the common case

    // Keep the catch-up cursor level with what we have handled live, so a
    // restart resumes from here instead of rescanning this session's messages.
    store.setScanCursor(message.channelId, message.id);

    // An empty body on a real message means the MESSAGE_CONTENT intent is off.
    // Without this the feature just silently does nothing, which is a miserable
    // thing to debug. Warn once rather than on every message.
    if (message.content === "" && !warnedAboutIntent) {
      warnedAboutIntent = true;
      ctx.logger.error(
        "Received an empty message body in a watched channel. Enable the MESSAGE CONTENT " +
          "INTENT in the Discord Developer Portal (Bot -> Privileged Gateway Intents), " +
          "or use /github-invite instead.",
      );
      return;
    }

    const parsed = extractSoleUsername(message.content);
    if (!parsed.ok) return; // ordinary conversation; stay silent

    try {
      const result = await runInviteFlow(
        {
          rawUsername: parsed.login,
          channel,
          guildId: message.guildId,
          channelId: message.channelId,
          requesterId: message.author.id,
          client: message.client,
        },
        buildDeps(ctx),
      );

      try {
        const sent = await message.reply({
          embeds: [result.embed],
          components: result.components,
          allowedMentions: { repliedUser: true },
        });
        if (result.mode === "moderator") {
          store.attachMessage(result.requestId, sent.id);
        }
      } catch (err) {
        // A pending request whose approval buttons never posted is unactionable
        // and would block this user permanently. Retire it rather than strand it.
        if (result.mode === "moderator") {
          store.finish(result.requestId, "failed", "Could not post the approval message.");
        }
        ctx.logger.warn(
          { err, channelId: message.channelId },
          "Could not post invite result; check Send Messages / Embed Links",
        );
      }
    } catch (err) {
      const { userMessage, correlationId, internal } = presentError(err);
      if (internal !== null) {
        ctx.logger.error(
          { err: internal, correlationId, channelId: message.channelId },
          "Invite flow failed from message listener",
        );
      }
      // Reply rather than stay silent: the user typed a username and expects
      // *something*. Errors here are already user-safe by construction.
      await message
        .reply({ content: userMessage, flags: MessageFlags.SuppressNotifications })
        .catch(() => {
          ctx.logger.warn({ channelId: message.channelId }, "Could not reply with error");
        });
    }
  },
};
