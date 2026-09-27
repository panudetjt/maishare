// Deploys the isolated NV staging worker: same build output as production,
// different worker name -> its own Durable Object namespace and storage, so
// every test row this creates dies with `node scripts/nv/cleanup-staging.mjs`
// (wrangler delete removes the worker together with its DOs and storage).
// Production ("maishare") is never touched.
//
// Run after `vp build` (reads dist/maishare/wrangler.json).
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const STAGING_NAME = "maishare-nv-staging";

const base = JSON.parse(readFileSync("dist/maishare/wrangler.json", "utf8"));
base.name = STAGING_NAME;
base.workers_dev = true; // serve on <name>.<account>.workers.dev
// observability stays OFF (owner decision 2026-09-27): invocation logs capture
// full query strings, and before ticket 14 those carried the room key
// belt-and-braces: guarantee the rate-limiter bindings reach staging even if
// the plugin drops them from the generated config (checked 2026-09-27: it did)
if (!JSON.stringify(base).includes("RATE_LIMITER_WS")) {
  base.unsafe = {
    ...base.unsafe,
    bindings: [
      ...(base.unsafe?.bindings ?? []),
      {
        name: "RATE_LIMITER_WS",
        type: "ratelimit",
        namespace_id: "1001",
        simple: { limit: 30, period: 60 },
      },
      {
        name: "RATE_LIMITER_DISCOVER",
        type: "ratelimit",
        namespace_id: "1002",
        simple: { limit: 30, period: 60 },
      },
    ],
  };
}
// keep every other field (main, assets, DOs, migrations) identical
writeFileSync("dist/maishare/wrangler.staging.json", JSON.stringify(base));

const res = spawnSync(
  "pnpm",
  ["exec", "wrangler", "deploy", "-c", "dist/maishare/wrangler.staging.json"],
  { stdio: "inherit" },
);
if (res.status !== 0) {
  console.error("\nstaging deploy FAILED — production was not touched");
  process.exit(res.status ?? 1);
}
console.log(
  `\nstaging deployed as "${STAGING_NAME}". Run the NV scripts against it:` +
    `\n  node scripts/nv/nv02-lobby-load.mjs` +
    `\n  node scripts/nv/nv04-do-rows.mjs` +
    `\n  node scripts/nv/nv05-cross-origin.mjs` +
    `\n(they default NV_BASE_URL to https://${STAGING_NAME}.<your-subdomain>.workers.dev —` +
    ` copy the URL printed above into NV_BASE_URL if it differs)` +
    `\nWhen done testing: node scripts/nv/cleanup-staging.mjs`,
);
