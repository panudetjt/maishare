// NV-03 (room key in request lines), local half: does the local workerd dev
// server's request log capture the invite key from the query string? The
// zone-level review (Workers observability sampling, Logpush, analytics,
// proxies) stays an owner step — this script produces the local evidence.
//
// Spawns `wrangler dev` with a temp config (assets directory pointing at the
// build output), navigates a room URL carrying a canary key, then greps the
// captured log for it.
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, existsSync } from "node:fs";

const PORT = "8799";
const BASE = `http://localhost:${PORT}`;
const CANARY = "nvcannotkeepthiskey42";
const ROOM = "nv03room";

const distConfig = JSON.parse(readFileSync("dist/maishare/wrangler.json", "utf8"));
// minimal standalone dev config: same worker, assets from the build output
const devConfig = {
  name: "maishare-nv03-dev",
  // paths resolve relative to the config file, which lives in dist/
  main: "../server/worker.ts",
  compatibility_date: distConfig.compatibility_date,
  assets: {
    not_found_handling: "single-page-application",
    binding: "ASSETS",
    run_worker_first: ["/", "/r/*", "/ws", "/healthz", "/api/*"],
    directory: "client",
  },
  durable_objects: { bindings: distConfig.durable_objects.bindings },
  migrations: distConfig.migrations,
};
writeFileSync("dist/nv03-wrangler.json", JSON.stringify(devConfig));
if (!existsSync("dist/client/index.html")) {
  console.error("run `vp build` first — dist/client missing");
  process.exit(1);
}

const child = spawn(
  "pnpm",
  ["exec", "wrangler", "dev", "-c", "dist/nv03-wrangler.json", "--port", PORT],
  {
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let logs = "";
child.stdout.on("data", (d) => (logs += d));
child.stderr.on("data", (d) => (logs += d));

const deadline = Date.now() + 30_000;
let up = false;
while (Date.now() < deadline && !up) {
  try {
    up = (await fetch(`${BASE}/healthz`)).ok;
  } catch {
    await new Promise((r) => setTimeout(r, 500));
  }
}
if (!up) {
  console.error("wrangler dev did not start\n" + logs.slice(-2000));
  child.kill("SIGTERM");
  process.exit(1);
}

// navigate + refresh like a real joiner would
for (let i = 0; i < 2; i++) {
  await fetch(`${BASE}/r/${ROOM}?k=${CANARY}`, { redirect: "manual" });
  await new Promise((r) => setTimeout(r, 300));
}
// let the log lines land
await new Promise((r) => setTimeout(r, 1500));
child.kill("SIGTERM");
await new Promise((r) => setTimeout(r, 500));

const captured = logs.includes(CANARY);
const anyRequest = logs.split("\n").filter((l) => l.includes("GET") || l.includes("/r/"));
const requestLine = anyRequest.find((l) => l.includes(CANARY));
console.log(
  anyRequest.length
    ? `sample log line: ${requestLine?.trim() ?? anyRequest[0].trim()}\n`
    : `raw log tail (${logs.length} chars): ${logs.slice(-400)}\n`,
);
console.log(
  `RESULT nv-03 (local half): ${anyRequest.length ? (captured ? "request logs DO capture" : "request logs do not capture") : "INCONCLUSIVE locally — no request lines in the log at all; inspect the tail above"} the query-string key.` +
    ` Next: owner reviews zone layers (Workers observability sampling, Logpush,` +
    ` analytics, fronting proxies, retention). Any layer capturing ?k= escalates` +
    ` to the fragment-key (#k=) design.`,
);
process.exit(captured ? 0 : 0); // both outcomes are evidence, not failures
