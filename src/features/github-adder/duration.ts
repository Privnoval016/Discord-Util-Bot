/**
 * Parses the auto-approve window.
 *
 * Two shapes are allowed: a bounded window like "30m"/"2h" that reverts on its
 * own, or an explicit "permanent" that does not. Permanent has to be typed in
 * full -- it is the one setting that leaves the org open indefinitely, so it
 * should never be reachable by fat-fingering a duration.
 */
const MAX_TIMED_MS = 24 * 60 * 60 * 1000;

const PERMANENT_WORDS = new Set(["permanent", "forever", "always", "none", "off"]);

export type AutoWindow = { kind: "timed"; ms: number } | { kind: "permanent" };

export function parseAutoWindow(input: string): AutoWindow | null {
  const value = input.trim().toLowerCase();
  if (!value) return null;

  if (PERMANENT_WORDS.has(value)) return { kind: "permanent" };

  const ms = parseDuration(value);
  return ms === null ? null : { kind: "timed", ms };
}

/** Bounded durations only. Returns null for anything over the 24h ceiling. */
export function parseDuration(input: string): number | null {
  const match = input.trim().match(/^(\d+)\s*(s|m|h|d)$/i);
  if (!match) return null;

  const value = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  if (!Number.isFinite(value) || value <= 0) return null;

  const multiplier = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit]!;
  const ms = value * multiplier;

  // Past a day it is not a "window" any more; say "permanent" and mean it.
  return ms > MAX_TIMED_MS ? null : ms;
}

export function formatDuration(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.round((ms % 3_600_000) / 60_000);
  if (hours && minutes) return `${hours}h ${minutes}m`;
  if (hours) return `${hours}h`;
  return `${minutes}m`;
}
