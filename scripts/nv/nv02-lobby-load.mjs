// NV-02 (Lobby scan cardinality), staged smoke: populate the Lobby with N
// rooms via real signaling joins, then measure /api/discover latency before
// and after. This machine contributes one IP, so N rooms ≈ N ip-pairs —
// enough to observe scan-cost growth and give the owner real p50/p95 numbers
// to watch DO CPU against in the dashboard. The audit's full ~225k-pair
// linearity harness stays a scaled-up run of this same script (ROOMS env).
//
// Usage: ROOMS=300 node scripts/nv/nv02-lobby-load.mjs   (against staging)
import { join, quit, discover, percentile, runId, STAGING_BASE } from "./nv-common.mjs";

const ROOMS = Number(process.env.ROOMS ?? 300);
const CONC = Number(process.env.CONC ?? 8);
const PREFIX = "nvx02";
const tag = runId();

async function timedDiscover(samples = 10) {
  const times = [];
  for (let i = 0; i < samples; i++) {
    const t0 = performance.now();
    await discover(STAGING_BASE);
    times.push(performance.now() - t0);
  }
  return { p50: Math.round(percentile(times, 50)), p95: Math.round(percentile(times, 95)) };
}

console.log(`baseline discover latency (empty lobby):`, await timedDiscover());

console.log(`joining ${ROOMS} rooms (${PREFIX}-${tag}-*, ${CONC} at a time)...`);
const sockets = [];
let ok = 0;
const t0 = performance.now();
let next = 0;
async function worker() {
  while (next < ROOMS) {
    const i = next++;
    try {
      const s = await join(STAGING_BASE, {
        room: `${PREFIX}-${tag}-${i}`,
        peer: `nvpeer-${tag}-${i}`,
      });
      sockets.push(s);
      ok++;
    } catch (err) {
      if (process.env.NV_DEBUG) console.log(`  join ${i}: ${String(err.message).split("\n")[0]}`);
      // per-address / room caps or blips — keep draining the queue
    }
    if ((i + 1) % 20 === 0) console.log(`  queued ${i + 1}/${ROOMS}`);
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
console.log(`  ${ok}/${ROOMS} joined in ${Math.round(performance.now() - t0)}ms`);

// the lobby heartbeat rides the roster change; give the announce a beat
await new Promise((r) => setTimeout(r, 2000));

const listed = await discover(STAGING_BASE);
const ours = listed.filter((r) => r.roomId.startsWith(`${PREFIX}-${tag}-`));
const after = await timedDiscover();

console.log(`discover now lists ${ours.length} of our rooms (total visible: ${listed.length})`);
console.log(`discover latency with ${ok} rooms: p50=${after.p50}ms p95=${after.p95}ms`);

// close everything at once — graceful close of hundreds of sockets one by
// one would dominate the runtime
await Promise.all(sockets.map((s) => quit(s.ws)));

console.log(
  `\nRESULT nv-02 (staged smoke): ${ok} rooms/pairs populated; discover p50=${after.p50}ms p95=${after.p95}ms.` +
    ` Owner step: watch Lobby DO CPU per discover + announce queueing in the` +
    ` dashboard while this population (or a scaled ROOMS=5000 run from several` +
    ` IPs) is live. Countermeasure (aggregate caps) only if CPU/p99 breach budget.`,
);
process.exit(0);
