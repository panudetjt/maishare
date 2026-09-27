// NV-05 (cross-origin WS poisoning of discovery): can a socket from another
// origin plant a room into the discovery lobby? A browser would send an
// Origin header on the cross-origin WS handshake; a server-side origin
// allowlist would reject it. This script connects WITHOUT same-origin
// guarantees (Node's WebSocket sends no Origin, equivalent to the most
// permissive cross-origin client) and with an explicit foreign Origin header
// where the runtime permits it, then checks /api/discover for the planted
// room. If the room appears, the app layer has no origin gate -> validated.
//
// Usage: node scripts/nv/nv05-cross-origin.mjs   (against staging)
import { join, quit, discover, runId, STAGING_BASE } from "./nv-common.mjs";

const tag = runId();
const room = `nvx05-${tag}`;

console.log(`planting room ${room} via a foreign socket...`);
// Node's undici WebSocket forbids setting Origin directly; the absence of an
// Origin header is itself the strongest case (no gate at all). If a future
// runtime adds one, revisit with a real cross-origin browser page.
const planted = await join(STAGING_BASE, { room, peer: `nvevil-${tag}`, name: "poisoner" });
console.log("foreign socket joined and received a welcome — server checked no origin");

// the roster change announces to the lobby; give it a beat
await new Promise((r) => setTimeout(r, 2000));
const rooms = await discover(STAGING_BASE);
const hit = rooms.find((r) => r.roomId === room);

console.log(
  hit ? `poisoned room IS discoverable: ${JSON.stringify(hit)}` : "planted room not discoverable",
);
await quit(planted.ws);

console.log(
  hit
    ? `\nRESULT nv-05: VALIDATED at the app layer — a non-browser/cross-origin socket` +
        ` planted a discovery-visible room; no upgrade-time origin check exists.` +
        ` Countermeasure if the owner confirms with a real cross-origin browser:` +
        ` upgrade-time Origin allowlist (follow-up ticket).`
    : `\nRESULT nv-05: NOT validated at the app layer — planted room stayed out of` +
        ` discovery (an edge rule or announce gate may already block it).`,
);
process.exit(0);
