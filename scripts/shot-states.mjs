// Mobile screenshots: thumbnail rows with circular progress + all transfer states.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

const PORT = "4174";
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

// per-pixel tinted noise → incompressible multi-MB PNGs, so transfers last
// long enough to capture mid-flight states
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

const mob = async () => {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  return ctx.newPage();
};

try {
  const prepCtx = await browser.newContext({ viewport: { width: 900, height: 700 } });
  const prep = await prepCtx.newPage();
  const payloads = [
    ["beach.png", [110, 100, 235]],
    ["pool.png", [30, 160, 230]],
    ["garden.png", [40, 200, 140]],
    ["sunset.png", [235, 110, 180]],
    ["fireworks.png", [230, 230, 240]],
  ];
  mkdirSync("/tmp/stshots", { recursive: true });
  const paths = [];
  for (const [name, base] of payloads) {
    const buf = await heavyPng(prep, base);
    const path = `/tmp/stshots/${name}`;
    writeFileSync(path, buf);
    paths.push(path);
    console.log(`${name}: ${(buf.length / 1048576).toFixed(1)} MB`);
  }
  await prepCtx.close();

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

  // message 1: three heavy images — cancel one mid-transfer so a single
  // capture shows active rings, a cancelled badge, and queued waiting
  await alice.setInputFiles("input[type=file]", paths.slice(0, 3));
  await alice.locator(".attach-chip", { hasText: "garden.png" }).waitFor({ timeout: 5000 });
  await alice.getByLabel("Message").fill("รูปทริป 3 รูป — ลองกดที่รูปได้");
  await alice.keyboard.press("Enter");
  await alice.locator(".bubble-file.transfer-active").first().waitFor({ timeout: 10_000 });
  await alice.getByRole("button", { name: "Cancel pool.png" }).click();
  await alice.screenshot({ path: "/tmp/st-1-active.png" });

  // settled state: done badges + the cancelled row
  await alice.locator(".bubble-file.transfer-done", { hasText: "garden.png" }).waitFor({
    timeout: 60_000,
  });
  await alice.locator(".thumb-badge.badge-cancelled").waitFor({ timeout: 10_000 });
  await alice.screenshot({ path: "/tmp/st-2-done-cancelled.png" });

  // receiver: same rows with Save affordances + gallery still works
  await bob.locator(".bubble-file.transfer-done", { hasText: "beach.png" }).waitFor({
    timeout: 60_000,
  });
  await bob.screenshot({ path: "/tmp/st-3-received.png" });
  await bob.locator(".bubble-img").first().tap();
  // cancelled pool.png never finished, so bob's gallery is beach + garden
  await bob.getByText("1 / 2").waitFor({ timeout: 10_000 });
  await bob.waitForTimeout(600);
  await bob.screenshot({ path: "/tmp/st-4-gallery.png" });
  await bob.keyboard.press("Escape");

  // error: drop the peer mid-transfer of a new image
  await alice.setInputFiles("input[type=file]", paths[3]);
  await alice.getByRole("button", { name: "Send", exact: true }).click();
  await alice.locator(".bubble-file.transfer-active", { hasText: "sunset.png" }).waitFor({
    timeout: 10_000,
  });
  await bob.context().close();
  await alice.locator(".bubble-file.transfer-error", { hasText: "sunset.png" }).waitFor({
    timeout: 15_000,
  });

  // queued: with no peer connected, a new attachment waits
  await alice.setInputFiles("input[type=file]", paths[4]);
  await alice.getByRole("button", { name: "Send", exact: true }).click();
  await alice.locator(".bubble-file.transfer-queued", { hasText: "fireworks.png" }).waitFor({
    timeout: 10_000,
  });
  await alice.screenshot({ path: "/tmp/st-5-error-queued.png" });

  console.log("all-state screenshots written");
} finally {
  await browser.close();
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {}
}
