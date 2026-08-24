import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type APIEmbedField,
} from "discord.js";
import { buildCustomId } from "../../lib/ids.js";
import type { ResolvedUser } from "./service.js";
import type { InviteRequest } from "./store.js";

export const FEATURE_PREFIX = "gh";

const COLORS = {
  pending: 0xd29922,
  approved: 0x2da44e,
  denied: 0xcf222e,
  failed: 0x82071e,
} as const;

function userFields(user: ResolvedUser, requesterId: string): APIEmbedField[] {
  return [
    { name: "GitHub", value: `[@${user.login}](${user.htmlUrl})`, inline: true },
    { name: "Requested by", value: `<@${requesterId}>`, inline: true },
  ];
}

export function pendingEmbed(user: ResolvedUser, requesterId: string, org: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(COLORS.pending)
    .setTitle("Organization invite requested")
    .setDescription(`Invite **@${user.login}** to **${org}**?`)
    .setThumbnail(user.avatarUrl)
    .addFields(userFields(user, requesterId))
    .setFooter({ text: "Approving grants access to the organization's private repositories." })
    .setTimestamp();
}

export function decisionButtons(requestId: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildCustomId(FEATURE_PREFIX, "approve", requestId))
      .setLabel("Approve")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(buildCustomId(FEATURE_PREFIX, "deny", requestId))
      .setLabel("Deny")
      .setStyle(ButtonStyle.Danger),
  );
}

export function resolvedEmbed(
  request: InviteRequest,
  outcome: "sent" | "denied" | "failed",
  deciderId: string,
  detail?: string,
): EmbedBuilder {
  const titles = {
    sent: "Invitation sent",
    denied: "Request denied",
    failed: "Invitation failed",
  } as const;

  const embed = new EmbedBuilder()
    .setColor(
      outcome === "sent" ? COLORS.approved : outcome === "denied" ? COLORS.denied : COLORS.failed,
    )
    .setTitle(titles[outcome])
    .setDescription(
      `**@${request.github_login}** → **${request.org}**\nRequested by <@${request.discord_user_id}>`,
    )
    .addFields({
      name: outcome === "denied" ? "Denied by" : "Actioned by",
      value: `<@${deciderId}>`,
    })
    .setTimestamp();

  if (detail) embed.addFields({ name: "Detail", value: detail.slice(0, 1024) });
  return embed;
}

export function autoInviteEmbed(
  user: ResolvedUser,
  requesterId: string,
  org: string,
): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(COLORS.approved)
    .setTitle("Invitation sent")
    .setDescription(`**@${user.login}** has been invited to **${org}**.`)
    .setThumbnail(user.avatarUrl)
    .addFields(userFields(user, requesterId))
    .setFooter({ text: "Auto-approve mode" })
    .setTimestamp();
}
