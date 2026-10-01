import { spawn } from "node:child_process";
import { chromium } from "playwright-core";
const PORT = "4189";
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
    "--disable-gpu",
    "--disable-extensions",
    "--disable-background-networking",
    "--js-flags=--max-old-space-size=192",
    "--renderer-process-limit=1",
  ],
});
const results = [];
const ok = (name, cond, extra = "") => {
  results.push(cond);
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) process.exitCode = 1;
};
const ctx = await browser.newContext({ viewport: { width: 1000, height: 860 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message.slice(0, 120)));
await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 90000 });
await page.getByText("Start sharing").waitFor({ timeout: 90000 });
await page.getByLabel("Your display name").fill("solo");
await page.getByRole("button", { name: /create a room/i }).click();
await page.waitForURL(/\/r\//, { timeout: 15000 });
await page.locator(".conv-log").waitFor({ timeout: 15000 });
const fill = (v) =>
  page.locator("textarea").evaluate((ta, val) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(ta, val);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }, v);

// 1) code file with a very long single line
const longLine = 'export const VERY_LONG_LINE = "' + "x".repeat(2000) + '";\n';
await page.setInputFiles("input[type=file]", {
  name: "spill-helpers.ts",
  mimeType: "text/plain",
  buffer: Buffer.from(
    "import { pick } from './spill'\n\n" +
      longLine +
      "\nexport function pickIncomingSink(size: number) {\n  if (size <= 1) return 'ram'\n  return 'disk'\n}\n",
  ),
});
await page.locator(".attach-chip", { hasText: "spill-helpers.ts" }).waitFor({ timeout: 8000 });
await page.getByRole("button", { name: "Send", exact: true }).click();
await page.locator(".bubble-textfile .hljs-keyword").first().waitFor({ timeout: 30000 });
const m1 = await page.evaluate(() => {
  const doc = document.documentElement,
    log = document.querySelector(".conv-log");
  const tf = document.querySelector(".bubble-textfile");
  const part = tf.parentElement;
  const bubble = document.querySelector(".bubble");
  return {
    pageOverflow: doc.scrollWidth - doc.clientWidth,
    logOverflow: log.scrollWidth - log.clientWidth,
    partInFiles: !!part.closest(".bubble-files"),
    bounded: tf.getBoundingClientRect().width <= bubble.getBoundingClientRect().width + 1,
    bubbleFits:
      bubble.getBoundingClientRect().right <=
      document.querySelector(".conv-inner").getBoundingClientRect().right + 1,
  };
});
ok(
  "code file: inline preview, highlighted, bounded, no overflow",
  !m1.partInFiles && m1.bounded && m1.bubbleFits && m1.pageOverflow <= 1 && m1.logOverflow <= 1,
  JSON.stringify(m1),
);
await page
  .locator(".msg", { hasText: "spill-helpers.ts" })
  .screenshot({ path: "/tmp/shot-tf-code.png" });

// 2) markdown file with table + mermaid
await page.setInputFiles("input[type=file]", {
  name: "ship-plan.md",
  mimeType: "text/markdown",
  buffer: Buffer.from(
    "# Ship plan\n\nRoll out in **three stages**.\n\n| step | ok |\n|---|---|\n| build | yes |\n| ship | yes |\n\n```mermaid\ngraph TD\n  A[Build image] --> B{Tests pass?}\n  B -- yes --> C[Push registry]\n  B -- no --> D[Fix and retry]\n  C --> E[Restart pods]\n```\n",
  ),
});
await page.locator(".attach-chip", { hasText: "ship-plan.md" }).waitFor({ timeout: 8000 });
await page.getByRole("button", { name: "Send", exact: true }).click();
await page.locator(".bubble-textfile .bubble-markdown table").waitFor({ timeout: 40000 });
ok("markdown file: rich markdown preview (table)", true);
try {
  await page.locator(".bubble-textfile .md-mermaid-svg svg").waitFor({ timeout: 120000 });
  ok("markdown file: mermaid diagram rendered", true);
} catch {
  const dbg = await page.evaluate(() => {
    const tf = [...document.querySelectorAll(".bubble-textfile")].find((el) =>
      el.textContent.includes("Ship plan"),
    );
    return {
      markdown: !!tf?.querySelector(".bubble-markdown"),
      placeholder: tf?.querySelectorAll(".md-mermaid").length ?? -1,
      svg: tf?.querySelectorAll(".md-mermaid-svg").length ?? -1,
    };
  });
  ok("markdown file: mermaid diagram rendered", false, JSON.stringify(dbg));
}
await page.locator(".msg", { hasText: "ship-plan.md" }).screenshot({ path: "/tmp/shot-tf-md.png" });

// 3) fallbacks: png → thumb, zip → card, 2.4MB text → card
await page.setInputFiles("input[type=file]", {
  name: "dot.png",
  mimeType: "image/png",
  buffer: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGP4DwABAQEAsTj2FAAAAABJRU5ErkJggg==",
    "base64",
  ),
});
await page.locator(".attach-chip", { hasText: "dot.png" }).waitFor({ timeout: 8000 });
await page.getByRole("button", { name: "Send", exact: true }).click();
await page.locator(".thumb-cell img").waitFor({ timeout: 20000 });
await page.setInputFiles("input[type=file]", {
  name: "tiny.zip",
  mimeType: "application/zip",
  buffer: Buffer.from(
    "UEsDBBQAAAAAAAmwOl2GphA2BQAAAAUAAAAFAAAAYS50eHRoZWxsb1BLAQIUAxQAAAAAAAmwOl2GphA2BQAAAAUAAAAFAAAAAAAAAAAAAACAAQAAAABhLnR4dFBLBQYAAAAAAQABADMAAAAoAAAAAAA=",
    "base64",
  ),
});
await page.locator(".attach-chip", { hasText: "tiny.zip" }).waitFor({ timeout: 8000 });
await page.getByRole("button", { name: "Send", exact: true }).click();
await page.locator(".bubble-file", { hasText: "tiny.zip" }).waitFor({ timeout: 20000 });
await page.setInputFiles("input[type=file]", {
  name: "huge.log",
  mimeType: "text/plain",
  buffer: Buffer.from("log line for the oversize test\n".repeat(80000)),
});
await page.locator(".attach-chip", { hasText: "huge.log" }).waitFor({ timeout: 8000 });
await page.getByRole("button", { name: "Send", exact: true }).click();
await page.locator(".bubble-file", { hasText: "huge.log" }).waitFor({ timeout: 40000 });
await page.waitForTimeout(2500);
const m3 = await page.evaluate(() => ({
  textfiles: document.querySelectorAll(".bubble-textfile").length,
  zipCard: [...document.querySelectorAll(".bubble-file")].some((el) =>
    el.textContent.includes("tiny.zip"),
  ),
  hugeCard: [...document.querySelectorAll(".bubble-file")].some((el) =>
    el.textContent.includes("huge.log"),
  ),
  pngThumb: !!document.querySelector(".thumb-cell img"),
}));
ok(
  "fallbacks: png→thumb, zip→card, 2.4MB log→card, only 2 previews",
  m3.textfiles === 2 && m3.zipCard && m3.hugeCard && m3.pngThumb,
  JSON.stringify(m3),
);

// 4) view-source toggle on the code preview
const codeMsg = page.locator(".msg", { hasText: "spill-helpers.ts" });
await codeMsg.hover();
await codeMsg.getByRole("button", { name: "View source" }).click();
await codeMsg.locator(".bubble-textfile-body pre code").waitFor({ timeout: 8000 });
ok("view-source: preview flips to raw text", true);
await codeMsg.screenshot({ path: "/tmp/shot-tf-raw.png" });
await codeMsg.getByRole("button", { name: "Show rendered" }).click();
await codeMsg.locator(".bubble-textfile .hljs-keyword").first().waitFor({ timeout: 15000 });
ok("toggle back to rendered", true);

// full timeline screenshots (top and bottom)
await page.locator(".conv-log").evaluate((el) => {
  el.scrollTop = 0;
});
await page.waitForTimeout(400);
await page.screenshot({ path: "/tmp/shot-tf-all-top.png" });
await page.locator(".conv-log").evaluate((el) => {
  el.scrollTop = el.scrollHeight;
});
await page.waitForTimeout(400);
await page.screenshot({ path: "/tmp/shot-tf-all-bottom.png" });
console.log("done");
await browser.close();
process.exit(results.every(Boolean) ? 0 : 1);
