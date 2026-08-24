/**
 * GitHub logins: alphanumerics and single interior hyphens, 1-39 chars.
 * Matching this before touching the API means ordinary chat in a watched
 * channel costs nothing and never produces an error message.
 */
const GITHUB_LOGIN = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;

/**
 * Reserved github.com paths. Without this, "https://github.com/settings" or a
 * stray "about" parses as a username and burns an API call -- and some of these
 * do resolve to real accounts.
 */
const RESERVED = new Set([
  "about",
  "account",
  "admin",
  "api",
  "apps",
  "blog",
  "business",
  "careers",
  "collections",
  "contact",
  "customer-stories",
  "dashboard",
  "developer",
  "discussions",
  "download",
  "enterprise",
  "events",
  "explore",
  "features",
  "get-started",
  "gist",
  "git",
  "help",
  "home",
  "issues",
  "join",
  "login",
  "logout",
  "marketplace",
  "new",
  "news",
  "notifications",
  "orgs",
  "organizations",
  "pricing",
  "privacy",
  "pulls",
  "readme",
  "search",
  "security",
  "sessions",
  "settings",
  "signup",
  "site",
  "sponsors",
  "stars",
  "status",
  "support",
  "team",
  "teams",
  "terms",
  "topics",
  "trending",
  "user",
  "users",
  "watching",
]);

export type ParseResult =
  { ok: true; login: string } | { ok: false; reason: "empty" | "not-a-username" | "reserved" };

/**
 * Extracts a GitHub login from whatever a user typed: a bare handle, an
 * @handle, or a full profile URL with tracking params attached.
 */
export function parseGitHubUsername(input: string): ParseResult {
  let value = input.trim();
  if (!value) return { ok: false, reason: "empty" };

  // Discord auto-links URLs and users often paste them wrapped in <>.
  value = value.replace(/^<+/, "").replace(/>+$/, "");

  // Full or partial profile URL -> take the first path segment.
  const urlMatch = value.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/?#\s]+)/i);
  if (urlMatch?.[1]) {
    value = urlMatch[1];
  }

  value = value.replace(/^@/, "").replace(/\/+$/, "").split(/[?#]/)[0] ?? "";
  if (!value) return { ok: false, reason: "empty" };

  if (!GITHUB_LOGIN.test(value)) return { ok: false, reason: "not-a-username" };
  if (RESERVED.has(value.toLowerCase())) return { ok: false, reason: "reserved" };

  return { ok: true, login: value };
}

/**
 * Scans a chat message for a username, preferring unambiguous signals.
 *
 * Ordinary words ("hi", "please", "thanks") are all valid-looking GitHub
 * logins, so scanning every token in a sentence produces false positives. The
 * rule instead is: a github.com URL anywhere in the message wins outright,
 * otherwise the message must be a single bare token. Anything else is treated
 * as conversation and ignored silently -- no error, no noise in the channel.
 */
export function extractSoleUsername(content: string): ParseResult {
  const trimmed = content.trim();
  if (!trimmed) return { ok: false, reason: "empty" };

  // A pasted profile URL is an unambiguous intent signal, even mid-sentence.
  const urls = [...trimmed.matchAll(/(?:https?:\/\/)?(?:www\.)?github\.com\/[^\s<>]+/gi)];
  if (urls.length === 1) return parseGitHubUsername(urls[0]![0]);
  if (urls.length > 1) return { ok: false, reason: "not-a-username" };

  // Otherwise only a message that is *nothing but* a handle counts.
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length !== 1) return { ok: false, reason: "not-a-username" };

  return parseGitHubUsername(tokens[0]!);
}
