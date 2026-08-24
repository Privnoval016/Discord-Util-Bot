import { MessageFlags, type GuildMember, type MessageComponentInteraction } from "discord.js";
import { UserFacingError } from "../../core/errors.js";
import type { ComponentHandler, FeatureContext } from "../../core/feature.js";
import { parseCustomId } from "../../lib/ids.js";
import { writeAudit } from "./audit.js";
import { buildDeps } from "./deps.js";
import { sendInvitation, type ResolvedUser } from "./service.js";
import { createStore, type InviteRequest } from "./store.js";
import { FEATURE_PREFIX, resolvedEmbed } from "./views.js";

/**
 * Approve/Deny handling.
 *
 * Two properties this must guarantee, neither of which Discord provides:
 *
 *  1. Authorization. A button being visible is not permission to press it --
 *     anyone who can see the message can send its custom_id. Role membership is
 *     therefore rechecked live on every click.
 *  2. Idempotency. Discord redelivers interactions, and two moderators can click
 *     at the same instant. The status transition is a guarded UPDATE, and GitHub
 *     is only called by the caller that actually won it.
 */
export const decisionButtons: ComponentHandler = {
  prefix: `${FEATURE_PREFIX}:`,

  async execute(interaction, ctx) {
    if (!interaction.isButton()) return;

    const parsed = parseCustomId(interaction.customId);
    if (!parsed || (parsed.action !== "approve" && parsed.action !== "deny")) return;

    const requestId = Number(parsed.arg);
    if (!Number.isInteger(requestId)) {
      throw new UserFacingError("This button is malformed.");
    }

    // Acknowledge first: the role fetch and GitHub call below both exceed
    // Discord's 3s interaction window on a slow network, and a late response is
    // shown to users as "this interaction failed".
    await interaction.deferUpdate();

    const store = createStore(ctx.db);
    const request = store.getRequest(requestId);
    if (!request) {
      throw new UserFacingError("That request no longer exists.");
    }

    // Defence in depth: a request always belongs to the guild it was made in,
    // so a decision arriving from anywhere else is not something to act on.
    if (request.guild_id !== interaction.guildId) {
      ctx.logger.warn(
        { requestId, requestGuild: request.guild_id, fromGuild: interaction.guildId },
        "Decision arrived from a different guild than the request",
      );
      throw new UserFacingError("That request doesn't belong to this server.");
    }

    await assertIsModerator(interaction, ctx);

    if (request.status !== "pending") {
      throw new UserFacingError(`This request was already **${request.status}**.`);
    }

    // Won-the-race check. Everything after this point runs exactly once.
    const won = store.decide(
      requestId,
      parsed.action === "approve" ? "approved" : "denied",
      interaction.user.id,
    );
    if (!won) {
      throw new UserFacingError("Someone else just actioned this request.");
    }

    if (parsed.action === "deny") {
      await finalize(interaction, request, "denied", interaction.user.id, ctx);
      return;
    }

    try {
      await sendInvitation(toResolvedUser(request), request.org, buildDeps(ctx));
      store.finish(requestId, "sent", null);
      await finalize(interaction, request, "sent", interaction.user.id, ctx);
    } catch (err) {
      const detail = err instanceof UserFacingError ? err.message : "Unexpected error";
      store.finish(requestId, "failed", detail);
      ctx.logger.error({ err, requestId }, "Approved invitation failed to send");
      await finalize(interaction, request, "failed", interaction.user.id, ctx, detail);
    }
  },
};

/**
 * Rechecks the moderator role against live guild state rather than trusting
 * anything carried on the message.
 */
async function assertIsModerator(
  interaction: MessageComponentInteraction,
  ctx: FeatureContext,
): Promise<void> {
  if (!interaction.guildId) throw new UserFacingError("This only works inside a server.");

  const config = createStore(ctx.db).getGuildConfig(interaction.guildId);
  if (!config) {
    throw new UserFacingError("No moderator role is configured for this server.");
  }

  const member = interaction.member as GuildMember | null;
  // Fetch rather than trust the cached member: roles change, and the cache may
  // predate a revocation.
  const fresh = member?.fetch
    ? await member.fetch().catch(() => null)
    : await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);

  if (!fresh?.roles.cache.has(config.mod_role_id)) {
    ctx.logger.warn(
      { userId: interaction.user.id, guildId: interaction.guildId },
      "Non-moderator attempted an invite decision",
    );
    throw new UserFacingError("Only moderators can action invite requests.");
  }
}

/** Rebuilds the minimal shape sendInvitation needs from the stored row. */
function toResolvedUser(request: InviteRequest): ResolvedUser {
  return {
    login: request.github_login,
    id: request.github_user_id,
    avatarUrl: "",
    htmlUrl: `https://github.com/${request.github_login}`,
    name: null,
  };
}

async function finalize(
  interaction: MessageComponentInteraction,
  request: InviteRequest,
  outcome: "sent" | "denied" | "failed",
  deciderId: string,
  ctx: FeatureContext,
  detail?: string,
): Promise<void> {
  const embed = resolvedEmbed(request, outcome, deciderId, detail);

  // Strip the buttons so the resolved state can't be actioned again.
  await interaction.editReply({ embeds: [embed], components: [] }).catch((err) => {
    ctx.logger.warn({ err, requestId: request.id }, "Could not update decision message");
  });

  await writeAudit(interaction.client, createStore(ctx.db), request.guild_id, embed, ctx.logger);

  if (outcome === "sent") {
    await interaction
      .followUp({
        content: `Invitation sent to \`${request.github_login}\`.`,
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => undefined);
  }
}
