import { readFileSync } from "node:fs";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv({ quiet: true });

/**
 * Discord snowflakes are 64-bit ints rendered as strings. Validating the shape
 * here turns "why does nothing register?" into a startup error naming the var.
 */
const snowflake = z.string().regex(/^\d{17,20}$/, "must be a Discord ID (17-20 digits)");

const booleanish = z
  .string()
  .transform((v) => v.trim().toLowerCase())
  .pipe(z.enum(["true", "false", "1", "0", "yes", "no"]))
  .transform((v) => v === "true" || v === "1" || v === "yes");

const schema = z.object({
  // --- Discord ---
  DISCORD_TOKEN: z.string().min(50, "looks too short to be a bot token"),
  DISCORD_APP_ID: snowflake,
  DEV_GUILD_ID: z.union([snowflake, z.literal("")]).optional(),

  // --- GitHub App ---
  GITHUB_APP_ID: z.string().regex(/^\d+$/, "must be numeric"),
  GITHUB_ORG: z.string().min(1),
  GITHUB_INSTALLATION_ID: z.string().regex(/^\d+$/, "must be numeric"),
  GITHUB_APP_PRIVATE_KEY_PATH: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),

  // --- Behavior ---
  GITHUB_DRY_RUN: booleanish.default(true),
  GITHUB_DAILY_INVITE_LIMIT: z.coerce.number().int().positive().max(500).default(40),
  INVITE_COOLDOWN_SECONDS: z.coerce.number().int().nonnegative().default(60),
  /** Pending requests older than this are retired so they stop blocking the requester. */
  REQUEST_EXPIRY_HOURS: z.coerce.number().int().positive().max(8760).default(168),

  // --- Catch-up scan (messages posted while the bot was offline) ---
  BACKFILL_ENABLED: booleanish.default(true),
  /** Ignore missed messages older than this, however far behind the cursor is. */
  BACKFILL_MAX_AGE_HOURS: z.coerce.number().int().positive().max(720).default(72),
  /** Hard ceiling on requests raised per channel per startup. */
  BACKFILL_MAX_PER_CHANNEL: z.coerce.number().int().positive().max(200).default(25),

  // --- Runtime ---
  DATA_DIR: z.string().default("./data"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
});

export type Env = z.infer<typeof schema> & { githubPrivateKey: string };

/**
 * The private key may arrive as a file path (local dev) or base64-encoded in the
 * environment (hosts that only accept env vars). Normalize both into one PEM
 * string so nothing downstream has to care which was used.
 */
function resolvePrivateKey(raw: z.infer<typeof schema>): string {
  if (raw.GITHUB_APP_PRIVATE_KEY_PATH) {
    let contents: string;
    try {
      contents = readFileSync(raw.GITHUB_APP_PRIVATE_KEY_PATH, "utf8");
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Could not read GITHUB_APP_PRIVATE_KEY_PATH: ${reason}`);
    }
    if (!contents.includes("BEGIN") || !contents.includes("PRIVATE KEY")) {
      throw new Error("GITHUB_APP_PRIVATE_KEY_PATH does not point at a PEM private key.");
    }
    return contents;
  }

  if (raw.GITHUB_APP_PRIVATE_KEY) {
    const value = raw.GITHUB_APP_PRIVATE_KEY.trim();
    // Accept a raw PEM too, in case someone pasted it with real newlines.
    const decoded = value.includes("BEGIN")
      ? value.replace(/\\n/g, "\n")
      : Buffer.from(value, "base64").toString("utf8");
    if (!decoded.includes("BEGIN") || !decoded.includes("PRIVATE KEY")) {
      throw new Error("GITHUB_APP_PRIVATE_KEY is not a valid PEM (or base64 of one).");
    }
    return decoded;
  }

  throw new Error(
    "Missing GitHub App private key: set GITHUB_APP_PRIVATE_KEY_PATH or GITHUB_APP_PRIVATE_KEY.",
  );
}

/**
 * Validates the whole environment up front and exits with a readable report if
 * anything is wrong. A bot that boots half-configured fails later, in production,
 * in the middle of someone's request -- so we refuse to start at all.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);

  if (!parsed.success) {
    const lines = parsed.error.issues.map((issue) => {
      const key = issue.path.join(".") || "(root)";
      // zod renders a missing var as "expected string, received undefined",
      // which buries the actual problem. Say what the user needs to hear.
      const missing = issue.code === "invalid_type" && /received undefined/.test(issue.message);
      return `  - ${key}: ${missing ? "missing (required)" : issue.message}`;
    });
    // Deliberately not a thrown stack trace: this is a config problem, and a
    // stack trace here buries the actionable part and can echo surrounding values.
    console.error(
      [
        "",
        "Configuration error. Fix these in your .env file:",
        ...lines,
        "",
        "See .env.example for the full list.",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }

  let githubPrivateKey: string;
  try {
    githubPrivateKey = resolvePrivateKey(parsed.data);
  } catch (err) {
    console.error(`\nConfiguration error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  return { ...parsed.data, githubPrivateKey };
}
