// NV-04 (Room DO persistence): flood staging with bare upgrade-only joins,
// then verify what survives. Each join creates a DO instance and writes
// storage (roomId + ownership token). After the socket closes and the token
// grace period passes, the token row is wiped by the alarm but the room's
// DO instance / roomId row persists — the audit's finding. This script
// creates the rows at scale, waits out the grace period, proves a fresh claim
// works after cleanup, and hands the owner the dashboard checklist (object
// count + storage bytes are only visible platform-side).
//
// Usage: ROOMS=200 node scripts/nv/nv04-do-rows.mjs   (against staging)
import { join, quit, runId, STAGING_BASE } from "./nv-common.mjs";

const ROOMS = Number(process.env.ROOMS ?? 200);
const PREFIX = "nvx04";
const tag = runId();

console.log(`flooding ${ROOMS} rooms (${PREFIX}-${tag}-*) with single-join sockets...`);
const t0 = performance.now();
let ok = 0;
for (let i = 0; i < ROOMS; i++) {
  try {
    const s = await join(STAGING_BASE, {
      room: `${PREFIX}-${tag}-${i}`,
      peer: `nvpeer-${tag}-${i}`,
    });
    // bare upgrade-and-drop, like the audit's flood — no graceful-close wait,
    // the server cleans the socket up either way
    try {
      s.ws.close();
    } catch {}
    ok++;
  } catch (err) {
    console.log(`  join ${i} failed: ${String(err.message).split("\n")[0]}`);
    break;
  }
  if ((i + 1) % 50 === 0) console.log(`  ${i + 1}/${ROOMS}`);
}
console.log(`  ${ok}/${ROOMS} joins in ${Math.round(performance.now() - t0)}ms`);

console.log("waiting 75s for the token-cleanup alarm to fire...");
await new Promise((r) => setTimeout(r, 75_000));

// after the grace sweep a fresh claim must work (token wiped)
const reclaim = await join(STAGING_BASE, { room: `${PREFIX}-${tag}-0`, peer: `nvbrandnew-${tag}` });
console.log("fresh claim on a flooded room after grace: OK (token was wiped, new one minted)");
await quit(reclaim.ws);

console.log(
  `\nRESULT nv-04 (staged flood): ${ok} DO instances created and sockets dropped;` +
    ` post-grace reclaim works. Owner step (dashboard): open Workers & Pages ->` +
    ` maishare-nv-staging -> Durable Objects / storage metrics and record the` +
    ` object count + storage bytes these ${ok} rooms left (they persist by design).` +
    ` Then decide: per-address creation cap vs TTL cleanup alarm -> follow-up ticket.`,
);
process.exit(0);
