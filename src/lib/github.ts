import { createAppAuth } from "@octokit/auth-app";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { Octokit } from "@octokit/rest";
import type { Env } from "../core/env.js";
import type { Logger } from "../core/logger.js";

const BotOctokit = Octokit.plugin(retry, throttling);
export type GitHubClient = InstanceType<typeof BotOctokit>;

/**
 * Octokit authenticated as a GitHub App installation.
 *
 * Installation tokens live one hour and are minted and refreshed by
 * @octokit/auth-app on demand, so nothing long-lived sits in memory and the
 * credential can be revoked from the org without touching a personal account.
 */
export function createGitHubClient(env: Env, logger: Logger): GitHubClient {
  return new BotOctokit({
    authStrategy: createAppAuth,
    auth: {
      appId: Number(env.GITHUB_APP_ID),
      privateKey: env.githubPrivateKey,
      installationId: Number(env.GITHUB_INSTALLATION_ID),
    },
    throttle: {
      onRateLimit: (retryAfter, options, _octokit, retryCount) => {
        logger.warn({ retryAfter, retryCount, method: options.method }, "GitHub rate limit hit");
        return retryCount < 2; // retry twice, then surface it
      },
      onSecondaryRateLimit: (retryAfter, options, _octokit, retryCount) => {
        logger.warn(
          { retryAfter, retryCount, method: options.method },
          "GitHub secondary rate limit",
        );
        return retryCount < 1;
      },
    },
  });
}
