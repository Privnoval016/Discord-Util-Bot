import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { createStore, type Store } from "../src/features/github-adder/store.js";
import { createQuotaStore, utcDay } from "../src/lib/quota.js";
import { effectiveMode } from "../src/features/github-adder/service.js";

let db: DatabaseSync;
let store: Store;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  store = createStore(db);
});

const newRequest = (overrides: Partial<Parameters<Store["createRequest"]>[0]> = {}) =>
  store.createRequest({
    guildId: "g1",
    channelId: "c1",
    messageId: null,
    discordUserId: "u1",
    githubLogin: "octocat",
    githubUserId: 583231,
    org: "acme",
    status: "pending",
    dryRun: false,
    ...overrides,
  });

describe("decision transitions", () => {
  it("lets exactly one caller win a pending request", () => {
    const id = newRequest();
    expect(store.decide(id, "approved", "mod1")).toBe(true);
    // Second click -- the double-approve case that would double-invite.
    expect(store.decide(id, "approved", "mod2")).toBe(false);
    expect(store.decide(id, "denied", "mod2")).toBe(false);
    expect(store.getRequest(id)?.decided_by).toBe("mod1");
  });

  it("records the terminal outcome", () => {
    const id = newRequest();
    store.decide(id, "approved", "mod1");
    store.finish(id, "sent", null);
    expect(store.getRequest(id)?.status).toBe("sent");
  });

  it("preserves the failure reason", () => {
    const id = newRequest();
    store.decide(id, "approved", "mod1");
    store.finish(id, "failed", "GitHub rejected the invitation.");
    const row = store.getRequest(id);
    expect(row?.status).toBe("failed");
    expect(row?.error).toContain("rejected");
  });
});

describe("duplicate suppression", () => {
  it("finds an open request for the same GitHub account", () => {
    newRequest();
    expect(store.findOpenRequestFor("acme", 583231, false)).not.toBeNull();
  });

  it("scopes duplicates per org", () => {
    newRequest();
    expect(store.findOpenRequestFor("other-org", 583231, false)).toBeNull();
  });

  it("stops blocking once the request is denied", () => {
    const id = newRequest();
    store.decide(id, "denied", "mod1");
    expect(store.findOpenRequestFor("acme", 583231, false)).toBeNull();
  });

  it("still blocks after a successful send", () => {
    const id = newRequest();
    store.decide(id, "approved", "mod1");
    store.finish(id, "sent", null);
    expect(store.findOpenRequestFor("acme", 583231, false)).not.toBeNull();
  });

  it("counts only pending requests toward a user's open limit", () => {
    const id = newRequest();
    expect(store.openRequestCount("u1")).toBe(1);
    store.decide(id, "denied", "mod1");
    expect(store.openRequestCount("u1")).toBe(0);
  });
});

describe("channel config", () => {
  it("round-trips setup and disable", () => {
    store.addAdderChannel("c1", "g1", "acme", "admin1");
    expect(store.getAdderChannel("c1")?.org).toBe("acme");
    store.disableAdderChannel("c1");
    expect(store.getAdderChannel("c1")).toBeNull();
  });

  it("re-enables a previously disabled channel on re-setup", () => {
    store.addAdderChannel("c1", "g1", "acme", "admin1");
    store.disableAdderChannel("c1");
    store.addAdderChannel("c1", "g1", "acme", "admin1");
    expect(store.getAdderChannel("c1")).not.toBeNull();
  });

  it("stores the approval mode and its expiry", () => {
    store.addAdderChannel("c1", "g1", "acme", "admin1");
    const expires = Date.now() + 3_600_000;
    store.setApprovalMode("c1", "auto", expires);
    const row = store.getAdderChannel("c1");
    expect(row?.approval_mode).toBe("auto");
    expect(row?.auto_mode_expires_at).toBe(expires);
  });
});

describe("effectiveMode", () => {
  const now = 1_000_000;

  it("stays moderator when configured so", () => {
    expect(effectiveMode("moderator", null, now)).toBe("moderator");
  });

  it("honors an unexpired auto window", () => {
    expect(effectiveMode("auto", now + 60_000, now)).toBe("auto");
  });

  it("reverts to moderator once the window lapses", () => {
    expect(effectiveMode("auto", now - 1, now)).toBe("moderator");
  });

  it("treats the exact expiry instant as expired", () => {
    expect(effectiveMode("auto", now, now)).toBe("moderator");
  });
});

describe("quota", () => {
  it("counts up and reports what's left", () => {
    const quota = createQuotaStore(db);
    expect(quota.remaining("acme", 3)).toBe(3);
    quota.record("acme");
    quota.record("acme");
    expect(quota.used("acme")).toBe(2);
    expect(quota.remaining("acme", 3)).toBe(1);
  });

  it("never reports negative headroom", () => {
    const quota = createQuotaStore(db);
    for (let i = 0; i < 5; i++) quota.record("acme");
    expect(quota.remaining("acme", 3)).toBe(0);
  });

  it("is scoped per day, so the budget rolls over", () => {
    const quota = createQuotaStore(db);
    quota.record("acme", "2026-08-24");
    expect(quota.used("acme", "2026-08-24")).toBe(1);
    expect(quota.used("acme", "2026-08-25")).toBe(0);
  });

  it("keys the current day in UTC", () => {
    expect(utcDay(new Date("2026-08-24T23:59:59Z"))).toBe("2026-08-24");
    expect(utcDay(new Date("2026-08-25T00:00:01Z"))).toBe("2026-08-25");
  });
});

describe("permanent auto mode", () => {
  it("never expires when no expiry is stored", () => {
    const farFuture = Date.now() + 365 * 86_400_000;
    expect(effectiveMode("auto", null, farFuture)).toBe("auto");
  });

  it("round-trips through the store as a null expiry", () => {
    store.addAdderChannel("c1", "g1", "acme", "admin1");
    store.setApprovalMode("c1", "auto", null);
    const row = store.getAdderChannel("c1")!;
    expect(row.approval_mode).toBe("auto");
    expect(row.auto_mode_expires_at).toBeNull();
    expect(effectiveMode(row.approval_mode, row.auto_mode_expires_at)).toBe("auto");
  });

  it("can be turned back off", () => {
    store.addAdderChannel("c1", "g1", "acme", "admin1");
    store.setApprovalMode("c1", "auto", null);
    store.setApprovalMode("c1", "moderator", null);
    const row = store.getAdderChannel("c1")!;
    expect(effectiveMode(row.approval_mode, row.auto_mode_expires_at)).toBe("moderator");
  });
});

describe("dry-run ledger separation", () => {
  it("a dry-run record does not block a real invite", () => {
    newRequest({ status: "sent", dryRun: true });
    // This is the bug that stranded a real invite behind a dry-run record.
    expect(store.findOpenRequestFor("acme", 583231, false)).toBeNull();
  });

  it("a real record does not block a dry run", () => {
    newRequest({ status: "sent", dryRun: false });
    expect(store.findOpenRequestFor("acme", 583231, true)).toBeNull();
  });

  it("each ledger still blocks duplicates within itself", () => {
    newRequest({ status: "sent", dryRun: true });
    expect(store.findOpenRequestFor("acme", 583231, true)).not.toBeNull();
  });
});

describe("revoke", () => {
  it("clears an open request so the user can retry", () => {
    const id = newRequest({ status: "sent" });
    expect(store.findOpenRequestFor("acme", 583231, false)).not.toBeNull();
    store.revoke(id, "revoked by admin");
    expect(store.findOpenRequestFor("acme", 583231, false)).toBeNull();
    expect(store.getRequest(id)?.status).toBe("denied");
  });

  it("finds an open request by login, case-insensitively", () => {
    newRequest({ githubLogin: "OctoCat" });
    expect(store.findOpenRequestByLogin("acme", "octocat")?.github_login).toBe("OctoCat");
  });

  it("ignores already-resolved requests when looking up by login", () => {
    const id = newRequest();
    store.revoke(id, "gone");
    expect(store.findOpenRequestByLogin("acme", "octocat")).toBeNull();
  });
});

describe("stale request expiry", () => {
  const HOUR = 3_600_000;

  it("retires a pending request nobody actioned", () => {
    const id = newRequest();
    // Backdate it past the window.
    db.prepare("UPDATE invite_request SET created_at = ? WHERE id = ?").run(
      Date.now() - 200 * HOUR,
      id,
    );
    expect(store.openRequestCount("u1")).toBe(1);

    const swept = store.expireStale(Date.now() - 168 * HOUR);
    expect(swept).toBe(1);
    // The whole point: the requester is unstuck.
    expect(store.openRequestCount("u1")).toBe(0);
    expect(store.getRequest(id)?.status).toBe("failed");
  });

  it("leaves a fresh request alone", () => {
    newRequest();
    expect(store.expireStale(Date.now() - 168 * HOUR)).toBe(0);
    expect(store.openRequestCount("u1")).toBe(1);
  });

  it("does not touch already-resolved requests", () => {
    const id = newRequest();
    store.decide(id, "approved", "mod");
    store.finish(id, "sent", null);
    db.prepare("UPDATE invite_request SET created_at = ? WHERE id = ?").run(
      Date.now() - 200 * HOUR,
      id,
    );
    expect(store.expireStale(Date.now() - 168 * HOUR)).toBe(0);
    expect(store.getRequest(id)?.status).toBe("sent");
  });

  it("lists pending requests for the guild", () => {
    newRequest();
    newRequest({ discordUserId: "u2", githubLogin: "defunkt", githubUserId: 2 });
    expect(store.listPendingRequests("g1")).toHaveLength(2);
    expect(store.listPendingRequests("other-guild")).toHaveLength(0);
  });
});

describe("catch-up scan cursor", () => {
  it("starts null so a new channel is bootstrapped, not back-scanned", () => {
    store.addAdderChannel("c1", "g1", "acme", "admin1");
    expect(store.getAdderChannel("c1")?.last_scanned_message_id).toBeNull();
  });

  it("round-trips the cursor", () => {
    store.addAdderChannel("c1", "g1", "acme", "admin1");
    store.setScanCursor("c1", "111111111111111111");
    expect(store.getAdderChannel("c1")?.last_scanned_message_id).toBe("111111111111111111");
  });

  it("survives a re-setup of the same channel", () => {
    store.addAdderChannel("c1", "g1", "acme", "admin1");
    store.setScanCursor("c1", "999");
    // Re-running setup must not rewind the cursor and replay history.
    store.addAdderChannel("c1", "g1", "acme", "admin1");
    expect(store.getAdderChannel("c1")?.last_scanned_message_id).toBe("999");
  });

  it("lists channels across guilds for the startup scan", () => {
    store.addAdderChannel("c1", "g1", "acme", "admin1");
    store.addAdderChannel("c2", "g2", "acme", "admin1");
    expect(store.listAllEnabledChannels()).toHaveLength(2);
    store.disableAdderChannel("c2");
    expect(store.listAllEnabledChannels()).toHaveLength(1);
  });
});
