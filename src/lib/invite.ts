// Invite-link plumbing for the room key: the key rides the URL fragment
// (NV-03 — fragments never reach the server), so every builder/parser here
// keeps it out of the request line.

/** `/r/<roomId>#k=<key>` — the key rides the fragment, server-invisible */
export function roomInvitePath(roomId: string, key?: string): string {
  return `/r/${roomId}${key ? `#k=${encodeURIComponent(key)}` : ""}`;
}

/**
 * Read the room key out of a raw URL fragment (`location.hash` / `URL.hash`).
 * Tolerates the double-`#` corruption (`##k=…`) that older builds emitted from
 * the Recent rooms navigation, so links already saved or shared still resolve.
 */
export function keyFromHash(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const k = new URLSearchParams(raw.replace(/^#+/, "")).get("k");
  return k || undefined;
}
