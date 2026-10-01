// End-to-end smoke test: headless Chrome contexts act as peers on one network.
import { unzipSync } from "fflate";
// Verifies signaling, LAN room discovery, P2P data channel, chat, pending
// attachments and file transfer. Spawns `vite preview` itself (workerd runs
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

  // production CSP stays tight: the sniffing wasm may compile, inline scripts
  // may not — 'unsafe-inline' is dev-only (vite's react-refresh preamble)
  const csp = (await fetch(`${BASE}/`)).headers.get("content-security-policy") ?? "";
  const scriptSrc = csp.match(/script-src[^;]*/)?.[0] ?? "";
  ok(
    "prod CSP: script-src allows wasm but not inline",
    scriptSrc.includes("'wasm-unsafe-eval'") && !scriptSrc.includes("'unsafe-inline'"),
    scriptSrc,
  );

  // ---- mobile 320px: no horizontal overflow, roster sheet actually opens ----
  // Regression for two real failures at phone width: (a) the home grid's bare
  // `1fr` track used the join form's intrinsic input width as its minimum and
  // pushed the page to ~354px of horizontal scroll; (b) the roster bottom
  // sheet opened with ZERO height — `.room-body .peers { display:none }` also
  // matched the PeerList inside the sheet (the peers chip tap looked dead) —
  // and an equal-specificity base rule placed after the media block kept the
  // byte-total chips visible at phone width.
  {
    const mob = await browser.newContext({
      viewport: { width: 320, height: 671 },
      isMobile: true,
      hasTouch: true,
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const mp = await mob.newPage();
    await mp.goto(BASE, { waitUntil: "domcontentloaded" });
    await mp.getByText("Start sharing").waitFor({ timeout: 10_000 });
    const homeW = await mp.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    ok(
      "mobile 320: home has no horizontal overflow",
      homeW.scroll <= homeW.client,
      `scrollWidth ${homeW.scroll} vs ${homeW.client}`,
    );

    await mp.getByLabel("Your display name").fill("mobile");
    await mp.getByRole("button", { name: /create a room/i }).click();
    await mp.waitForURL(/\/r\//, { timeout: 10_000 });
    // getByText would hit the hidden sidebar PeerList first (same text) — the
    // header badge is the visible one
    await mp.locator(".conv-head .badge").waitFor({ timeout: 10_000 });
    const chip = mp.locator("button.stat-peers");
    ok("mobile 320: peers chip renders as a button", (await chip.count()) === 1);
    ok(
      "mobile 320: byte-total stats are hidden",
      await mp.evaluate(() =>
        [...document.querySelectorAll(".conv-head .stat:not(.stat-peers)")].every(
          (el) => getComputedStyle(el).display === "none",
        ),
      ),
    );
    await chip.click();
    const sheetBox = await mp
      .locator(".roster-sheet")
      .waitFor({ timeout: 3000 })
      .then(() => mp.locator(".roster-sheet").boundingBox());
    ok(
      "mobile 320: roster sheet opens with real height",
      !!sheetBox && sheetBox.height > 100,
      JSON.stringify(sheetBox),
    );
    // the floating close button must not bury the roster's count chip
    await mp.waitForTimeout(400); // let the rise animation settle
    const overlap = await mp.evaluate(() => {
      const hit = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { l: b.left, r: b.right, t: b.top, b: b.bottom };
      };
      const close = hit(".roster-close");
      const count = hit(".roster-sheet .count-chip");
      if (!close || !count) return null;
      return !(
        close.r <= count.l ||
        count.r <= close.l ||
        close.b <= count.t ||
        count.b <= close.t
      );
    });
    ok(
      "mobile 320: close button clears the roster count chip",
      overlap === false,
      `overlap=${overlap}`,
    );
    await mp.keyboard.press("Escape");
    ok(
      "mobile 320: Escape closes the roster sheet",
      (await mp.locator(".roster-backdrop").count()) === 0,
    );
    await mob.close();
  }

  // ---- create a room ----
  await alice.page.getByLabel("Your display name").fill("alice");
  await alice.page.getByRole("button", { name: /create a room/i }).click();
  await alice.page.waitForURL(/\/r\//, { timeout: 10_000 });
  const invite = alice.page.url();
  const roomId = new URL(invite).pathname.split("/").pop();
  ok("room created with key in fragment", /#k=/.test(invite) && !/\?k=/.test(invite), roomId);

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

  // files go through the same pending-attachment composer as rooms
  const nearbyPayload = `maishare nearby payload ${Date.now()}\n`.repeat(1000); // ~27 KB
  await n1.page.setInputFiles("input[type=file]", {
    name: "nearby-payload.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(nearbyPayload),
  });
  await n1.page
    .locator(".attach-chip", { hasText: "nearby-payload.txt" })
    .waitFor({ timeout: 5000 });
  await n1.page.getByRole("button", { name: "Send", exact: true }).click();
  await n2.page.locator(".transfer-done").first().waitFor({ timeout: 30_000 });
  ok("nearby file received", true);
  const [nbDownload] = await Promise.all([
    n2.page.waitForEvent("download", { timeout: 10_000 }),
    n2.page.getByRole("link", { name: /save/i }).click(),
  ]);
  const nbPath = `/tmp/maishare-nb-${nbDownload.suggestedFilename()}`;
  await nbDownload.saveAs(nbPath);
  const { readFile: nbReadFile } = await import("node:fs/promises");
  const nbContent = await nbReadFile(nbPath, "utf8");
  ok("nearby file matches byte-for-byte", nbContent === nearbyPayload, `${nbContent.length} bytes`);

  // and the chat composer is the same Conversation component rooms use
  await n1.page.getByRole("textbox", { name: "Message" }).fill("nearby hello");
  await n1.page.getByRole("button", { name: "Send", exact: true }).click();
  await n2.page.getByText("nearby hello").waitFor({ timeout: 10_000 });
  ok("nearby chat works via the room panel", true);

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
  await alice.page.getByRole("textbox", { name: "Message" }).fill("hello from alice");
  await alice.page.getByRole("button", { name: "Send", exact: true }).click();
  await bob.page.getByText("hello from alice").waitFor({ timeout: 10_000 });
  ok("chat arrives p2p", true);
  await bob.page.getByRole("textbox", { name: "Message" }).fill("hi alice, bob here");
  await bob.page.getByRole("button", { name: "Send", exact: true }).click();
  await alice.page.getByText("hi alice, bob here").waitFor({ timeout: 10_000 });
  ok("chat is bidirectional", true);
  await bob.page.locator(".msg-lock.is-sealed").first().waitFor({ timeout: 5000 });
  ok("sealed messages show the closed lock", true);

  // ---- pasted code: the magika sniff drives a highlighted code bubble ----
  const pySnippet = [
    "def greet(name):",
    '    print(f"hello {name}")',
    "    return None",
    "",
    "",
    "greet('bob')",
  ].join("\n");
  await alice.page.getByRole("textbox", { name: "Message" }).fill(pySnippet);
  await alice.page.getByRole("button", { name: "Send", exact: true }).click();
  await bob.page.locator(".bubble-code", { hasText: "greet" }).waitFor({ timeout: 20_000 });
  ok("code bubble renders for a pasted snippet", true);
  await bob.page.locator(".bubble-code-lang", { hasText: "python" }).waitFor({ timeout: 10_000 });
  ok("code bubble names the detected language", true);
  await bob.page.locator(".bubble-code .hljs-keyword").first().waitFor({ timeout: 10_000 });
  ok("code bubble is syntax highlighted", true);
  await alice.page.locator(".bubble-code .hljs-keyword").first().waitFor({ timeout: 10_000 });
  ok("sender's own code bubble highlights too", true);
  screenshots.push(await bob.page.screenshot({ path: "/tmp/maishare-code-bubble.png" }));

  // copy a received message back out from under its bubble
  await bob.page
    .locator(".msg", { hasText: "hello from alice" })
    .getByRole("button", { name: "Copy message" })
    .click();
  await bob.page
    .getByText("Copied to your clipboard")
    .waitFor({ timeout: 5000 })
    .catch(() => {});
  const copied = await bob.page.evaluate(() => navigator.clipboard.readText());
  ok("copy under bubble works", copied === "hello from alice", copied);
  screenshots.push(await alice.page.screenshot({ path: "/tmp/maishare-chat.png" }));

  // ---- attachments wait in the composer (Discord-style), send on Enter ----
  const payload = `maishare e2e payload ${Date.now()}\n`.repeat(2000); // ~52 KB
  await alice.page.setInputFiles("input[type=file]", {
    name: "e2e-payload.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(payload),
  });
  // nothing transfers before Enter: no transfer bubble yet on either side
  await alice.page
    .locator(".attach-chip", { hasText: "e2e-payload.txt" })
    .waitFor({ timeout: 5000 });
  await bob.page
    .getByText("e2e-payload.txt")
    .waitFor({ timeout: 2000 })
    .then(
      () => ok("nothing transfers before Enter", false),
      () => ok("nothing transfers before Enter", true),
    );

  // one message = text + attachments
  await alice.page.getByRole("textbox", { name: "Message" }).fill("here comes the payload");
  await alice.page.keyboard.press("Enter");
  await alice.page.getByText("here comes the payload").waitFor({ timeout: 10_000 });
  ok("attached message sent by alice", true);
  await bob.page.getByText("here comes the payload").waitFor({ timeout: 10_000 });
  await bob.page.locator(".bubble-file.transfer-done").first().waitFor({ timeout: 30_000 });
  ok("text and file arrive together on bob", true);
  const combinedMsg = bob.page.locator(".msg", { hasText: "here comes the payload" });
  ok(
    "text and attachment share ONE bubble",
    (await combinedMsg.locator(".bubble").count()) === 1 &&
      (await combinedMsg.locator(".bubble-file").count()) === 1,
  );

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

  // ---- file-only message (no text) still transfers on Enter ----
  const bare = Buffer.from("bare file".repeat(400));
  await bob.page.setInputFiles("input[type=file]", {
    name: "bare.txt",
    mimeType: "text/plain",
    buffer: bare,
  });
  await bob.page.locator(".attach-chip", { hasText: "bare.txt" }).waitFor({ timeout: 5000 });
  await bob.page.getByRole("button", { name: "Send", exact: true }).click();
  await alice.page.locator(".bubble-file.transfer-done", { hasText: "bare.txt" }).waitFor({
    timeout: 30_000,
  });
  ok("file-only message received by alice", true);

  // resend pushes the files out again as a fresh message for late joiners
  await bob.page
    .locator(".msg", { hasText: "bare.txt" })
    .getByRole("button", { name: "Resend message" })
    .click();
  await bob.page.getByText("Resending 1 file").waitFor({ timeout: 5000 });
  await alice.page.waitForFunction(
    () =>
      [...document.querySelectorAll(".bubble-file.transfer-done .bubble-file-name")].filter(
        (el) => el.textContent === "bare.txt",
      ).length >= 2,
    undefined,
    { timeout: 30_000 },
  );
  ok("resend delivers the file again", true);

  // ---- images sent in one message form one PhotoSwipe gallery ----
  const pngRed = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const pngClear = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
    "base64",
  );
  await alice.page.setInputFiles("input[type=file]", [
    { name: "pic-a.png", mimeType: "image/png", buffer: pngRed },
    { name: "pic-b.png", mimeType: "image/png", buffer: pngClear },
  ]);
  await alice.page.locator(".attach-chip", { hasText: "pic-b.png" }).waitFor({ timeout: 5000 });
  await alice.page.getByRole("button", { name: "Send", exact: true }).click();
  await bob.page.waitForFunction(
    () => document.querySelectorAll(".bubble-img.is-done").length >= 2,
    undefined,
    { timeout: 30_000 },
  );
  ok("two images received as one message", true);

  await bob.page.locator(".bubble-img").first().click();
  await bob.page.getByText("1 / 2").waitFor({ timeout: 10_000 });
  await bob.page.getByRole("button", { name: "Next" }).click();
  await bob.page.getByText("2 / 2").waitFor({ timeout: 10_000 });
  ok("lightbox carousel walks the message group", true);
  await bob.page.waitForTimeout(400); // let the slide transition settle
  const [gallerySave] = await Promise.all([
    bob.page.waitForEvent("download", { timeout: 10_000 }),
    bob.page.getByRole("button", { name: "Save image" }).click(),
  ]);
  ok("save works from the gallery viewer", !!gallerySave);

  // Save all: every image of the message arrives as one zip archive
  await bob.page.waitForTimeout(400);
  const [zipDl] = await Promise.all([
    bob.page.waitForEvent("download", { timeout: 10_000 }),
    bob.page.locator(".pswp__button--save-all").click(),
  ]);
  ok(
    "save-all produces the gallery zip",
    zipDl.suggestedFilename() === "maishare-gallery.zip",
    zipDl.suggestedFilename(),
  );
  const zipPath = `/tmp/maishare-${zipDl.suggestedFilename()}`;
  await zipDl.saveAs(zipPath);
  const zipped = unzipSync(
    new Uint8Array(await (await import("node:fs/promises")).readFile(zipPath)),
  );
  const names = Object.keys(zipped).sort();
  ok(
    "gallery zip holds every image",
    JSON.stringify(names) === JSON.stringify(["pic-a.png", "pic-b.png"]),
    names.join(", "),
  );
  ok(
    "zip content matches the original bytes",
    Buffer.compare(Buffer.from(zipped["pic-a.png"]), pngRed) === 0 &&
      Buffer.compare(Buffer.from(zipped["pic-b.png"]), pngClear) === 0,
  );
  await bob.page.keyboard.press("Escape");

  // save all from under the bubble: same zip, one click, no viewer needed
  const [bubbleZip] = await Promise.all([
    bob.page.waitForEvent("download", { timeout: 10_000 }),
    bob.page
      .locator(".msg", { has: bob.page.locator(".thumb-cell") })
      .getByRole("button", { name: "Save all attachments" })
      .click(),
  ]);
  ok(
    "bubble save-all produces the zip",
    bubbleZip.suggestedFilename() === "maishare-attachments.zip",
    bubbleZip.suggestedFilename(),
  );
  const bubblePath = `/tmp/maishare-${bubbleZip.suggestedFilename()}`;
  await bubbleZip.saveAs(bubblePath);
  const bubbleZipped = unzipSync(
    new Uint8Array(await (await import("node:fs/promises")).readFile(bubblePath)),
  );
  ok(
    "bubble zip holds every image",
    JSON.stringify(Object.keys(bubbleZipped).sort()) === JSON.stringify(["pic-a.png", "pic-b.png"]),
  );

  // ---- SEC-01: a secure-context joiner WITHOUT the key receives nothing ----
  // they claim crypto capability, so no consent prompt may appear — the room
  // key is the only way in, and the header lock still reflects key presence
  const eveCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const eveUrl = new URL(invite);
  eveUrl.hash = ""; // strip the fragment key: eve is the keyless joiner
  eveUrl.searchParams.set("name", "eve");
  const evePage = await eveCtx.newPage();
  await evePage.goto(eveUrl.href, { waitUntil: "domcontentloaded" });
  await alice.page.getByText("2 peers", { exact: true }).waitFor({ timeout: 20_000 });
  ok(
    "no consent prompt for a crypto-capable joiner",
    (await alice.page.locator(".consent-overlay").count()) === 0,
  );
  ok(
    "keyed room header shows the lock",
    (await alice.page.locator(".room-code svg").count()) === 1,
  );
  ok("keyless joiner header has no lock", (await evePage.locator(".room-code svg").count()) === 0);
  await alice.page.getByRole("textbox", { name: "Message" }).fill("eve must not see this");
  await alice.page.getByRole("button", { name: "Send", exact: true }).click();
  await bob.page.getByText("eve must not see this").waitFor({ timeout: 10_000 });
  ok("proven peer still receives sealed chat", true);
  await evePage
    .getByText("eve must not see this")
    .waitFor({ timeout: 3000 })
    .then(
      () => ok("secure keyless joiner receives nothing", false),
      () => ok("secure keyless joiner receives nothing", true),
    );
  await eveCtx.close();
  await alice.page.waitForFunction(
    () => document.querySelectorAll(".peer-list li.peer").length === 2,
    undefined,
    { timeout: 15_000 },
  );

  // ---- a peer without crypto.subtle (iOS Safari on plain http LAN) ----
  // the host's room is sealed with AES-GCM; this peer cannot prove key
  // possession at all, so the blocking consent gate decides its fate — the
  // documented fallback stays usable, but only with an explicit downgrade
  const iosCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await iosCtx.addInitScript(() => {
    try {
      Object.defineProperty(Object.getPrototypeOf(window.crypto), "subtle", {
        get: () => undefined,
        configurable: true,
      });
    } catch {}
  });
  const iosPage = await iosCtx.newPage();
  const iosUrl = new URL(invite);
  iosUrl.searchParams.set("name", "ios");
  await iosPage.goto(iosUrl.href, {
    waitUntil: "domcontentloaded",
  });
  const hasSubtle = await iosPage.evaluate(() => window.crypto.subtle !== undefined);
  ok("insecure peer really lacks crypto.subtle", !hasSubtle);
  await alice.page.getByText("2 peers", { exact: true }).waitFor({ timeout: 20_000 });

  // the blocking consent gate is the only way content reaches this peer
  await alice.page
    .getByRole("button", { name: /send without end-to-end encryption/i })
    .waitFor({ timeout: 15_000 });
  ok("blocking consent prompt appears for the incapable peer", true);
  await alice.page.getByRole("button", { name: /send without end-to-end encryption/i }).click();

  await alice.page.getByRole("textbox", { name: "Message" }).fill("hello ios");
  await alice.page.getByRole("button", { name: "Send", exact: true }).click();
  await iosPage.getByText("hello ios").waitFor({ timeout: 10_000 });
  ok("insecure peer receives chat from a sealed room", true);
  await iosPage.locator(".msg-lock.is-open").first().waitFor({ timeout: 5000 });
  ok("dtls-only messages show the open lock", true);

  const iosPayload = `maishare ios payload ${Date.now()}\n`.repeat(50);
  await alice.page.setInputFiles("input[type=file]", {
    name: "ios-payload.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(iosPayload),
  });
  await alice.page.getByRole("button", { name: "Send", exact: true }).click();
  await iosPage
    .locator(".bubble-file.transfer-done", { hasText: "ios-payload.txt" })
    .waitFor({ timeout: 30_000 });
  ok("insecure peer receives files from a sealed room", true);

  await iosPage.getByRole("textbox", { name: "Message" }).fill("hello from ios");
  await iosPage.getByRole("button", { name: "Send", exact: true }).click();
  await alice.page.getByText("hello from ios").waitFor({ timeout: 10_000 });
  ok("insecure peer sends chat to the sealed room", true);
  // the insecure sender must label its OWN message dtls-only (open lock),
  // matching what the receiver sees — not a green sealed lock
  await iosPage
    .locator(".msg", { hasText: "hello from ios" })
    .locator(".msg-lock.is-open")
    .waitFor({ timeout: 5000 });
  ok("insecure sender labels its own message dtls-only", true);
  await iosCtx.close();

  // ---- wrong-key joiner: unreadable frames must notify BOTH sides ----
  const rogueCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const rogueUrl = new URL(invite);
  // legacy ?k= form: exercises the room route's migration (consumed, moved to
  // the fragment) with a WRONG key — mallory must end up with that wrong key
  rogueUrl.hash = "";
  rogueUrl.searchParams.set("k", "zzzzzzzzzzzzzzzz");
  rogueUrl.searchParams.set("name", "mallory");
  const mallory = await rogueCtx.newPage();
  await mallory.goto(rogueUrl.href, { waitUntil: "domcontentloaded" });
  await alice.page.getByText("2 peers", { exact: true }).waitFor({ timeout: 20_000 });

  await alice.page.getByRole("textbox", { name: "Message" }).fill("secret to real peers");
  await alice.page.getByRole("button", { name: "Send", exact: true }).click();
  await bob.page.getByText("secret to real peers").waitFor({ timeout: 10_000 });
  ok("real peer still reads sealed rooms normally", true);
  await mallory
    .locator(".bubble-line", { hasText: /could not decrypt this message/i })
    .first()
    .waitFor({ timeout: 10_000 });
  ok("wrong-key joiner sees an unreadable-message warning (no silence)", true);
  await alice.page.getByText(/your message could not be decrypted/i).waitFor({ timeout: 10_000 });
  ok("sender is told the other side could not decrypt", true);
  await rogueCtx.close();

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
