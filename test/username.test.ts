import { describe, expect, it } from "vitest";
import { extractSoleUsername, parseGitHubUsername } from "../src/features/github-adder/username.js";

const ok = (input: string) => {
  const r = parseGitHubUsername(input);
  return r.ok ? r.login : `FAIL:${r.reason}`;
};

describe("parseGitHubUsername", () => {
  it("accepts bare logins", () => {
    expect(ok("octocat")).toBe("octocat");
    expect(ok("a")).toBe("a");
    expect(ok("Pranav-Sukesh")).toBe("Pranav-Sukesh");
    expect(ok("user123")).toBe("user123");
  });

  it("strips @ and surrounding whitespace", () => {
    expect(ok("  @octocat  ")).toBe("octocat");
  });

  it("extracts from profile URLs in every shape people paste", () => {
    expect(ok("https://github.com/octocat")).toBe("octocat");
    expect(ok("http://github.com/octocat")).toBe("octocat");
    expect(ok("github.com/octocat")).toBe("octocat");
    expect(ok("www.github.com/octocat/")).toBe("octocat");
    expect(ok("https://github.com/octocat?tab=repositories")).toBe("octocat");
    expect(ok("<https://github.com/octocat>")).toBe("octocat");
    // A repo URL still yields the owner, which is the intended read.
    expect(ok("https://github.com/octocat/hello-world")).toBe("octocat");
  });

  it("rejects malformed logins", () => {
    expect(ok("")).toBe("FAIL:empty");
    expect(ok("-leading")).toBe("FAIL:not-a-username");
    expect(ok("trailing-")).toBe("FAIL:not-a-username");
    expect(ok("double--hyphen")).toBe("FAIL:not-a-username");
    expect(ok("has_underscore")).toBe("FAIL:not-a-username");
    expect(ok("has space")).toBe("FAIL:not-a-username");
    expect(ok("emoji😀")).toBe("FAIL:not-a-username");
    expect(ok("a".repeat(40))).toBe("FAIL:not-a-username");
  });

  it("accepts exactly 39 characters, the documented max", () => {
    expect(ok("a".repeat(39))).toBe("a".repeat(39));
  });

  it("rejects reserved github.com paths", () => {
    expect(ok("settings")).toBe("FAIL:reserved");
    expect(ok("https://github.com/features")).toBe("FAIL:reserved");
    expect(ok("SETTINGS")).toBe("FAIL:reserved");
  });
});

describe("extractSoleUsername", () => {
  it("takes a URL anywhere in a sentence", () => {
    const r = extractSoleUsername("hi please add https://github.com/octocat thanks!");
    expect(r.ok && r.login).toBe("octocat");
  });

  it("resolves a bare username on its own", () => {
    const r = extractSoleUsername("  octocat  ");
    expect(r.ok && r.login).toBe("octocat");
  });

  it("ignores prose with no URL and no lone handle", () => {
    expect(extractSoleUsername("hey does anyone know how this works").ok).toBe(false);
    expect(extractSoleUsername("please add me").ok).toBe(false);
  });

  it("refuses when several URLs are present", () => {
    expect(extractSoleUsername("github.com/octocat and github.com/defunkt").ok).toBe(false);
  });

  it("refuses an empty message", () => {
    expect(extractSoleUsername("   ").ok).toBe(false);
  });

  it("still rejects a lone reserved path", () => {
    const r = extractSoleUsername("settings");
    expect(r.ok).toBe(false);
  });
});

describe("parseAutoWindow", () => {
  it("parses bounded windows", async () => {
    const { parseAutoWindow } = await import("../src/features/github-adder/duration.js");
    expect(parseAutoWindow("30m")).toEqual({ kind: "timed", ms: 1_800_000 });
    expect(parseAutoWindow("2h")).toEqual({ kind: "timed", ms: 7_200_000 });
    expect(parseAutoWindow("1d")).toEqual({ kind: "timed", ms: 86_400_000 });
    expect(parseAutoWindow(" 45 M ")).toEqual({ kind: "timed", ms: 2_700_000 });
  });

  it("recognizes permanent, spelled several ways", async () => {
    const { parseAutoWindow } = await import("../src/features/github-adder/duration.js");
    for (const word of ["permanent", "Permanent", "forever", "always", "none", "off"]) {
      expect(parseAutoWindow(word)).toEqual({ kind: "permanent" });
    }
  });

  it("refuses windows over the 24h ceiling rather than silently capping", async () => {
    const { parseAutoWindow } = await import("../src/features/github-adder/duration.js");
    expect(parseAutoWindow("2d")).toBeNull();
    expect(parseAutoWindow("25h")).toBeNull();
  });

  it("refuses junk and zero", async () => {
    const { parseAutoWindow } = await import("../src/features/github-adder/duration.js");
    expect(parseAutoWindow("0h")).toBeNull();
    expect(parseAutoWindow("soon")).toBeNull();
    expect(parseAutoWindow("")).toBeNull();
  });
});
