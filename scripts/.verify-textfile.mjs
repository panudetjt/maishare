import { spawn } from "node:child_process";
import { chromium } from "playwright-core";
const PORT = "4187";
const BASE = `http://localhost:${PORT}`;
let server = spawn("pnpm", ["exec", "vp", "preview", "--port", PORT, "--strictPort"], {
  stdio: "ignore",
  detached: true,
});
let up = false;
for (let i = 0; i < 120 && !up; i++) {
  try {
    up = (await fetch(`${BASE}/healthz`)).ok;
  } catch {
    await new Promise((r) => setTimeout(r, 500));
  }
}
if (!up) {
  console.error("preview did not start");
  process.exit(1);
}
const browser = await chromium.launch({
  headless: true,
  executablePath: "/usr/bin/google-chrome",
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-features=WebRtcHideLocalIpsWithMdns",
  ],
});
const results = [];
const ok = (name, cond, extra = "") => {
  results.push(cond);
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) process.exitCode = 1;
};
async function newPeer() {
  const ctx = await browser.newContext({
    viewport: { width: 1100, height: 900 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("[pageerror]", e.message.slice(0, 120)));
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  return page;
}
let n1, n2;
for (let attempt = 1; attempt <= 3; attempt++) {
  try {
    n1 = await newPeer();
    await n1.getByRole("button", { name: /start nearby share/i }).click();
    await n1.getByRole("button", { name: /send to a nearby device/i }).click();
    await n1.locator(".nearby-code").waitFor({ timeout: 15000 });
    const offer = (await n1.locator(".nearby-code").innerText()).trim();
    n2 = await newPeer();
    await n2.getByRole("button", { name: /start nearby share/i }).click();
    await n2.getByRole("button", { name: /scan a share code/i }).click();
    await n2.getByLabel("Paste a share code").fill(offer);
    await n2.getByRole("button", { name: /use code/i }).click();
    await n2.locator(".nearby-code").waitFor({ timeout: 15000 });
    const answer = (await n2.locator(".nearby-code").innerText()).trim();
    await n1.getByLabel("Paste a share code").fill(answer);
    await n1.getByRole("button", { name: /use code/i }).click();
    await n1.getByText(/connected to/i).waitFor({ timeout: 20000 });
    await n2.getByText(/connected to/i).waitFor({ timeout: 20000 });
    break;
  } catch {
    console.log(`handshake attempt ${attempt} failed, retrying...`);
    if (attempt === 3) {
      console.error("handshake failed 3x");
      process.exit(1);
    }
    await n1?.context()?.close();
    await n2?.context()?.close();
    n1 = n2 = undefined;
  }
}
console.log("connected");

// 1) code file with a long single line
const longLine = 'export const VERY_LONG_LINE = "' + "x".repeat(2000) + '";\n';
const codeBuf = Buffer.from(
  "import { pick } from './spill'\n\n" +
    longLine +
    "\nexport function pickIncomingSink(size: number) {\n  if (size <= 1) return 'ram'\n  return 'disk'\n}\n",
);
await n1.setInputFiles("input[type=file]", {
  name: "spill-helpers.ts",
  mimeType: "text/plain",
  buffer: codeBuf,
});
await n1.locator(".attach-chip", { hasText: "spill-helpers.ts" }).waitFor({ timeout: 5000 });
await n1.getByRole("button", { name: "Send", exact: true }).click();
await n1.locator(".bubble-textfile").waitFor({ timeout: 20000 });
await n1.locator(".bubble-textfile .hljs-keyword").first().waitFor({ timeout: 15000 });
ok("sender: code file renders as highlighted preview", true);
await n2.locator(".bubble-textfile").waitFor({ timeout: 30000 });
const rM = await n2.evaluate(() => {
  const part = document.querySelector(".bubble-textfile").parentElement;
  const save = document.querySelector(".bubble-textfile-actions a");
  const copy = document.querySelector(".bubble-textfile-actions button");
  const code = document.querySelector(".bubble-textfile .bubble-code-body");
  return {
    inFilesStrip: !!part.closest(".bubble-files"),
    hasSave: !!save,
    hasCopy: !!copy,
    codeScrolls: code.scrollWidth > code.clientWidth,
    pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
});
ok(
  "receiver: preview with save+copy, outside strip, no overflow, code scrolls",
  !rM.inFilesStrip && rM.hasSave && rM.hasCopy && rM.pageOverflow <= 1 && rM.codeScrolls,
  JSON.stringify(rM),
);
const [dl] = await Promise.all([
  n2.waitForEvent("download", { timeout: 10000 }),
  n2.locator(".bubble-textfile-actions a").click(),
]);
const dlPath = `/tmp/${dl.suggestedFilename()}`;
await dl.saveAs(dlPath);
const { readFile } = await import("node:fs/promises");
ok(
  "receiver: saved file matches byte-for-byte",
  (await readFile(dlPath, "utf8")) === codeBuf.toString("utf8"),
);
await n2
  .locator(".msg", { hasText: "spill-helpers.ts" })
  .screenshot({ path: "/tmp/shot-tf-code.png" });

// 2) markdown file with mermaid
const mdBuf = Buffer.from(
  "# Ship plan\n\n| step | ok |\n|---|---|\n| 1 | yes |\n\n```mermaid\ngraph TD\n  A[Build] --> B[Ship]\n```\n",
);
await n1.setInputFiles("input[type=file]", {
  name: "ship-plan.md",
  mimeType: "text/markdown",
  buffer: mdBuf,
});
await n1.locator(".attach-chip", { hasText: "ship-plan.md" }).waitFor({ timeout: 5000 });
await n1.getByRole("button", { name: "Send", exact: true }).click();
await n2.locator(".bubble-textfile .bubble-markdown table").waitFor({ timeout: 40000 });
ok("markdown file: rich markdown preview on receiver", true);
try {
  await n2.locator(".bubble-textfile .md-mermaid-svg svg").waitFor({ timeout: 90000 });
  ok("markdown file: mermaid diagram rendered", true);
} catch {
  const dbg = await n2.evaluate(() => {
    const tf = document.querySelector(".bubble-textfile");
    return {
      hasMarkdown: !!tf?.querySelector(".bubble-markdown"),
      placeholder: tf?.querySelectorAll(".md-mermaid").length ?? -1,
      svg: tf?.querySelectorAll(".md-mermaid-svg").length ?? -1,
      text: tf?.textContent?.slice(0, 120),
    };
  });
  ok("markdown file: mermaid diagram rendered", false, JSON.stringify(dbg));
}
await n2.locator(".msg", { hasText: "ship-plan.md" }).screenshot({ path: "/tmp/shot-tf-md.png" });

// 3) binary: png → image thumb; zip → plain file card (no preview)
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGP4DwABAQEAsTj2FAAAAABJRU5ErkJggg==",
  "base64",
);
await n1.setInputFiles("input[type=file]", { name: "dot.png", mimeType: "image/png", buffer: png });
await n1.locator(".attach-chip", { hasText: "dot.png" }).waitFor({ timeout: 5000 });
await n1.getByRole("button", { name: "Send", exact: true }).click();
await n2.locator(".thumb-cell img").waitFor({ timeout: 30000 });
const zip = Buffer.from(
  "UEsDBBQAAAAAAAmwOl2GphA2BQAAAAUAAAAFAAAAYS50eHRoZWxsb1BLAQIUAxQAAAAAAAmwOl2GphA2BQAAAAUAAAAFAAAAAAAAAAAAAACAAQAAAABhLnR4dFBLBQYAAAAAAQABADMAAAAoAAAAAAA=",
  "base64",
);
await n1.setInputFiles("input[type=file]", {
  name: "tiny.zip",
  mimeType: "application/zip",
  buffer: zip,
});
await n1.locator(".attach-chip", { hasText: "tiny.zip" }).waitFor({ timeout: 5000 });
await n1.getByRole("button", { name: "Send", exact: true }).click();
await n2.locator(".bubble-file", { hasText: "tiny.zip" }).waitFor({ timeout: 30000 });
await n2.waitForTimeout(2500);
const bin = await n2.evaluate(() => ({
  textfiles: document.querySelectorAll(".bubble-textfile").length,
  zipCard: [...document.querySelectorAll(".bubble-file")].some((el) =>
    el.textContent.includes("tiny.zip"),
  ),
  pngThumb: !!document.querySelector(".thumb-cell img"),
}));
ok(
  "binary: png → image thumb, zip → file card, neither gets a preview",
  bin.textfiles === 2 && bin.zipCard && bin.pngThumb,
  JSON.stringify(bin),
);

// 4) oversized text (2.4 MB) stays a card
const bigBuf = Buffer.from("line of text for the oversize test\n".repeat(70000));
await n1.setInputFiles("input[type=file]", {
  name: "huge.log",
  mimeType: "text/plain",
  buffer: bigBuf,
});
await n1.locator(".attach-chip", { hasText: "huge.log" }).waitFor({ timeout: 5000 });
await n1.getByRole("button", { name: "Send", exact: true }).click();
await n2.locator(".bubble-file", { hasText: "huge.log" }).waitFor({ timeout: 40000 });
await n2.waitForTimeout(3000);
const big = await n2.evaluate(() => ({
  textfiles: document.querySelectorAll(".bubble-textfile").length,
  card: [...document.querySelectorAll(".bubble-file")].some((el) =>
    el.textContent.includes("huge.log"),
  ),
}));
ok(
  "2.4 MB text file: stays a file card (over inline budget)",
  big.textfiles === 2 && big.card,
  JSON.stringify(big),
);

// 5) view-source toggle on the code-file preview
const codeMsg = n2.locator(".msg", { hasText: "spill-helpers.ts" });
await codeMsg.hover();
await codeMsg.getByRole("button", { name: "View source" }).click();
await codeMsg.locator(".bubble-code-body").waitFor({ timeout: 5000 });
const rawOk = await codeMsg.evaluate((el) => {
  const body = el.querySelector(".bubble-textfile-body");
  return body?.querySelector("pre code")?.textContent?.includes("export const VERY_LONG_LINE");
});
ok("view-source: file preview shows raw text", rawOk === true);
await codeMsg.screenshot({ path: "/tmp/shot-tf-raw.png" });
await codeMsg.getByRole("button", { name: "Show rendered" }).click();
await codeMsg.locator(".bubble-textfile .bubble-code-body").waitFor({ timeout: 5000 });
ok("toggle back to rendered preview", true);

// full conversation screenshot on the receiver
await n2.locator(".conv-log").evaluate((el) => {
  el.scrollTop = 0;
});
await n2.waitForTimeout(400);
await n2.screenshot({ path: "/tmp/shot-tf-all.png" });
await n2.locator(".conv-log").evaluate((el) => {
  el.scrollTop = el.scrollHeight;
});
await n2.waitForTimeout(400);
await n2.screenshot({ path: "/tmp/shot-tf-all-bottom.png" });
await browser.close();
process.exit(results.every(Boolean) ? 0 : 1);
