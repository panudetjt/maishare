// Debug: dump buttons/rows right after sending 3 heavy files.
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";
import { writeFileSync } from "node:fs";

const PORT = "4179";
const BASE = `http://localhost:${PORT}`;
const server = spawn("pnpm", ["exec", "vp", "preview", "--port", PORT, "--strictPort"], {
  stdio: "ignore",
  detached: true,
});
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  try {
    up = (await fetch(`${BASE}/healthz`)).ok;
  } catch {
    await new Promise((r) => setTimeout(r, 500));
  }
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

async function heavyPng(page, base) {
  const b64 = await page.evaluate((base) => {
    const w = 1600;
    const h = 1200;
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    const data = ctx.createImageData(w, h);
    const d = data.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = Math.max(0, Math.min(255, base[0] + (Math.random() - 0.5) * 170));
      d[i + 1] = Math.max(0, Math.min(255, base[1] + (Math.random() - 0.5) * 170));
      d[i + 2] = Math.max(0, Math.min(255, base[2] + (Math.random() - 0.5) * 170));
      d[i + 3] = 255;
    }
    ctx.putImageData(data, 0, 0);
    return c.toDataURL("image/png").split(",")[1];
  }, base);
  return Buffer.from(b64, "base64");
}

try {
  const prepCtx = await browser.newContext({ viewport: { width: 900, height: 700 } });
  const prep = await prepCtx.newPage();
  const paths = [];
  for (const [name, base] of [
    ["beach.png", [110, 100, 235]],
    ["pool.png", [30, 160, 230]],
    ["garden.png", [40, 200, 140]],
  ]) {
    const buf = await heavyPng(prep, base);
    const path = `/tmp/dbg-${name}`;
    writeFileSync(path, buf);
    paths.push(path);
  }
  await prepCtx.close();

  const mob = async () => {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    return ctx.newPage();
  };
  const alice = await mob();
  await alice.goto(BASE, { waitUntil: "domcontentloaded" });
  await alice.getByLabel("Your display name").fill("alice");
  await alice.getByRole("button", { name: /create a room/i }).click();
  await alice.waitForURL(/\/r\//);
  const invite = new URL(alice.url());
  invite.searchParams.set("name", "bob");
  const bob = await mob();
  await bob.goto(invite.href, { waitUntil: "domcontentloaded" });
  await bob.getByText("1 peer", { exact: true }).waitFor({ timeout: 20_000 });

  await alice.setInputFiles("input[type=file]", paths);
  await alice.getByLabel("Message").fill("dbg");
  await alice.keyboard.press("Enter");
  await alice.locator(".bubble-file.transfer-active").first().waitFor({ timeout: 10_000 });

  for (let i = 0; i < 12; i++) {
    const dump = await alice.evaluate(() => {
      const rows = [...document.querySelectorAll(".bubble-file")].map((el) => ({
        cls: el.className,
        text: (el.textContent || "").trim().slice(0, 50),
      }));
      const buttons = [...document.querySelectorAll(".bubble-file button, .bubble-file a")].map(
        (b) => b.getAttribute("aria-label") || b.textContent?.trim(),
      );
      return { rows, buttons };
    });
    console.log(`--- probe ${i} ---`);
    console.log(JSON.stringify(dump));
    try {
      await alice.getByRole("button", { name: "Cancel dbg-pool.png" }).click({ timeout: 500 });
      console.log(">>> CLICKED cancel dbg-pool");
    } catch (e) {
      console.log(`click probe ${i} failed: ${e.message.split("\n")[0]}`);
      await alice.waitForTimeout(400);
    }
  }
} finally {
  await browser.close();
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {}
}
