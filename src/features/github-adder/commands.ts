import {
  ChannelType,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildTextBasedChannel,
} from "discord.js";
import { UserFacingError } from "../../core/errors.js";
import type { CommandModule } from "../../core/feature.js";
import { createQuotaStore, nextResetUnix } from "../../lib/quota.js";
import { formatDuration, parseAutoWindow } from "./duration.js";
import { runInviteFlow } from "./flow.js";
import { buildDeps } from "./deps.js";
import { cancelInvitation, effectiveMode, listPendingInvitations } from "./service.js";
import { parseGitHubUsername } from "./username.js";
import { createStore } from "./store.js";

/** Guild-only guard, so `interaction.guildId` is safe to use downstream. */
function requireGuild(interaction: ChatInputCommandInteraction): string {
  if (!interaction.guildId) {
    throw new UserFacingError("This command only works inside a server.");
  }
  return interaction.guildId;
}

const adder: CommandModule = {
  data: new SlashCommandBuilder()
    .setName("github-adder")
    .setDescription("Configure the GitHub organization invite channel")
    // Default-hides the command from non-admins. Re-checked in each handler,
    // because server owners can override this per-role in Discord's UI.
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub
        .setName("setup")
        .setDescription("Turn a channel into a GitHub org invite channel")
        .addChannelOption((o) =>
          o
            .setName("channel")
            .setDescription("Channel to watch for GitHub usernames")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true),
        )
        .addStringOption((o) =>
          o.setName("org").setDescription("GitHub organization login").setRequired(true),
        )
        .addRoleOption((o) =>
          o
            .setName("mod-role")
            .setDescription("Role allowed to approve requests")
            .setRequired(true),
        )
        .addChannelOption((o) =>
          o
            .setName("audit-channel")
            .setDescription("Where to mirror every decision (recommended)")
            .addChannelTypes(ChannelType.GuildText),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("mode")
        .setDescription("Switch between moderator approval and temporary auto-invite")
        .addChannelOption((o) =>
          o
            .setName("channel")
            .setDescription("The adder channel")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true),
        )
        .addStringOption((o) =>
          o
            .setName("mode")
            .setDescription("Approval mode")
            .setRequired(true)
            .addChoices(
              { name: "moderator (approve each request)", value: "moderator" },
              { name: "auto (invite immediately)", value: "auto" },
            ),
        )
        .addStringOption((o) =>
          o
            .setName("duration")
            .setDescription(
              'How long auto mode lasts: 30m, 2h (max 24h), or "permanent". Default 1h.',
            ),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("status").setDescription("Show configured channels, modes, and invite budget"),
    )
    .addSubcommand((sub) =>
      sub
        .setName("pending")
        .setDescription(
          "List requests awaiting a decision, and invitations GitHub is still holding",
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("revoke")
        .setDescription("Cancel a pending invitation and let the person be re-invited")
        .addStringOption((o) =>
          o
            .setName("username")
            .setDescription("GitHub username to revoke")
            .setRequired(true)
            .setMaxLength(200),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("disable")
        .setDescription("Stop watching a channel")
        .addChannelOption((o) =>
          o
            .setName("channel")
            .setDescription("The adder channel")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true),
        ),
    ),

  async execute(interaction, ctx) {
    const guildId = requireGuild(interaction);
    const store = createStore(ctx.db);
    const sub = interaction.options.getSubcommand();

    if (sub === "setup") {
      const channel = interaction.options.getChannel("channel", true);
      const org = interaction.options.getString("org", true).trim();
      const modRole = interaction.options.getRole("mod-role", true);
      const auditChannel = interaction.options.getChannel("audit-channel");

      if (!/^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i.test(org)) {
        throw new UserFacingError("That doesn't look like a valid GitHub organization name.");
      }
      if (org.toLowerCase() !== ctx.env.GITHUB_ORG.toLowerCase()) {
        throw new UserFacingError(
          `I'm only installed on \`${ctx.env.GITHUB_ORG}\`.`,
          "Set GITHUB_ORG in the bot's environment to change which org it can invite to.",
        );
      }

      store.setGuildConfig(guildId, modRole.id, auditChannel?.id ?? null);
      store.addAdderChannel(channel.id, guildId, org, interaction.user.id);

      await interaction.reply({
        content: [
          `Watching <#${channel.id}> for GitHub usernames → **${org}**.`,
          `Approvals: <@&${modRole.id}>`,
          auditChannel ? `Audit log: <#${auditChannel.id}>` : "No audit channel set (recommended).",
          "",
          `Mode is **moderator approval**. ${ctx.env.GITHUB_DRY_RUN ? "⚠️ `GITHUB_DRY_RUN` is on — no real invites will be sent." : ""}`,
        ].join("\n"),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "mode") {
      const channel = interaction.options.getChannel("channel", true);
      const mode = interaction.options.getString("mode", true) as "moderator" | "auto";
      const durationRaw = interaction.options.getString("duration") ?? "1h";

      const configured = store.getAdderChannel(channel.id);
      if (!configured) {
        throw new UserFacingError(`<#${channel.id}> isn't set up as an invite channel yet.`);
      }

      if (mode === "moderator") {
        store.setApprovalMode(channel.id, "moderator", null);
        await interaction.reply({
          content: `<#${channel.id}> now requires **moderator approval**.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const window = parseAutoWindow(durationRaw);
      if (window === null) {
        throw new UserFacingError(
          `\`${durationRaw}\` isn't a valid duration.`,
          "Use `30m`, `2h`, `1d` (max 24h), or `permanent` to leave it on indefinitely.",
        );
      }

      const expiresAt = window.kind === "timed" ? Date.now() + window.ms : null;
      store.setApprovalMode(channel.id, "auto", expiresAt);

      const warning = `Anyone who can post there can add someone to **${configured.org}** with no review.`;
      await interaction.reply({
        content:
          window.kind === "timed"
            ? [
                `⚠️ <#${channel.id}> is now **auto-inviting** for ${formatDuration(window.ms)}.`,
                warning,
                `Reverts to moderator approval <t:${Math.floor(expiresAt! / 1000)}:R>.`,
              ].join("\n")
            : [
                `⚠️ <#${channel.id}> is now **auto-inviting permanently**.`,
                warning,
                "This does **not** expire. Turn it off with `/github-adder mode mode:moderator`.",
                "Consider restricting who can post in that channel.",
              ].join("\n"),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "status") {
      const channels = store.listAdderChannels(guildId);
      const config = store.getGuildConfig(guildId);

      if (channels.length === 0) {
        await interaction.reply({
          content: "No invite channels configured. Use `/github-adder setup`.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const lines = channels.map((c) => {
        const active = effectiveMode(c.approval_mode, c.auto_mode_expires_at);
        const suffix =
          active !== "auto"
            ? ""
            : c.auto_mode_expires_at
              ? ` (reverts <t:${Math.floor(c.auto_mode_expires_at / 1000)}:R>)`
              : " ⚠️ **permanent**";
        return `• <#${c.channel_id}> → **${c.org}** — ${active}${suffix}`;
      });

      const org = channels[0]!.org;
      const used = createQuotaStore(ctx.db).used(org);
      const limit = ctx.env.GITHUB_DAILY_INVITE_LIMIT;

      await interaction.reply({
        content: [
          ...lines,
          "",
          config ? `Approvals: <@&${config.mod_role_id}>` : "⚠️ No moderator role set.",
          config?.audit_channel_id
            ? `Audit log: <#${config.audit_channel_id}>`
            : "No audit channel.",
          `Invites used today: **${used}/${limit}** (resets <t:${nextResetUnix()}:R>)`,
          ctx.env.GITHUB_DRY_RUN ? "⚠️ `GITHUB_DRY_RUN` is on — no real invites are sent." : "",
        ]
          .filter(Boolean)
          .join("\n"),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "pending") {
      const org = store.listAdderChannels(guildId)[0]?.org;
      if (!org) throw new UserFacingError("No GitHub invite channel is set up in this server yet.");

      // Sweeping here too means simply looking at the queue unsticks anyone
      // whose request was abandoned.
      const swept = store.expireStale(Date.now() - ctx.env.REQUEST_EXPIRY_HOURS * 3_600_000);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const local = store.listPendingRequests(guildId);
      const remote = await listPendingInvitations(org, buildDeps(ctx));

      const lines: string[] = [];
      lines.push(`**Awaiting a moderator** (${local.length})`);
      lines.push(
        local.length
          ? local
              .map(
                (r) =>
                  `• \`${r.github_login}\` — <@${r.discord_user_id}> · <t:${Math.floor(r.created_at / 1000)}:R>`,
              )
              .join("\n")
          : "_none_",
      );
      lines.push("");
      lines.push(`**Invited, not yet accepted on GitHub** (${remote.length})`);
      lines.push(
        remote.length
          ? remote.map((i) => `• \`${i.login}\` · invited <t:${i.createdAtUnix}:R>`).join("\n")
          : "_none_",
      );
      if (swept > 0) {
        lines.push(
          "",
          `-# Retired ${swept} abandoned request(s) older than ${ctx.env.REQUEST_EXPIRY_HOURS}h.`,
        );
      }

      await interaction.editReply({ content: lines.join("\n").slice(0, 2000) });
      return;
    }

    if (sub === "revoke") {
      const raw = interaction.options.getString("username", true);
      const parsed = parseGitHubUsername(raw);
      if (!parsed.ok) throw new UserFacingError("That doesn't look like a GitHub username.");

      // No env fallback: without a configured channel this guild has no claim
      // on the org, and ManageGuild elsewhere should not reach these invites.
      const org = store.listAdderChannels(guildId)[0]?.org;
      if (!org) {
        throw new UserFacingError("No GitHub invite channel is set up in this server yet.");
      }
      const local = store.findOpenRequestByLogin(org, parsed.login);

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const notes: string[] = [];

      // A dry-run record never reached GitHub, so calling the API for it would
      // 404 and imply something was wrong when nothing was.
      if (local?.dry_run) {
        notes.push("That record was from a dry run — no real invitation existed.");
      } else {
        const result = await cancelInvitation(parsed.login, org, buildDeps(ctx));
        notes.push(
          result === "cancelled"
            ? `Cancelled the pending GitHub invitation for \`${parsed.login}\`.`
            : `GitHub had no pending invitation for \`${parsed.login}\`.`,
        );
      }

      if (local) {
        store.revoke(local.id, `revoked by ${interaction.user.id}`);
        notes.push("Cleared the local record, so they can be invited again.");
      } else {
        notes.push("No local record was blocking them.");
      }

      await interaction.editReply({ content: notes.join("\n") });
      return;
    }

    if (sub === "disable") {
      const channel = interaction.options.getChannel("channel", true);
      store.disableAdderChannel(channel.id);
      await interaction.reply({
        content: `Stopped watching <#${channel.id}>.`,
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};

const invite: CommandModule = {
  data: new SlashCommandBuilder()
    .setName("github-invite")
    .setDescription("Request an invitation to the GitHub organization")
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) =>
      o
        .setName("username")
        .setDescription("Your GitHub username or profile URL")
        .setRequired(true)
        .setMaxLength(200),
    ),

  async execute(interaction, ctx) {
    const guildId = requireGuild(interaction);
    const store = createStore(ctx.db);

    // Must be run INSIDE a configured channel. Falling back to "the first
    // configured channel in the guild" would let anyone invoke this from a
    // channel they can see and inherit the adder channel's org and approval
    // mode -- bypassing the channel permissions that gate who may request at
    // all. The channel is the access-control boundary, so require it.
    const configured = store.getAdderChannel(interaction.channelId);
    if (!configured) {
      const available = store.listAdderChannels(guildId);
      throw new UserFacingError(
        available.length
          ? `Use this in ${available.map((c) => `<#${c.channel_id}>`).join(" or ")}.`
          : "No GitHub invite channel is set up in this server yet.",
      );
    }

    // Resolution hits the GitHub API, which can exceed the 3s interaction window.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const result = await runInviteFlow(
      {
        rawUsername: interaction.options.getString("username", true),
        channel: configured,
        guildId,
        channelId: interaction.channelId,
        requesterId: interaction.user.id,
        client: interaction.client,
      },
      buildDeps(ctx),
    );

    if (result.mode === "auto") {
      await interaction.editReply({ embeds: [result.embed] });
      return;
    }

    // Approval requests must be visible to moderators, so the embed goes to the
    // channel while the requester gets a private acknowledgement.
    const channel = interaction.channel as GuildTextBasedChannel | null;
    if (!channel?.isTextBased() || !("send" in channel)) {
      // Nowhere to post the approval buttons; a pending row nobody can action
      // would block this user forever, so retire it.
      store.finish(result.requestId, "failed", "Could not post the approval message.");
      throw new UserFacingError("I can't post here, so I can't queue that request.");
    }

    try {
      const message = await channel.send({
        embeds: [result.embed],
        components: result.components,
      });
      store.attachMessage(result.requestId, message.id);
    } catch (err) {
      store.finish(result.requestId, "failed", "Could not post the approval message.");
      ctx.logger.warn({ err, channelId: interaction.channelId }, "Could not post approval embed");
      throw new UserFacingError(
        "I couldn't post the approval message here.",
        "Check I have Send Messages and Embed Links in this channel.",
      );
    }

    await interaction.editReply({
      content: "Request submitted. A moderator will review it shortly.",
    });
  },
};

export const commands: CommandModule[] = [adder, invite];
