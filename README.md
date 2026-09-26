# maishare

Local-first, **peer-to-peer** sharing for files, clipboard, text chat and pastes.
Devices talk directly over WebRTC data channels — the signaling server only
introduces peers and never touches payload bytes. No TURN relay anywhere:
if a direct path exists (same LAN, or NATs that allow hole punching), it is used.

Built with **Vite+** (the unified `vp` toolchain: Vite 8 / Rolldown, Vitest, Oxlint, Oxfmt,
TypeScript 7), **TanStack Router** (generated route tree, typed params & search schemas,
loaders, intent preloading, code splitting) and the **Cloudflare Vite plugin** — client and
backend run as **one process** in dev, preview and production.

## TL;DR (ไทย)

- แชร์ไฟล์ / คลิปบอร์ด / แชท / paste ข้ามเครื่องแบบ **P2P ล้วน** (WebRTC DataChannel, ไม่มี TURN)
- เน้น **local-network first**: เปิดผ่าน LAN (`vite --host`) แล้วให้อีกเครื่องสแกน QR
- ลิงก์เชิญมี room key (`?k=`) — payload ทุกอย่างถูกเข้ารหัส AES-GCM แบบ end-to-end เหนือ DTLS
- backend เดียวคือ Cloudflare Worker (`server/worker.ts`) — รันใน process เดียวกับ Vite ผ่าน `@cloudflare/vite-plugin` ทั้ง dev/preview และ deploy จริง

## Features

| Type            | How                                                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Files           | Drag & drop / picker / paste anywhere in a room. 64–256 KB chunks, SCTP backpressure (`bufferedamountlow`), live progress + speed, multi-peer broadcast |
| Clipboard       | "Send my clipboard" reads text or images; incoming text can auto-copy; one-click copy-back                                                              |
| Text (e2e chat) | Messages go peer-to-peer, AES-GCM sealed with the room key on top of DTLS                                                                               |
| Pasting         | ⌘/Ctrl+V anywhere in a room: files & images become transfers, text becomes a clipboard item                                                             |
| LAN discovery   | หน้าแรกแสดงห้องที่กำลังเปิดอยู่ในเครือข่ายเดียวกัน (NAT เดียวกันหรือ subnet เดียวกัน) แบบเรียลไทม์ — คลิกเดียวเข้าห้องได้เลย                            |
| PWA / offline   | ติดตั้งเป็นแอปได้ (manifest + service worker precache) — เปิดจาก cache ตอนไม่มีเน็ต; signaling/discovery ไม่ถูก cache                                   |
| Nearby share    | โอนไฟล์ตรงระหว่างสองเครื่องบน Wi-Fi เดียวกันแบบไม่ใช้ server ไม่ต้องมีเน็ต: แลก offer/answer ด้วย QR (`ms1z.` deflate+base64url) บน host-only WebRTC    |

## Quick start

```bash
pnpm install
pnpm run dev        # single process: vite dev server + worker (workerd) + Room DO
```

Open the printed URL — pass `--host` or use `pnpm run dev -- --host` to expose it on
the LAN so phones can join. Create a room, scan the QR from another device.
Production build & local preview:

```bash
pnpm run build      # vp build → dist/client (SPA) + dist/maishare (worker)
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
| `vp test`                   | Vitest unit tests (`src/**/*.test.ts`)                             |
| `vp run <task>`             | run a package.json script, e.g. `vp run test:e2e`, `vp run deploy` |
| `vp install`/`add`/`remove` | package management (pnpm pinned via `devEngines`)                  |

A pre-commit hook (`.vite-hooks/`) runs `vp check --fix` on staged files.

### Tests

- `pnpm run test:e2e` — spawns `vite preview` itself, then drives two headless
  Chrome peers and verifies the whole data plane: signaling through the worker,
  mesh connect, chat both ways, clipboard send/receive/copy-back, file transfer
  with byte-for-byte download integrity, and leave propagation (needs `google-chrome`).
- `vp test` — unit tests for the wire protocol and formatting helpers.

### Deploying to Cloudflare

`wrangler deploy` picks up the Vite plugin's build output (SPA assets + worker) directly:

```bash
pnpm run deploy     # vp build && wrangler deploy
```

One Durable Object instance per room relays SDP/ICE only — the data path stays pure P2P.

## How it works

- **Signaling** (`server/worker.ts`, Cloudflare Worker + Durable Objects):
  WebSocket rooms keyed by room id, relays offer/answer/candidates and reports
  the request origin as the room endpoint. Identity travels in the upgrade URL
  (`/ws?room=&peer=&name=`). That's all it does. In dev/preview the same worker
  runs locally inside Vite (workerd), so there is no second process anywhere.
- **Discovery**: each live room heartbeats a roster summary (client IP →
  connection count, display names — never payloads or room keys) to the `Lobby`
  Durable Object. The home page polls `GET /api/discover` for _candidates_
  (cheap IP pre-filter: exact public IP, private /24, or IPv6 /64) and shows a
  room only after opening a **host-only WebRTC connection** (no STUN/TURN) to
  one of its members through the relay — proof of a shared LAN. IP matches can
  be false positives (two homes behind one CGNAT share a public IP); a
  host-to-host data channel cannot. Raw IPs and other networks' rooms never
  reach the client.
- **PWA** (`scripts/pwa-build.mjs`): after `vp build`, a service worker is
  generated that precaches the app shell (hashed assets + index.html), so an
  installed PWA boots with no network. Signaling/discovery traffic is never
  cached.
- **Nearby** (`src/lib/nearby/`): two browsers on one LAN exchange a complete
  host-only SDP offer/answer as QR codes (compressed with `deflate-raw`), then
  reuse the room wire framing on a direct data channel — no signaling server
  involved, so it works with no internet at all.
- **Mesh**: every pair of peers gets its own `RTCPeerConnection`
  (perfect-negotiation pattern; deterministic initiator by `peerId` ordering,
  ICE restart once on failure).
- **Wire format** (`src/lib/p2p/protocol.ts`): `[1-byte type][payload]` — JSON
  control frames interleave with raw binary chunks of the single active file
  per connection (the channel is ordered+reliable, so `file-start` → chunks →
  `file-end` is self-framing).
- **Speed**: chunk size = negotiated SCTP `maxMessageSize` (≤256 KB), pump
  pauses above 8 MB buffered and resumes at 2 MB.
- **E2E**: the invite link carries `?k=<random>`; both sides derive an AES-GCM
  key (SHA-256 of `k`) and seal every frame. The signaling server never sees
  `k`. Anyone without the link can neither join nor decrypt.

## TanStack Router notes

- Route tree is generated (`src/routeTree.gen.ts`, `tanstackRouter` vite plugin with `autoCodeSplitting`)
- Typed params (`/r/$roomId`) and zod-validated search schemas — room UI state
  lives in the URL: `?tab=chat|files|clipboard`, `?q=`, `?sort=`, `?name=`, `?k=`
  (all optional with `.catch()` defaults, so every link and navigation is type-safe)
- Route loaders validate the room code and report capabilities
- `defaultPreload: 'intent'` + per-route `pendingComponent` / `errorComponent`

## Scripts

| Script               | What                                                             |
| -------------------- | ---------------------------------------------------------------- |
| `pnpm run dev`       | one process: vite dev server + worker runtime + Room DO          |
| `pnpm run build`     | `vp build` → `dist/client` + `dist/maishare`                     |
| `pnpm run preview`   | serve the production build locally through workerd               |
| `pnpm run typecheck` | `tsc --noEmit` (TypeScript 7 native compiler)                    |
| `pnpm run test:e2e`  | two-peer headless Chrome end-to-end test (spawns preview itself) |
| `pnpm run deploy`    | `vp build && wrangler deploy`                                    |

## Caveats

- Clipboard _reading_ needs a secure context (HTTPS or localhost). Pasting and
  receiving work everywhere.
- Received files buffer in memory (Blob); fine for the LAN-sized payloads this
  is designed for.
- Cross-network pairs need NAT hole punching to succeed (no TURN by design).
