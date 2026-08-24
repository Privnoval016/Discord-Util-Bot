import pino from "pino";

/**
 * Paths scrubbed from every log record. Adding a secret to the environment
 * without adding it here is how tokens end up in log aggregators, so keep this
 * list in sync with env.ts.
 */
const REDACTED_PATHS = [
  "token",
  "DISCORD_TOKEN",
  "githubPrivateKey",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_PRIVATE_KEY_PATH",
  "privateKey",
  "authorization",
  "Authorization",
  "headers.authorization",
  "*.token",
  "*.authorization",
  "req.headers.authorization",
  "err.request.headers.authorization",
  "error.request.headers.authorization",
];

export type Logger = pino.Logger;

export function createLogger(opts: { level: string; pretty: boolean }): Logger {
  return pino({
    level: opts.level,
    redact: { paths: REDACTED_PATHS, censor: "[redacted]" },
    base: undefined, // drop pid/hostname; noise for a single-process bot
    ...(opts.pretty
      ? {
          transport: {
            target: "pino-pretty",
            options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" },
          },
        }
      : {}),
  });
}
