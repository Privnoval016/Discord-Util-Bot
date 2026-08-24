import type { Client, EmbedBuilder } from "discord.js";
import { UserFacingError } from "../../core/errors.js";
import type { ActionRowBuilder, ButtonBuilder } from "discord.js";
import { writeAudit } from "./audit.js";
import {
  assertQuotaAvailable,
  assertUserMayRequest,
  effectiveMode,
  resolveInvitee,
  sendInvitation,
  type ServiceDeps,
} from "./service.js";
import type { AdderChannel } from "./store.js";
import { autoInviteEmbed, decisionButtons, pendingEmbed } from "./views.js";

export interface FlowResult {
  embed: EmbedBuilder;
  components: ActionRowBuilder<ButtonBuilder>[];
  requestId: number;
  mode: "auto" | "moderator";
}

/**
 * The single path both the message listener and `/github-invite` take, so the
 * two entry points cannot drift on validation, throttling, or quota.
 */
export async function runInviteFlow(
  input: {
    rawUsername: string;
    channel: AdderChannel;
    guildId: string;
    channelId: string;
    requesterId: string;
    client: Client;
  },
  deps: ServiceDeps,
): Promise<FlowResult> {
  const { channel, requesterId, guildId, channelId, client } = input;
  const org = channel.org;

  const mode = effectiveMode(channel.approval_mode, channel.auto_mode_expires_at);

  // Retire abandoned requests first: the "one open request" rule below would
  // otherwise lock out anyone whose earlier request was never actioned.
  const expired = deps.store.expireStale(Date.now() - deps.env.REQUEST_EXPIRY_HOURS * 3_600_000);
  if (expired > 0) deps.logger.info({ expired }, "Retired stale pending requests");

  assertUserMayRequest(requesterId, deps);
  assertQuotaAvailable(org, deps);

  const user = await resolveInvitee(input.rawUsername, org, deps);

  const existing = deps.store.findOpenRequestFor(org, user.id, deps.env.GITHUB_DRY_RUN);
  if (existing) {
    throw new UserFacingError(
      `There's already an open request for \`${user.login}\`.`,
      existing.status === "pending" ? "It's waiting on a moderator." : "It has already been sent.",
    );
  }

  if (mode === "auto") {
    await sendInvitation(user, org, deps);
    const requestId = deps.store.createRequest({
      guildId,
      channelId,
      messageId: null,
      discordUserId: requesterId,
      githubLogin: user.login,
      githubUserId: user.id,
      org,
      status: "sent",
      dryRun: deps.env.GITHUB_DRY_RUN,
    });

    const embed = autoInviteEmbed(user, requesterId, org);
    await writeAudit(client, deps.store, guildId, embed, deps.logger);
    return { embed, components: [], requestId, mode };
  }

  const requestId = deps.store.createRequest({
    guildId,
    channelId,
    messageId: null,
    discordUserId: requesterId,
    githubLogin: user.login,
    githubUserId: user.id,
    org,
    status: "pending",
    dryRun: deps.env.GITHUB_DRY_RUN,
  });

  return {
    embed: pendingEmbed(user, requesterId, org),
    components: [decisionButtons(requestId)],
    requestId,
    mode,
  };
}
