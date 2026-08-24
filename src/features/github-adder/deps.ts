import type { FeatureContext } from "../../core/feature.js";
import { createGitHubClient, type GitHubClient } from "../../lib/github.js";
import { createQuotaStore } from "../../lib/quota.js";
import type { ServiceDeps } from "./service.js";
import { createStore } from "./store.js";

/**
 * The Octokit client is built once and reused. Rebuilding it per command would
 * discard the cached installation token and mint a fresh JWT on every call.
 */
let githubClient: GitHubClient | null = null;

export function buildDeps(ctx: FeatureContext): ServiceDeps {
  githubClient ??= createGitHubClient(ctx.env, ctx.logger);
  return {
    github: githubClient,
    store: createStore(ctx.db),
    quota: createQuotaStore(ctx.db),
    env: ctx.env,
    logger: ctx.logger,
  };
}

/** Test seam: lets a suite inject a mocked Octokit. */
export function __setGitHubClient(client: GitHubClient | null): void {
  githubClient = client;
}
