# maishare

Local-first, **peer-to-peer** sharing for files and text chat.
Devices talk directly over WebRTC data channels — the signaling server only
introduces peers and never touches payload bytes. No TURN relay anywhere:
if a direct path exists (same LAN, or NATs that allow hole punching), it is used.

Built with **Vite+** (the unified `vp` toolchain: Vite 8 / Rolldown, Vitest, Oxlint, Oxfmt,
TypeScript 7), **TanStack Router** (generated route tree, typed params & search schemas,
loaders, intent preloading, code splitting) and the **Cloudflare Vite plugin** — client and
backend run as **one process** in dev, preview and production.

The whole surface has been through a security audit and remediation
(SEC-01…10) — [SECURITY-SPEC.md](SECURITY-SPEC.md) is the single source of truth for
every hardening invariant (CSP, origin gate, per-IP rate limits, Durable Object join
caps, ownership tokens, fragment-key invites…). Two recent capability jumps: received
files spill to **OPFS** beyond 64 MiB, so transfers are bounded by storage quota instead
of tab memory; and the page exposes a **WebMCP** toolset so in-browser agents can drive
the full pipeline.

## TL;DR (ไทย)

- แชร์ไฟล์ / แชท ข้ามเครื่องแบบ **P2P ล้วน** (WebRTC DataChannel, ไม่มี TURN)
- เน้น **local-network first**: เปิดผ่าน LAN (`--host`) แล้วให้อีกเครื่องสแกน QR
- ลิงก์เชิญมี room key ใน **URL fragment (`#k=`)** — key ไม่เคยถึง server หรือ log ใด ๆ
  payload ทุกอย่างเข้ารหัส AES-GCM แบบ end-to-end เหนือ DTLS และ peer ที่พิสูจน์ key
  ไม่ได้จะไม่ได้รับ payload เลย จนกว่าเราจะกดยอมรับเอง (ไม่มี downgrade เงียบ ๆ)
- ไฟล์ใหญ่แค่ไหนก็รับได้: เกิน 64 MiB ไหลลง **OPFS (ดิสก์)** ตรง ๆ — ขอบเขตจริงคือ
  storage quota ของเบราว์เซอร์ ไม่ใช่ RAM ของแท็บ
- ตรวจชนิดไฟล์จาก bytes จริงด้วย **Magika** (wasm ที่ vendor มา) — เติม mime/นามสกุลตอน
  ดาวน์โหลด และเตือนเมื่อ bytes หน้าตาเป็น executable
- **WebMCP**: agent ในเบราว์เซอร์เรียกใช้ห้อง/แชท/ไฟล์/nearby ได้ครบผ่าน tool ที่หน้าเว็บเปิดให้
- ผ่านการ hardening ครบชุด: CSP, origin gate, per-IP rate limit, DO join caps +
  ownership token, storage reclaim, decompression-bomb caps (ดู SECURITY-SPEC.md)
- backend เดียวคือ Cloudflare Worker (`server/worker.ts`) — รันใน process เดียวกับ Vite
  ผ่าน `@cloudflare/vite-plugin` ทั้ง dev/preview และ deploy จริง (production:
  [maishare.panudet.dev](https://maishare.panudet.dev))

## Features

| Type            | How                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Files           | Attach via paperclip / paste / drag & drop — files wait in the composer and send with your next message. 16–256 KiB chunks negotiated from SCTP `maxMessageSize`, backpressure (8 MB pause / 2 MB resume), live progress + speed, multi-peer broadcast. Receive side: RAM up to 64 MiB, then **OPFS disk streaming** (limit = storage quota); announced size is cross-checked and the first excess byte aborts the transfer                                                                                                                                     |
| Text (e2e chat) | Messages go peer-to-peer, AES-GCM sealed with the room key on top of DTLS. Key possession is _proven_ (sealed nonce ping/pong), not self-asserted — unproven peers get no payload until you explicitly consent                                                                                                                                                                                                                                                                                                                                                  |
| Conversation UI | One chat-app-style timeline: caption + attachments render as ONE bubble per message with Copy / Resend actions under it (day separators, grouped authors, jump-to-latest); a message's images open as one PhotoSwipe gallery — swipe between them, save one or zip the whole gallery                                                                                                                                                                                                                                                                            |
| File typing     | Magika content sniffing (vendored wasm, lazy ~3 MB chunk) on send and receive: fills in / overrides the browser mime, fixes download names, warns when bytes look executable despite the claimed type. A hint only — bytes transfer verbatim                                                                                                                                                                                                                                                                                                                    |
| Code & markdown | ข้อความที่ magika ตอบว่าเป็นโค้ด (python, json, shell, sql, …) เรนเดอร์เป็น code block มี syntax highlighting (highlight.js โหลดรายภาษาเมื่อใช้) พร้อมปุ่ม copy; ตัวที่เป็น markdown เรนเดอร์ rich — heading/ตาราง/list, fence ภายในไฮไลต์ด้วย, และ ```mermaid fence กลายเป็น diagram SVG จริง (mermaid โหลดเมื่อเจอ fence เท่านั้น); ทุก message ที่มีส่วน render rich มีปุ่ม View source สลับกลับเป็นข้อความดิบได้ ทั้งหมดผ่าน trust boundary ปลอดภัย: raw HTML ถูก escape, javascript:/data: links ถูกตัด, รูปแปลงเป็นลิงก์ (CSP ไม่อนุญาตรูปภายนอกอยู่แล้ว) |
| LAN discovery   | หน้าแรกแสดงห้องที่กำลังเปิดอยู่ในเครือข่ายเดียวกันแบบเรียลไทม์ — คลิกเดียวเข้าห้องได้เลย; roster (ชื่อ/จำนวนคน) เผยเฉพาะเมื่อ IP relation พิสูจน์ได้ว่าเน็ตเดียวกัน (แชร์ public IP แบบ CGNAT จะเห็นแค่ room id)                                                                                                                                                                                                                                                                                                                                                |
| PWA / offline   | ติดตั้งเป็นแอปได้ (manifest + service worker precache) — เปิดจาก cache ตอนไม่มีเน็ต; signaling/discovery (`/ws`, `/api/`) ไม่ถูก cache                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Nearby share    | โอนไฟล์/แชทกับอีกเครื่องบน Wi-Fi เดียวกันแบบไม่ใช้ server ไม่ต้องมีเน็ต: ใช้ RoomClient ชุดเดิมทั้งหมด ต่างแค่ signaling เดินผ่าน QR (`ms1z.` deflate+base64url, size-capped กัน bomb)                                                                                                                                                                                                                                                                                                                                                                          |
| Agent tools     | เมื่อเบราว์เซอร์เปิด `document.modelContext` (draft W3C WebMCP) หน้าเว็บลงทะเบียน 19 tools — ฝั่ง home: สร้างห้อง, ห้องล่าสุด, nearby start/accept/confirm; ฝั่งห้อง: สถานะ, อ่านแชท, ส่งข้อความ/ไฟล์ (รวม send-from-URL), อ่านไฟล์ที่รับแล้ว, invite, consent, cancel, clear — agent ใช้ pipeline เดียวกับ UI ทั้งหมด                                                                                                                                                                                                                                          |

## Quick start

```bash
pnpm install
pnpm run dev        # single process: vite dev server + worker (workerd) + Room DO
```

Dev/preview bind **localhost by default** (SEC-10) — pass `--host`
(`pnpm run dev -- --host`) to expose on the LAN so phones can join.
Create a room, scan the QR from another device.
Production build & local preview:

```bash
pnpm run build      # vp build → dist/client (SPA + sw.js) + dist/maishare (worker)
pnpm run preview    # vite preview: serves the build through workerd
```

### Vite+ toolchain

The repo runs on [Vite+](https://viteplus.dev) (`vite-plus@1.0.0-rc.0`); `vite` resolves to
the vite-plus core and `vite.config.ts` carries `lint` / `fmt` / `staged` blocks next to the
Vite config. Commands:

| Command                     | What it does                                                       |
| --------------------------- | ------------------------------------------------------------------ |
| `vp dev` / `pnpm run dev`   | one-process dev server: client + worker runtime + Durable Objects  |
| `vp build`                  | production build (aliased as `pnpm run build`)                     |
| `vp check`                  | oxlint + oxfmt + type-aware lint (`vp check --fix` writes fixes)   |
| `vp test`                   | Vitest unit tests (`src/**` and `server/**`)                       |
| `vp run <task>`             | run a package.json script, e.g. `vp run test:e2e`, `vp run deploy` |
| `vp install`/`add`/`remove` | package management (pnpm pinned via `devEngines`)                  |

A pre-commit hook (`.vite-hooks/`) runs `vp check --fix` on staged files.

### Tests

- `pnpm run test:e2e` — spawns `vite preview` itself, then drives headless
  Chrome peers through the whole data plane: fragment-key invites, LAN
  discovery, mesh connect, chat both ways, pending attachments that send with
  the message, file transfer with byte-for-byte download integrity, PhotoSwipe
  gallery + save-all zips, the nearby-share handshake with a direct transfer,
  the SEC-01 consent scenarios (keyless joiner gets nothing; insecure-context
  peer passes the consent gate; wrong-key joiner sees decrypt warnings), and
  leave propagation (needs `google-chrome`).
- `vp test` — unit tests for the wire protocol, OPFS spill sinks, share-code
  caps, LAN predicates, SDP sanitization, lobby/identity and the worker gates.

### Deploying to Cloudflare

`pnpm run deploy` is the one-command path (`vp build && node scripts/pwa-build.mjs &&
wrangler deploy`). Production ([maishare.panudet.dev](https://maishare.panudet.dev)) is
deployed from the plugin-generated `dist/maishare/wrangler.json` — the deployable unit
that carries the bundled worker, assets directory and DO migrations — via the hardened
script:

```bash
PUBLIC_ORIGIN=https://maishare.panudet.dev vp build && node scripts/pwa-build.mjs
node scripts/nv/deploy-production.mjs   # re-adds custom domain + rate-limiter bindings, then wrangler deploy
```

`scripts/nv/deploy-staging.mjs` deploys the same output as `maishare-nv-staging`
(workers.dev) and `scripts/nv/nv0*.mjs` are the evidence gatherers for the security
spec's needs-validation leads. One Durable Object instance per room relays SDP/ICE
only — the data path stays pure P2P.

## How it works

- **Signaling** (`server/worker.ts`): `/ws` upgrades into the **Room Durable Object**
  (one per room id) which relays offer/answer/candidates and nothing else;
  `/api/discover` asks the global **Lobby DO** for live rooms. Hardened at the edge:
  same-origin gate on upgrades, per-IP rate limits (30/min each on `/ws` and
  `/api/discover` via the Workers Rate Limiting API), per-connection signaling
  flood caps in the Room DO (token bucket, close 4409), exponential probe
  backoff for unreachable LAN rooms, 16-member / 8-per-address join
  caps, DO-minted ownership tokens (a peer-id takeover without the token gets 409),
  and a storage-reclaim alarm that wipes a room's SQLite rows a minute after it drains.
  Identity travels in the upgrade URL (`/ws?room=&peer=&name=`). In dev/preview the
  same worker runs locally inside Vite (workerd), so there is no second process anywhere.
- **Discovery**: each live room heartbeats a roster summary to the Lobby DO. The home
  page polls `GET /api/discover` every 5 s and shows a room only after opening a
  **host-only WebRTC connection** (no STUN/TURN) to one of its members through the
  relay — proof of a shared LAN. The Lobby discloses roster detail (names, counts)
  only for **topology-provable** IP matches (private /24, IPv6 /64, v4-mapped); a bare
  public-IP match — two homes behind one CGNAT — returns room ids only. Raw IPs never
  reach the client.
- **Invites & keys**: room codes are 6 chars (confusable-free alphabet); the room key
  (18 random bytes, base64url) rides the URL **fragment** (`#k=…`) and never reaches
  the server or any logging layer. Legacy `?k=` links are accepted, then scrubbed and
  migrated into the fragment on landing. Both sides derive an AES-GCM key (SHA-256 of
  `k`) and seal every payload frame.
- **Key proof & consent, and no silent losses** (SEC-01): possession of the key is
  proven with a sealed nonce ping/pong, not a self-asserted capability flag. Keyed
  rooms deliver SEALED frames to every WebCrypto-capable peer, proven or not — a
  peer that cannot open them renders an explicit "could not decrypt" bubble per
  message, so nothing ever disappears silently (plaintext still never leaves
  without proof or consent). Peers with no WebCrypto at all (e.g. iOS Safari on
  plain `http://192.168.x.x`) stay withheld until you answer one blocking consent
  prompt per peer. A peer that holds no key at all (the "On your
  network" list opens the bare room URL) asks once for a share (SEC-11): the room
  host approves one prompt and the key rides the DTLS-protected channel to it,
  after which the room is end-to-end for everyone. The host is the longest-tenured
  member, elected server-side; "keep them out" is host-exclusive and actually
  removes the joiner (close 4403 + rejoin tombstone). Creators can open key-share
  approvals to every member with the room-creation toggle.
- **File transfer** (`src/lib/p2p/protocol.ts`, `src/lib/p2p/spill.ts`): `[1-byte
type][payload]` wire — JSON control frames interleave with raw binary chunks of the
  single active transfer per connection (the channel is ordered+reliable, so
  `file-start` → chunks → `file-end` is self-framing). Every file of a multi-file
  message is announced up front with `file-queued` as soon as it is queued, so the
  receiver sees the whole queue — with "in queue — more files coming" rows — instead
  of mistaking the first finished file for the end of the transfer (previews are
  validated, capped per peer, and swept if their `file-start` never comes).
  Chunk size is negotiated from
  SCTP `maxMessageSize`; the pump pauses above 8 MB buffered and resumes at 2 MB. On
  receive, chunks stream into a sink: RAM up to 64 MiB, then a **disk sink in OPFS**
  whose `finish()` yields the OPFS-backed `File` — multi-GB results never live in
  heap — while a browser without OPFS refuses disk-sized transfers up front
  (`file-cancel: too-large`) instead of buffering. The announced size is cross-checked
  byte-by-byte; one inbound transfer per peer at a time, with a stall watchdog.
- **File typing** (`src/lib/magika.ts` + `vendor/katgpt-magika-wasm`): a 64 KiB head
  is sniffed with a vendored Rust rewrite of Magika (lazily imported wasm chunk, works
  offline in the installed PWA). Confident sniffs fill in or override the browser
  mime, fix download extensions, and executable-looking bytes behind a doc-looking
  name raise a warning. It is a hint only — bytes transfer verbatim.
- **PWA** (`scripts/pwa-build.mjs`): after `vp build`, a generated `sw.js` precaches
  the app shell (hashed assets + `/`); navigations are network-first with offline
  fallback, and `/ws` + `/api/` are never cached. Routes can carry secrets in their
  URLs, so the SW deliberately never keys a cache by navigation URL. (The manifest is
  static: `public/manifest.webmanifest`.)
- **Nearby** (`src/lib/p2p/direct.ts`, `src/lib/p2p/share-code.ts`): a QR handshake
  replaces the signaling server — a `DirectTransport` implements the same
  `RoomTransport` interface as the WebSocket client, feeding a normal `RoomClient`.
  The offer/answer is a complete host-only SDP (no ICE servers) compressed with
  `deflate-raw` into a `ms1z.…` code; pasted codes are capped before decode and
  inflated through a size-counting stream (SEC-09), so a crafted paste cannot balloon
  memory. After the handshake, nearby sessions share everything with rooms: mesh
  negotiation, the wire format, and the unified conversation UI.
- **Mesh**: every pair of peers gets its own `RTCPeerConnection`
  (perfect-negotiation pattern; deterministic initiator by `peerId` ordering, ICE
  restart once on failure, client-side peer cap with connecting-timeout eviction).
- **Agent surface** (`src/lib/p2p/webmcp.ts`): when the browser exposes
  `document.modelContext` (draft W3C WebMCP), the page registers 19 tools — home:
  create room, recent rooms, nearby start/accept/confirm; room: status, messages,
  transfers, invite, wait-peer, wait-transfer, read received file (paged base64),
  send message, send file (chunked base64), send file from URL (page-side fetch, no
  base64 overhead), set name, consent, cancel, clear history. Agents run the same
  pipeline as the UI inside the page that holds the key — E2E sealing and consent
  gates apply unchanged, and the agent never sees the key or the wire. Without
  support, registration is a silent no-op.

## TanStack Router notes

- Route tree is generated (`src/routeTree.gen.ts`, `tanstackRouter` vite plugin with `autoCodeSplitting`)
- Typed params (`/r/$roomId`) and zod-validated search schemas — `?name=` lives in the
  search schema; the room key lives in the fragment (`#k=`, read once per page; legacy
  `?k=` is accepted and scrubbed on landing). Every link and navigation stays type-safe
- Route loaders validate the room code and report capabilities
- `defaultPreload: 'intent'` + per-route `pendingComponent` / `errorComponent`

## Scripts

| Script               | What                                                                         |
| -------------------- | ---------------------------------------------------------------------------- |
| `pnpm run dev`       | one process: vite dev server + worker runtime + Room DO                      |
| `pnpm run build`     | `vp build` → `dist/client` (+ generated `sw.js`) + `dist/maishare`           |
| `pnpm run preview`   | serve the production build locally through workerd                           |
| `pnpm run typecheck` | `tsc --noEmit` for `src/` and `server/` (TypeScript 7 native compiler)       |
| `pnpm run test:e2e`  | multi-peer headless Chrome end-to-end test (spawns preview itself)           |
| `pnpm run deploy`    | quick deploy: build + PWA + `wrangler deploy` (see Deploying for production) |

## Caveats

- Cross-network pairs need NAT hole punching to succeed (no TURN by design).
- A browser without OPFS refuses transfers beyond 64 MiB rather than buffering them;
  on quota exhaustion the affected transfer fails gracefully instead of OOM-ing the tab.
- The insecure-origin escape hatch (iOS Safari on plain `http://192.168.x.x`) still
  exists but is opt-in per peer via the consent prompt; until consented, those peers
  receive nothing.
- Recent rooms are remembered in `localStorage` (`maishare.recents`) together with
  their key, so reopening is one tap — that key sits on disk in the browser profile.
- Plain `wrangler deploy` is the quick path only; production deploys go through
  `scripts/nv/deploy-production.mjs`, whose generated dist config is the deployable unit.
