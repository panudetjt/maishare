// End-to-end smoke test: headless Chrome contexts act as peers on one network.
// Verifies signaling, LAN room discovery, P2P data channel, chat, clipboard
// and file transfer. Spawns `vite preview` itself (workerd runs
// server/worker.ts), so a fresh `vp build` must exist — or set BASE_URL to
// point at a running instance:
//
//   vp build && npm run test:e2e
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";

const PORT = process.env.E2E_PORT || "4173";
const BASE = process.env.BASE_URL || `http://localhost:${PORT}`;
const HEADLESS = process.env.HEADED !== "1";
const results = [];
const screenshots = [];

function ok(name, cond, extra = "") {
  results.push({ name, pass: !!cond, extra });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) process.exitCode = 1;
}

let server;
if (!process.env.BASE_URL) {
  server = spawn("pnpm", ["exec", "vp", "preview", "--port", PORT, "--strictPort"], {
    stdio: "ignore",
    detached: true,
  });
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
    console.error("preview server did not start — run `vp build` first?");
    process.exit(1);
  }
  console.log(`preview server up on ${BASE}`);
}

async function newPeer(browser) {
  const ctx = await browser.newContext({
    permissions: ["clipboard-read", "clipboard-write"],
    viewport: { width: 1280, height: 900 },
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`  [pageerror] ${e.message}`));
  return { ctx, page };
}

const browser = await chromium.launch({
  headless: HEADLESS,
  executablePath: "/usr/bin/google-chrome",
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-features=WebRtcHideLocalIpsWithMdns",
  ],
});

try {
  // ---- home ----
  const alice = await newPeer(browser);
  await alice.page.goto(BASE, { waitUntil: "domcontentloaded" });
  await alice.page.getByText("Start sharing").waitFor({ timeout: 10_000 });
  ok("home renders", true);

  // ---- create a room ----
  await alice.page.getByLabel("Your display name").fill("alice");
  await alice.page.getByRole("button", { name: /create a room/i }).click();
  await alice.page.waitForURL(/\/r\//, { timeout: 10_000 });
  const invite = alice.page.url();
  const roomId = new URL(invite).pathname.split("/").pop();
  ok("room created with key", /\?k=/.test(invite), roomId);

  // room code is reflected in the header
  await alice.page.getByText(roomId).first().waitFor({ timeout: 5000 });

  // ---- lan discovery: a third peer on the home page sees the room ----
  const carol = await newPeer(browser);
  await carol.page.goto(BASE, { waitUntil: "domcontentloaded" });
  const card = carol.page.locator(".lan-room", { hasText: roomId });
  await card.waitFor({ timeout: 15_000 });
  ok("room discovered on the home page", (await card.count()) === 1, roomId);
  await carol.page
    .locator(".lan-room", { hasText: "alice" })
    .first()
    .waitFor({ timeout: 15_000 })
    .then(
      () => ok("discovery shows the host name", true),
      () => ok("discovery shows the host name", false),
    );
  await carol.ctx.close();

  // ---- nearby direct mode: paste-code path (offline flow, no signaling) ----
  // Headless has no camera, so this drives the manual-paste fallback, which is
  // the exact same handshake the QR scan feeds. The flow lives in a home-page
  // card that expands in place.
  const n1 = await newPeer(browser);
  await n1.page.goto(BASE, { waitUntil: "domcontentloaded" });
  await n1.page.getByRole("button", { name: /start nearby share/i }).click();
  await n1.page.getByRole("button", { name: /send to a nearby device/i }).click();
  await n1.page.locator(".nearby-code").waitFor({ timeout: 15_000 });
  const offerCode = (await n1.page.locator(".nearby-code").innerText()).trim();

  const n2 = await newPeer(browser);
  await n2.page.goto(BASE, { waitUntil: "domcontentloaded" });
  await n2.page.getByRole("button", { name: /start nearby share/i }).click();
  await n2.page.getByRole("button", { name: /scan a share code/i }).click();
  await n2.page.getByLabel("Paste a share code").fill(offerCode);
  await n2.page.getByRole("button", { name: /use code/i }).click();
  await n2.page.locator(".nearby-code").waitFor({ timeout: 15_000 });
  const answerCode = (await n2.page.locator(".nearby-code").innerText()).trim();
  ok("nearby offer/answer codes exchanged", answerCode.startsWith("ms1"), offerCode.length);

  await n1.page.getByLabel("Paste a share code").fill(answerCode);
  await n1.page.getByRole("button", { name: /use code/i }).click();
  await n1.page.getByText(/connected to/i).waitFor({ timeout: 20_000 });
  await n2.page.getByText(/connected to/i).waitFor({ timeout: 20_000 });
  ok("nearby devices connected directly", true);

  const nearbyPayload = `maishare nearby payload ${Date.now()}\n`.repeat(1000); // ~27 KB
  await n1.page.setInputFiles("input[type=file]", {
    name: "nearby-payload.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(nearbyPayload),
  });
  await n2.page.locator(".nb-transfer.nb-done").waitFor({ timeout: 30_000 });
  ok("nearby file received", true);
  const [nbDownload] = await Promise.all([
    n2.page.waitForEvent("download", { timeout: 10_000 }),
    n2.page.getByRole("link", { name: /save nearby-payload/i }).click(),
  ]);
  const nbPath = `/tmp/maishare-nb-${nbDownload.suggestedFilename()}`;
  await nbDownload.saveAs(nbPath);
  const { readFile: nbReadFile } = await import("node:fs/promises");
  const nbContent = await nbReadFile(nbPath, "utf8");
  ok("nearby file matches byte-for-byte", nbContent === nearbyPayload, `${nbContent.length} bytes`);

  await n1.ctx.close();
  await n2.ctx.close();

  // ---- peer B joins via the invite link (name travels in the URL) ----
  const bob = await newPeer(browser);
  const bobUrl = new URL(invite);
  bobUrl.searchParams.set("name", "bob");
  await bob.page.goto(bobUrl.href, { waitUntil: "domcontentloaded" });

  // mesh: each side should list the other once the data channel opens
  await bob.page.getByText("alice", { exact: true }).waitFor({ timeout: 15_000 });
  await alice.page.locator(".peer-list li.peer").nth(1).waitFor({ timeout: 15_000 });
  ok("peers see each other", true);

  // ---- chat ----
  await alice.page.getByLabel("Message").fill("hello from alice");
  await alice.page.getByRole("button", { name: "Send" }).click();
  await bob.page.getByText("hello from alice").waitFor({ timeout: 10_000 });
  ok("chat arrives p2p", true);
  await bob.page.getByLabel("Message").fill("hi alice, bob here");
  await bob.page.getByRole("button", { name: "Send" }).click();
  await alice.page.getByText("hi alice, bob here").waitFor({ timeout: 10_000 });
  ok("chat is bidirectional", true);
  screenshots.push(await alice.page.screenshot({ path: "/tmp/maishare-chat.png" }));

  // ---- clipboard: send A's clipboard text to B ----
  await alice.page.evaluate(() => navigator.clipboard.writeText("secret-launch-code-42"));
  await alice.page.getByRole("link", { name: "Clipboard" }).click();
  await alice.page.getByRole("button", { name: /send my clipboard/i }).click();
  await alice.page.getByText("secret-launch-code-42").waitFor({ timeout: 10_000 });
  ok("clipboard text sent from alice", true);
  await bob.page.getByRole("link", { name: "Clipboard" }).click();
  await bob.page.getByText("secret-launch-code-42").waitFor({ timeout: 10_000 });
  ok("clipboard text received by bob", true);

  // bob copies it back into his own clipboard
  await bob.page.getByRole("button", { name: "Copy" }).click();
  await bob.page
    .getByText("Copied to your clipboard")
    .or(bob.page.getByText("Copied from"))
    .waitFor({ timeout: 5000 });
  const bobClip = await bob.page.evaluate(() => navigator.clipboard.readText());
  ok("copy-back works", bobClip === "secret-launch-code-42", bobClip);
  screenshots.push(await bob.page.screenshot({ path: "/tmp/maishare-clipboard.png" }));

  // ---- file transfer A -> B ----
  await alice.page.getByRole("link", { name: "Files" }).click();
  const payload = `maishare e2e payload ${Date.now()}\n`.repeat(2000); // ~52 KB
  await alice.page.setInputFiles("input[type=file]", {
    name: "e2e-payload.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(payload),
  });
  await alice.page.getByText("e2e-payload.txt").first().waitFor({ timeout: 10_000 });
  await alice.page.locator(".transfer-done").first().waitFor({ timeout: 30_000 });
  ok("file sent by alice", true);

  await bob.page.getByRole("link", { name: "Files" }).click();
  await bob.page.getByText("e2e-payload.txt").first().waitFor({ timeout: 10_000 });
  await bob.page.locator(".transfer-done").first().waitFor({ timeout: 30_000 });
  ok("file received by bob", true);

  // download and verify content integrity
  const [download] = await Promise.all([
    bob.page.waitForEvent("download", { timeout: 10_000 }),
    bob.page.getByRole("link", { name: /save/i }).click(),
  ]);
  const tmp = `/tmp/maishare-dl-${download.suggestedFilename()}`;
  await download.saveAs(tmp);
  const { readFile } = await import("node:fs/promises");
  const downloaded = await readFile(tmp, "utf8");
  ok("downloaded file matches byte-for-byte", downloaded === payload, `${downloaded.length} bytes`);
  screenshots.push(await bob.page.screenshot({ path: "/tmp/maishare-files.png" }));

  // ---- leave ----
  await bob.ctx.close();
  await alice.page.waitForFunction(
    () => document.querySelectorAll(".peer-list li.peer").length === 1,
    undefined,
    { timeout: 15_000 },
  );
  ok("leave propagates", true);
} finally {
  await browser.close();
  if (server) {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {}
  }
  console.log(`\n${results.filter((r) => r.pass).length}/${results.length} checks passed`);
  if (process.exitCode) {
    console.log(
      results
        .filter((r) => !r.pass)
        .map((r) => `FAILED: ${r.name}`)
        .join("\n"),
    );
  }
}
