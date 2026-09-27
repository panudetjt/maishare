// Deletes the NV staging worker — the "graceful" cleanup before real launch.
// wrangler delete removes the worker AND its Durable Objects + storage, so
// every row the NV-02/04/05 floods created is gone. Production ("maishare")
// is a different worker and is untouched.
import { spawnSync } from "node:child_process";

const STAGING_NAME = "maishare-nv-staging";

const res = spawnSync("pnpm", ["exec", "wrangler", "delete", "--name", STAGING_NAME, "--force"], {
  stdio: "inherit",
});
console.log(
  res.status === 0
    ? `\nstaging "${STAGING_NAME}" deleted — all test rooms, Lobby entries and DO` +
        ` storage rows went with it. Nothing from the NV runs survives.`
    : `\ncleanup exited with ${res.status} — check \`wrangler whoami\` / the name.`,
);
process.exit(res.status ?? 1);
