import { randomUUID } from "node:crypto";

/**
 * An error whose message is safe to show a Discord user verbatim.
 *
 * Everything else gets a generic message plus a correlation ID, because raw
 * upstream errors leak internals (org names, installation IDs, request URLs
 * with tokens in them) into a channel other people can read.
 */
export class UserFacingError extends Error {
  override readonly name = "UserFacingError";

  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

export function isUserFacing(err: unknown): err is UserFacingError {
  return err instanceof UserFacingError;
}

export function newCorrelationId(): string {
  return randomUUID().slice(0, 8);
}

/**
 * Splits any thrown value into what the user sees and what we log.
 * The `internal` half is never sent to Discord.
 */
export function presentError(err: unknown): {
  userMessage: string;
  correlationId: string | null;
  internal: unknown;
} {
  if (isUserFacing(err)) {
    const suffix = err.hint ? `\n-# ${err.hint}` : "";
    return { userMessage: `${err.message}${suffix}`, correlationId: null, internal: null };
  }

  const correlationId = newCorrelationId();
  return {
    userMessage: `Something went wrong on my end. Reference: \`${correlationId}\``,
    correlationId,
    internal: err,
  };
}
