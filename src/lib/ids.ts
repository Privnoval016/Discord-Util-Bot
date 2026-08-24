/**
 * Typed encode/decode for component custom_ids.
 *
 * Discord caps custom_id at 100 characters and gives us nothing else to carry
 * state on a button, so the format is `<feature>:<action>:<arg>`. Parsing is
 * defensive because these strings come back from clients on messages that may
 * be months old and predate the current code.
 */
export interface ParsedCustomId {
  feature: string;
  action: string;
  arg: string;
}

export function buildCustomId(feature: string, action: string, arg: string | number): string {
  const id = `${feature}:${action}:${arg}`;
  if (id.length > 100) throw new Error(`custom_id exceeds Discord's 100-char limit: ${id}`);
  return id;
}

export function parseCustomId(customId: string): ParsedCustomId | null {
  const parts = customId.split(":");
  if (parts.length < 3) return null;
  const [feature, action, ...rest] = parts;
  if (!feature || !action) return null;
  return { feature, action, arg: rest.join(":") };
}
