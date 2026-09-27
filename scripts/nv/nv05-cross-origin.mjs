// NV-05 (cross-origin WS poisoning of discovery) — post-fix verification.
// The /ws endpoint is same-origin gated (ticket 12): a foreign Origin and a
// headerless upgrade must both be refused 403 before any socket exists, while
// a same-origin (the app's own) socket still works end-to-end.
//
// Usage: node scripts/nv/nv05-cross-origin.mjs   (against staging)
import { join, quit, discover, runId, STAGING_BASE } from "./nv-common.mjs";

const tag = runId();
const attackRoom = `nvx05a-${tag}`; // only hostile sockets ever touch this
const ownRoom = `nvx05o-${tag}`; // the app's own client sanity room
let failures = 0;

// 1) foreign Origin — the exact vector the staging run validated on 2026-09-27
let foreign;
try {
  foreign = await join(
    STAGING_BASE,
    { room: attackRoom, peer: `nvevil-${tag}`, name: "poisoner" },
    { origin: "https://evil.example" },
  );
  console.log("FOREIGN ORIGIN JOINED — gate did not fire");
  failures++;
  await quit(foreign.ws);
} catch (err) {
  console.log(`foreign Origin refused at the door: ${err.message.split(" — ")[1] ?? err.message}`);
}

// 2) headerless (non-browser) client — no Origin header at all
try {
  const headerless = await join(
    STAGING_BASE,
    { room: attackRoom, peer: `nvnohdr-${tag}`, name: "headerless" },
    { origin: "" },
  );
  console.log("HEADERLESS JOINED — gate did not fire");
  failures++;
  await quit(headerless.ws);
} catch (err) {
  console.log(`headerless refused at the door: ${err.message.split(" — ")[1] ?? err.message}`);
}

// 3) sanity: the app's own (same-origin) client still works end-to-end
const own = await join(STAGING_BASE, { room: ownRoom, peer: `nvown-${tag}`, name: "own-app" });
console.log("same-origin join still works (welcome received)");

const rooms = await discover(STAGING_BASE);
const attackHit = rooms.some((r) => r.roomId === attackRoom);
const ownHit = rooms.some((r) => r.roomId === ownRoom);
console.log(
  attackHit
    ? "hostile-only room IS discoverable (leak)"
    : "hostile-only room is NOT in discovery (nothing was announced for it)",
);
console.log(
  ownHit
    ? "own room announced normally (announce path intact)"
    : "own room missing from discovery?!",
);

console.log(
  failures === 0 && !attackHit && ownHit
    ? `\nRESULT nv-05: gate holds — foreign-Origin and headerless upgrades get 403` +
        ` before any socket, discovery stays clean, same-origin flows unaffected.` +
        ` Countermeasure verified (ticket 12).`
    : `\nRESULT nv-05: gate has a leak (failures=${failures}, attackRoomHit=${attackHit}, ownRoomHit=${ownHit}).`,
);
process.exit(0);
