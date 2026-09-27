// Deploys the REAL worker ("maishare") from the built output — the production
// companion of deploy-staging.mjs. Run after `vp build`.
//
// Why this exists: plain `wrangler deploy` reads the root wrangler.jsonc,
// whose main is the TS source and whose assets block carries no directory —
// the deployable unit is the plugin-generated dist/maishare/wrangler.json
// (bundled worker + assets directory + DO migrations).
//
// Set PUBLIC_ORIGIN at build time (`PUBLIC_ORIGIN=https://maishare.panudet.dev
// vp build`) so the social-preview URLs bake to the production domain.
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const PROD_PATTERN = "maishare.panudet.dev";
const cfg = JSON.parse(readFileSync("dist/maishare/wrangler.json", "utf8"));
// belt-and-braces: the plugin has dropped fields from the generated config
// before (rate limits) — make sure the custom domain survives to the deploy
if (!JSON.stringify(cfg.routes ?? []).includes(PROD_PATTERN)) {
  cfg.routes = [{ pattern: PROD_PATTERN, custom_domain: true }];
}
// name stays "maishare"; workers.dev visibility and any existing routes or
// custom domains are inherited untouched on redeploy
// belt-and-braces: guarantee the rate-limiter bindings reach production even
// if the plugin drops them from the generated config
if (!JSON.stringify(cfg).includes("RATE_LIMITER_WS")) {
  cfg.unsafe = {
    ...cfg.unsafe,
    bindings: [
      ...(cfg.unsafe?.bindings ?? []),
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
writeFileSync("dist/maishare/wrangler.production.json", JSON.stringify(cfg));

const res = spawnSync(
  "pnpm",
  ["exec", "wrangler", "deploy", "-c", "dist/maishare/wrangler.production.json"],
  { stdio: "inherit" },
);
console.log(
  res.status === 0
    ? '\nproduction "maishare" deployed with the security-remediation build.'
    : `\nproduction deploy exited with ${res.status} — nothing else was touched.`,
);
process.exit(res.status ?? 1);
