import { RequestError } from "@octokit/request-error";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/core/env.js";
import { UserFacingError } from "../src/core/errors.js";
import { createStore } from "../src/features/github-adder/store.js";
import {
  assertQuotaAvailable,
  assertUserMayRequest,
  resolveInvitee,
  sendInvitation,
  type ServiceDeps,
} from "../src/features/github-adder/service.js";
import { createQuotaStore } from "../src/lib/quota.js";

const req = { method: "GET", url: "https://api.github.com/x", headers: {} } as never;
const httpError = (status: number) => new RequestError(`HTTP ${status}`, status, { request: req });

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
} as unknown as ServiceDeps["logger"];

function makeDeps(
  overrides: {
    getByUsername?: unknown;
    getMembership?: unknown;
    createInvitation?: unknown;
    env?: Partial<Env>;
  } = {},
): ServiceDeps {
  const db = new DatabaseSync(":memory:");
  const github = {
    rest: {
      users: {
        getByUsername:
          overrides.getByUsername ??
          vi.fn().mockResolvedValue({
            data: {
              login: "octocat",
              id: 583231,
              type: "User",
              avatar_url: "https://a",
              html_url: "https://github.com/octocat",
              name: "The Octocat",
            },
          }),
      },
      orgs: {
        getMembershipForUser: overrides.getMembership ?? vi.fn().mockRejectedValue(httpError(404)),
        createInvitation: overrides.createInvitation ?? vi.fn().mockResolvedValue({ data: {} }),
      },
    },
  } as unknown as ServiceDeps["github"];

  return {
    github,
    store: createStore(db),
    quota: createQuotaStore(db),
    logger: silentLogger,
    env: {
      GITHUB_DRY_RUN: false,
      GITHUB_DAILY_INVITE_LIMIT: 40,
      INVITE_COOLDOWN_SECONDS: 60,
      ...overrides.env,
    } as Env,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("resolveInvitee", () => {
  it("resolves a valid, non-member account", async () => {
    const user = await resolveInvitee("octocat", "acme", makeDeps());
    expect(user).toMatchObject({ login: "octocat", id: 583231 });
  });

  it("accepts a profile URL", async () => {
    const user = await resolveInvitee("https://github.com/octocat", "acme", makeDeps());
    expect(user.login).toBe("octocat");
  });

  it("rejects malformed input before calling GitHub", async () => {
    const deps = makeDeps();
    await expect(resolveInvitee("not a username!", "acme", deps)).rejects.toBeInstanceOf(
      UserFacingError,
    );
    expect(deps.github.rest.users.getByUsername).not.toHaveBeenCalled();
  });

  it("rejects reserved paths before calling GitHub", async () => {
    const deps = makeDeps();
    await expect(resolveInvitee("settings", "acme", deps)).rejects.toThrow(/reserved/i);
    expect(deps.github.rest.users.getByUsername).not.toHaveBeenCalled();
  });

  it("reports a nonexistent account in plain language", async () => {
    const deps = makeDeps({ getByUsername: vi.fn().mockRejectedValue(httpError(404)) });
    await expect(resolveInvitee("ghost", "acme", deps)).rejects.toThrow(/No GitHub account named/);
  });

  it("refuses to invite an organization account", async () => {
    const deps = makeDeps({
      getByUsername: vi.fn().mockResolvedValue({
        data: {
          login: "github",
          id: 9919,
          type: "Organization",
          avatar_url: "",
          html_url: "",
          name: null,
        },
      }),
    });
    await expect(resolveInvitee("github", "acme", deps)).rejects.toThrow(/not a person/);
  });

  it("refuses to invite a bot account", async () => {
    const deps = makeDeps({
      getByUsername: vi.fn().mockResolvedValue({
        data: { login: "dependabot", id: 1, type: "Bot", avatar_url: "", html_url: "", name: null },
      }),
    });
    await expect(resolveInvitee("dependabot", "acme", deps)).rejects.toThrow(/not a person/);
  });

  it("stops when the account is already an active member", async () => {
    const deps = makeDeps({
      getMembership: vi.fn().mockResolvedValue({ data: { state: "active" } }),
    });
    await expect(resolveInvitee("octocat", "acme", deps)).rejects.toThrow(/already a member/);
  });

  it("stops when an invitation is already pending", async () => {
    const deps = makeDeps({
      getMembership: vi.fn().mockResolvedValue({ data: { state: "pending" } }),
    });
    await expect(resolveInvitee("octocat", "acme", deps)).rejects.toThrow(/already has a pending/);
  });

  it("propagates unexpected upstream errors instead of masking them", async () => {
    const deps = makeDeps({ getByUsername: vi.fn().mockRejectedValue(httpError(500)) });
    await expect(resolveInvitee("octocat", "acme", deps)).rejects.not.toBeInstanceOf(
      UserFacingError,
    );
  });
});

describe("sendInvitation", () => {
  const user = { login: "octocat", id: 583231, avatarUrl: "", htmlUrl: "", name: null };

  it("invites by numeric id, not login", async () => {
    const deps = makeDeps();
    await sendInvitation(user, "acme", deps);
    expect(deps.github.rest.orgs.createInvitation).toHaveBeenCalledWith({
      org: "acme",
      invitee_id: 583231,
      role: "direct_member",
    });
  });

  it("counts against the quota on success", async () => {
    const deps = makeDeps();
    await sendInvitation(user, "acme", deps);
    expect(deps.quota.used("acme")).toBe(1);
  });

  it("does not call GitHub in dry-run mode", async () => {
    const deps = makeDeps({ env: { GITHUB_DRY_RUN: true } });
    await sendInvitation(user, "acme", deps);
    expect(deps.github.rest.orgs.createInvitation).not.toHaveBeenCalled();
  });

  it("does not spend the real daily budget on a dry run", async () => {
    const deps = makeDeps({ env: { GITHUB_DRY_RUN: true } });
    await sendInvitation(user, "acme", deps);
    // Nothing left the process, so charging the real quota would be a lie.
    expect(deps.quota.used("acme")).toBe(0);
  });

  it("translates 403 into an authorization hint", async () => {
    const deps = makeDeps({ createInvitation: vi.fn().mockRejectedValue(httpError(403)) });
    await expect(sendInvitation(user, "acme", deps)).rejects.toThrow(/not authorized/i);
  });

  it("translates 422 into the daily-limit explanation", async () => {
    const deps = makeDeps({ createInvitation: vi.fn().mockRejectedValue(httpError(422)) });
    await expect(sendInvitation(user, "acme", deps)).rejects.toThrow(/rejected the invitation/i);
  });

  it("does not consume quota when the invite fails", async () => {
    const deps = makeDeps({ createInvitation: vi.fn().mockRejectedValue(httpError(422)) });
    await expect(sendInvitation(user, "acme", deps)).rejects.toThrow();
    expect(deps.quota.used("acme")).toBe(0);
  });

  it("never leaks the raw GitHub error text to the user", async () => {
    const deps = makeDeps({
      createInvitation: vi.fn().mockRejectedValue(
        new RequestError("https://api.github.com/orgs/secret-org/invitations failed", 403, {
          request: req,
        }),
      ),
    });
    await expect(sendInvitation(user, "acme", deps)).rejects.not.toThrow(/secret-org/);
  });
});

describe("throttles", () => {
  it("blocks a second request while one is pending", () => {
    const deps = makeDeps();
    deps.store.createRequest({
      guildId: "g",
      channelId: "c",
      messageId: null,
      discordUserId: "u1",
      githubLogin: "octocat",
      githubUserId: 1,
      org: "acme",
      status: "pending",
      dryRun: false,
    });
    expect(() => assertUserMayRequest("u1", deps)).toThrow(/already have a request/);
  });

  it("enforces the cooldown after a resolved request", () => {
    const deps = makeDeps();
    const id = deps.store.createRequest({
      guildId: "g",
      channelId: "c",
      messageId: null,
      discordUserId: "u1",
      githubLogin: "octocat",
      githubUserId: 1,
      org: "acme",
      status: "pending",
      dryRun: false,
    });
    deps.store.decide(id, "denied", "mod");
    expect(() => assertUserMayRequest("u1", deps)).toThrow(/too fast/);
  });

  it("lets an unknown user through", () => {
    expect(() => assertUserMayRequest("brand-new", makeDeps())).not.toThrow();
  });

  it("refuses once the daily budget is spent", () => {
    const deps = makeDeps({ env: { GITHUB_DAILY_INVITE_LIMIT: 2 } });
    deps.quota.record("acme");
    deps.quota.record("acme");
    expect(() => assertQuotaAvailable("acme", deps)).toThrow(/budget/i);
  });
});
