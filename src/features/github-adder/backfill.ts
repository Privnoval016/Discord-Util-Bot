import { ChannelType, type Client, type Message, type TextChannel } from "discord.js";
import { presentError } from "../../core/errors.js";
import type { FeatureContext } from "../../core/feature.js";
import { buildDeps } from "./deps.js";
import { runInviteFlow } from "./flow.js";
import { createStore, type AdderChannel } from "./store.js";
import { extractSoleUsername } from "./username.js";

const PAGE_SIZE = 100;

export interface BackfillSummary {
  channelId: string;
  scanned: number;
  raised: number;
  skipped: number;
  failed: number;
  bootstrapped: boolean;
}

/**
 * Processes usernames posted while the bot was offline.
 *
 * Discord message IDs are the cursor rather than a wall-clock timestamp:
 * snowflakes are Discord's own pagination key, they encode their creation time,
 * and they cannot drift against the host's clock the way a stored timestamp can.
 */
export async function runBackfill(client: Client, ctx: FeatureContext): Promise<BackfillSummary[]> {
  if (!ctx.env.BACKFILL_ENABLED) {
    ctx.logger.info("Catch-up scan disabled (BACKFILL_ENABLED=false)");
    return [];
  }

  const store = createStore(ctx.db);
  const channels = store.listAllEnabledChannels();
  const summaries: BackfillSummary[] = [];

  for (const conf of channels) {
    try {
      summaries.push(await scanChannel(client, conf, ctx));
    } catch (err) {
      ctx.logger.error({ err, channelId: conf.channel_id }, "Catch-up scan failed for channel");
    }
  }

  const raised = summaries.reduce((n, s) => n + s.raised, 0);
  if (raised > 0) ctx.logger.info({ raised, channels: summaries.length }, "Catch-up scan complete");
  return summaries;
}

async function scanChannel(
  client: Client,
  conf: AdderChannel,
  ctx: FeatureContext,
): Promise<BackfillSummary> {
  const store = createStore(ctx.db);
  const summary: BackfillSummary = {
    channelId: conf.channel_id,
    scanned: 0,
    raised: 0,
    skipped: 0,
    failed: 0,
    bootstrapped: false,
  };

  const channel = await client.channels.fetch(conf.channel_id).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) {
    ctx.logger.warn({ channelId: conf.channel_id }, "Catch-up scan: channel not readable");
    return summary;
  }
  const text = channel as TextChannel;

  // First time we have ever seen this channel: adopt the current position and
  // scan nothing. Reading full history here would retroactively invite everyone
  // ever mentioned in the channel, which is never what someone wants from
  // turning the bot on.
  if (!conf.last_scanned_message_id) {
    const latest = await text.messages.fetch({ limit: 1 }).catch(() => null);
    const newest = latest?.first();
    if (newest) store.setScanCursor(conf.channel_id, newest.id);
    summary.bootstrapped = true;
    ctx.logger.info(
      { channelId: conf.channel_id, cursor: newest?.id ?? null },
      "Catch-up scan: initialised cursor, skipping existing history",
    );
    return summary;
  }

  const cutoff = Date.now() - ctx.env.BACKFILL_MAX_AGE_HOURS * 3_600_000;
  let cursor = conf.last_scanned_message_id;
  let reachedCap = false;

  while (!reachedCap) {
    const batch = await text.messages
      .fetch({ after: cursor, limit: PAGE_SIZE })
      .catch((err: unknown) => {
        ctx.logger.warn({ err, channelId: conf.channel_id }, "Catch-up scan: fetch failed");
        return null;
      });
    if (!batch || batch.size === 0) break;

    // Ascending, so the cursor only ever moves forward.
    const ordered = [...batch.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    for (const message of ordered) {
      summary.scanned++;
      // Advance past every message we look at, successful or not. Leaving the
      // cursor behind a message that always fails would reprocess it forever.
      cursor = message.id;
      store.setScanCursor(conf.channel_id, cursor);

      if (message.createdTimestamp < cutoff) {
        summary.skipped++;
        continue;
      }
      if (!(await handleMissedMessage(message, conf, ctx, summary))) continue;

      if (summary.raised >= ctx.env.BACKFILL_MAX_PER_CHANNEL) {
        ctx.logger.warn(
          { channelId: conf.channel_id, cap: ctx.env.BACKFILL_MAX_PER_CHANNEL },
          "Catch-up scan hit its per-channel cap; remaining messages left unprocessed",
        );
        reachedCap = true;
        break;
      }
    }

    if (batch.size < PAGE_SIZE) break;
  }

  return summary;
}

/** Returns true if a request was actually raised. */
async function handleMissedMessage(
  message: Message,
  conf: AdderChannel,
  ctx: FeatureContext,
  summary: BackfillSummary,
): Promise<boolean> {
  if (message.author.bot || !message.inGuild()) {
    summary.skipped++;
    return false;
  }

  const parsed = extractSoleUsername(message.content);
  if (!parsed.ok) {
    summary.skipped++;
    return false;
  }

  try {
    const result = await runInviteFlow(
      {
        rawUsername: parsed.login,
        channel: conf,
        guildId: message.guildId,
        channelId: message.channelId,
        requesterId: message.author.id,
        client: message.client,
      },
      buildDeps(ctx),
    );

    const sent = await message
      .reply({
        embeds: [result.embed],
        components: result.components,
        allowedMentions: { repliedUser: false },
      })
      .catch(() => null);

    if (sent && result.mode === "moderator") {
      createStore(ctx.db).attachMessage(result.requestId, sent.id);
    } else if (!sent && result.mode === "moderator") {
      // No approval message means nobody can action it; do not strand the row.
      createStore(ctx.db).finish(
        result.requestId,
        "failed",
        "Could not post the approval message.",
      );
      summary.failed++;
      return false;
    }

    summary.raised++;
    return true;
  } catch (err) {
    const { userMessage, correlationId, internal } = presentError(err);
    if (internal !== null) {
      ctx.logger.error({ err: internal, correlationId }, "Catch-up scan: invite flow failed");
      summary.failed++;
    } else {
      // Already a member, cooldown, duplicate: expected during a catch-up, and
      // not worth replying to a message from hours ago.
      ctx.logger.debug({ reason: userMessage }, "Catch-up scan: skipped");
      summary.skipped++;
    }
    return false;
  }
}
