import { RequestError } from "@octokit/request-error";
import type { Env } from "../../core/env.js";
import { UserFacingError } from "../../core/errors.js";
import type { Logger } from "../../core/logger.js";
import type { GitHubClient } from "../../lib/github.js";
import { nextResetUnix, type QuotaStore } from "../../lib/quota.js";
import type { Store } from "./store.js";
import { parseGitHubUsername } from "./username.js";

export interface ResolvedUser {
  login: string;
  id: number;
  avatarUrl: string;
  htmlUrl: string;
  name: string | null;
}

export interface ServiceDeps {
  github: GitHubClient;
  store: Store;
  quota: QuotaStore;
  env: Env;
  logger: Logger;
}

/**
 * Turns raw user input into a confirmed GitHub account that is eligible to be
 * invited. Every rejection is a UserFacingError so the caller can surface it
 * verbatim without leaking API internals.
 */
export async function resolveInvitee(
  input: string,
  org: string,
  deps: ServiceDeps,
): Promise<ResolvedUser> {
  const parsed = parseGitHubUsername(input);
  if (!parsed.ok) {
    throw new UserFacingError(
      parsed.reason === "reserved"
        ? "That's a reserved GitHub page, not a username."
        : "That doesn't look like a GitHub username.",
      "Usernames are 1-39 letters, digits, or single hyphens.",
    );
  }

  const user = await fetchUser(parsed.login, deps);

  // Organizations and bot accounts resolve from /users/{login} too, and
  // inviting one fails in a confusing way further down.
  if (user.type !== "User") {
    throw new UserFacingError(`\`${user.login}\` is a ${user.type.toLowerCase()}, not a person.`);
  }

  await assertNotAlreadyInOrg(user.login, org, deps);

  return {
    login: user.login,
    id: user.id,
    avatarUrl: user.avatar_url,
    htmlUrl: user.html_url,
    name: user.name ?? null,
  };
}

async function fetchUser(login: string, deps: ServiceDeps) {
  try {
    const { data } = await deps.github.rest.users.getByUsername({ username: login });
    return data;
  } catch (err) {
    if (err instanceof RequestError && err.status === 404) {
      throw new UserFacingError(`No GitHub account named \`${login}\` exists.`);
    }
    throw err;
  }
}

async function assertNotAlreadyInOrg(login: string, org: string, deps: ServiceDeps): Promise<void> {
  try {
    const { data } = await deps.github.rest.orgs.getMembershipForUser({ org, username: login });
    if (data.state === "active") {
      throw new UserFacingError(`\`${login}\` is already a member of ${org}.`);
    }
    if (data.state === "pending") {
      throw new UserFacingError(
        `\`${login}\` already has a pending invitation to ${org}.`,
        "They need to accept it from their GitHub notifications or email.",
      );
    }
  } catch (err) {
    // 404 is the success case here: no membership record means they can be invited.
    if (err instanceof RequestError && err.status === 404) return;
    throw err;
  }
}

/** Per-user throttles. Separate from the org quota: this limits one person. */
export function assertUserMayRequest(discordUserId: string, deps: ServiceDeps): void {
  if (deps.store.openRequestCount(discordUserId) > 0) {
    throw new UserFacingError(
      "You already have a request waiting for a moderator.",
      "Wait for it to be approved or denied before submitting another.",
    );
  }

  const last = deps.store.lastRequestAt(discordUserId);
  const cooldownMs = deps.env.INVITE_COOLDOWN_SECONDS * 1000;
  if (last !== null && Date.now() - last < cooldownMs) {
    const readyAt = Math.floor((last + cooldownMs) / 1000);
    throw new UserFacingError(`You're doing that too fast. Try again <t:${readyAt}:R>.`);
  }
}

export function assertQuotaAvailable(org: string, deps: ServiceDeps): void {
  const remaining = deps.quota.remaining(org, deps.env.GITHUB_DAILY_INVITE_LIMIT);
  if (remaining <= 0) {
    throw new UserFacingError(
      `The daily invite budget for ${org} is used up.`,
      `It resets <t:${nextResetUnix()}:R>.`,
    );
  }
}

/**
 * Sends the invitation.
 *
 * Uses `invitee_id` rather than the login: GitHub's endpoint requires the
 * numeric ID, and pinning to it closes the window where an account is renamed
 * between resolution and approval.
 */
export async function sendInvitation(
  user: ResolvedUser,
  org: string,
  deps: ServiceDeps,
): Promise<void> {
  if (deps.env.GITHUB_DRY_RUN) {
    deps.logger.info(
      { org, login: user.login, inviteeId: user.id, dryRun: true },
      "DRY RUN: would invite user to org",
    );
    // Deliberately does NOT spend quota: no invitation left our process, so
    // charging the real daily budget for it would be a lie.
    return;
  }

  try {
    await deps.github.rest.orgs.createInvitation({
      org,
      invitee_id: user.id,
      role: "direct_member",
    });
    deps.quota.record(org);
    deps.logger.info({ org, login: user.login, inviteeId: user.id }, "Invitation sent");
  } catch (err) {
    throw translateInviteError(err, org, deps.logger);
  }
}

/**
 * Maps GitHub failures to messages safe for a public channel. Raw error bodies
 * are logged, never echoed -- they carry request URLs and org internals.
 */
function translateInviteError(err: unknown, org: string, logger: Logger): unknown {
  if (!(err instanceof RequestError)) return err;

  logger.error({ err, status: err.status, org }, "GitHub invitation failed");

  switch (err.status) {
    case 401:
    case 403:
      return new UserFacingError(
        "I'm not authorized to invite people to that organization.",
        "Check the GitHub App is installed on the org with Members: write.",
      );
    case 404:
      return new UserFacingError(
        `I can't reach the ${org} organization.`,
        "Either the name is wrong or the GitHub App isn't installed there.",
      );
    case 422:
      return new UserFacingError(
        "GitHub rejected the invitation.",
        "This is usually the daily invite limit, or the account is blocked by the org.",
      );
    default:
      return err;
  }
}

/** Auto-mode is time-boxed; an expired window silently reverts to moderator. */
export function effectiveMode(
  approvalMode: string,
  autoModeExpiresAt: number | null,
  now = Date.now(),
): "moderator" | "auto" {
  if (approvalMode !== "auto") return "moderator";
  if (autoModeExpiresAt !== null && autoModeExpiresAt <= now) return "moderator";
  return "auto";
}

/**
 * Cancels a pending organization invitation.
 *
 * Uses the membership endpoint rather than looking up an invitation_id: it
 * takes the login directly, and cancels a pending invite (a 404 just means
 * there was nothing outstanding, which is a success for our purposes).
 */
export async function cancelInvitation(
  login: string,
  org: string,
  deps: ServiceDeps,
): Promise<"cancelled" | "nothing-pending"> {
  try {
    await deps.github.rest.orgs.removeMembershipForUser({ org, username: login });
    deps.logger.info({ org, login }, "Cancelled organization invitation");
    return "cancelled";
  } catch (err) {
    if (err instanceof RequestError && err.status === 404) return "nothing-pending";
    throw translateInviteError(err, org, deps.logger);
  }
}

export interface PendingInvitation {
  login: string;
  createdAtUnix: number;
}

/**
 * Invitations GitHub is still holding open.
 *
 * Distinct from our local `pending` state: these have already been sent and are
 * waiting on the invitee to accept, whereas a local pending request has not
 * been sent at all.
 */
export async function listPendingInvitations(
  org: string,
  deps: ServiceDeps,
): Promise<PendingInvitation[]> {
  const { data } = await deps.github.rest.orgs.listPendingInvitations({ org, per_page: 50 });
  return data
    .filter((i): i is typeof i & { login: string } => typeof i.login === "string")
    .map((i) => ({
      login: i.login,
      createdAtUnix: Math.floor(new Date(i.created_at).getTime() / 1000),
    }));
}
