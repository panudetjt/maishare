// maishare signaling worker (TypeScript): static SPA assets + WebSocket
// signaling via the Room Durable Object (one instance per room id).
// Payloads stay P2P — the DO only relays WebRTC handshakes (SDP/ICE).
// The Lobby DO powers LAN room discovery: rooms heartbeat a roster summary
// (IP -> connection count + display names), and /api/discover lists only the
// rooms reachable from the caller's own network. Raw IPs never leave the DOs.

import { isValidIp, provableLan, sameLan } from "./lan";
import { sanitizeSdpCandidates } from "./sdp";
import { rewriteShareHtml } from "./share-html";

/**
 * Security headers on HTML navigations (audit hardening). CSP cuts the blast
 * radius of any future XSS to same-origin resources; frame-ancestors +
 * X-Frame-Options block clickjacking embeds; referrer-policy keeps query
 * strings (the invite key) out of cross-origin referrers. The app needs no
 * inline scripts and no third-party origins, so the policy is tight — inline
 * STYLES stay allowed (React/PhotoSwipe inject style attributes), and
 * 'wasm-unsafe-eval' keeps the Magika content-sniffing wasm working without
 * opening the door to eval(). Dev runs one step looser: Vite's react-refresh
 * preamble is an inline script, so the production script-src would block it
 * and leave `vp dev` a blank page — production/preview/deploy stay tight.
 */
const CSP_SCRIPT_SRC = import.meta.env.PROD
  ? "script-src 'self' 'wasm-unsafe-eval'"
  : "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'";

const HTML_SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy":
    `default-src 'self'; ${CSP_SCRIPT_SRC}; style-src 'self' 'unsafe-inline'; ` +
    "img-src 'self' data: blob:; media-src 'self' blob:; " +
    "connect-src 'self' blob: ws: wss:; " +
    "worker-src 'self'; manifest-src 'self'; font-src 'self'; object-src 'none'; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-content-type-options": "nosniff",
};

const RE_ROOM = /^[\w-]{2,64}$/;
const RE_PEER = /^[\w-]{8,64}$/;
/** invite navigations (shareable links) — handled by the worker for per-room
 * social previews; run_worker_first in wrangler.jsonc routes these here */
const RE_ROOM_PATH = /^\/r\/([\w-]{2,64})$/;

const LOBBY_NAME = "global";
/** rooms stop being advertised this long after their last roster change */
const STALE_MS = 80_000;
/** rooms refresh their lobby entry on every roster change and this often */
const HEARTBEAT_MS = 30_000;

/** SEC-05: member sockets per room — each join's roster-broadcast fan-out is
 * O(room), so the DO refuses joins beyond this before accepting the socket */
const MAX_ROOM_MEMBERS = 16;
/** SEC-05: member sockets per client address — one host cannot open many
 * signaling sockets and drive allocations in every member's tab */
const MAX_MEMBERS_PER_ADDRESS = 8;
/** SEC-08: peer-id ownership tokens are wiped this long after the last
 * member leaves (the room drained) */
const TOKEN_GRACE_MS = 60_000;

/** SEC-12: per-connection signaling flood cap. The WS upgrade is rate-limited
 * per IP at the edge, but messages inside one connection were unbounded —
 * each one wakes the DO (a billable invocation), so a single cheap socket
 * could pump millions of requests. A token bucket per socket bounds the
 * relay: capacity covers the worst legitimate burst (a 16-member join storm
 * relaying offers/candidates to every peer at once), the refill rate bounds
 * sustained load, and enough over-budget messages close the socket. */
const FLOOD_RATE = 40; // tokens refilled per second
const FLOOD_BURST = 200; // bucket capacity
const FLOOD_MAX_VIOLATIONS = 50; // over-budget messages before close(4409)

interface FloodState {
  tokens: number;
  last: number;
  violations: number;
}

/** 1-day supply-chain policy: only versions older than the window resolve */
interface PeerMeta {
  peerId: string;
  name: string;
  /** client IP as seen by the edge (used for LAN discovery matching) */
  ip: string;
  /** discovery probers ride the room's relay but are invisible to the room */
  probe?: boolean;
  /** SEC-08: ownership token minted at this peer's first admission */
  token?: string;
  /** admission order (lower = earlier) — elects the room host; survives
   * reconnects because a replacing socket inherits the incumbent's seq */
  seq?: number;
}

/** shape of messages peers send over the signaling channel */
type SignalMessage =
  | { t: "signal"; to: string; data: unknown }
  | { t: "name"; name: string }
  | { t: "leave" }
  // host-only: remove a member from the room (the "keep them out" answer)
  | { t: "kick"; peerId: string };

/** who may answer a key-share request from a keyless joiner (SEC-11):
 * "host" (default) gates the decision to the room host, "anyone" restores
 * the any-member behavior a creator can opt into at room creation */
type KeySharePolicy = "host" | "anyone";

/** managed Rate Limiting API binding (see "unsafe.bindings" in wrangler.jsonc;
 * the limit window itself is declared in config, not per call) */
interface RateLimitBinding {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

interface Env {
  /** one Durable Object instance per room id */
  ROOM: DurableObjectNamespace;
  /** discovery registry (single global instance) */
  LOBBY: DurableObjectNamespace;
  /** the SPA build output (wired by @cloudflare/vite-plugin) */
  ASSETS: Fetcher;
  /** NV-05: extra WebSocket origins allowed past the same-origin gate
   * (comma-separated; only needed when signaling lives behind a different
   * host than the page — same-origin covers every default deployment) */
  ALLOWED_ORIGINS?: string;
  /** per-IP request-rate gates on the floodable endpoints (fail-open) */
  RATE_LIMITER_WS?: RateLimitBinding;
  RATE_LIMITER_DISCOVER?: RateLimitBinding;
}

/**
 * Per-key request-rate check for the endpoints that need frequency limits
 * (caps elsewhere bound what ONE request can do; this bounds HOW OFTEN).
 * Any binding failure fails open — the app never breaks because of its own
 * guard, and local/test envs without the binding just skip it.
 */
async function allowRate(binding: RateLimitBinding | undefined, key: string): Promise<boolean> {
  if (!binding) return true;
  try {
    return (await binding.limit({ key })).success !== false;
  } catch {
    return true;
  }
}

/** what a Room DO reports to the Lobby */
interface Announce {
  roomId: string;
  /** client IP -> live connection count from that IP */
  ips: Record<string, number>;
  /** display names of connected peers (deduped) */
  names: string[];
}

interface LobbyRoom {
  ips: Record<string, number>;
  names: string[];
  since: number;
  updatedAt: number;
}

interface RosterEntry {
  ws: WebSocket;
  meta: PeerMeta;
}

function parseSignal(raw: string): SignalMessage | null {
  try {
    const msg = JSON.parse(raw) as SignalMessage;
    if (typeof msg?.t !== "string") return null;
    return msg;
  } catch {
    return null;
  }
}

export class Room {
  private readonly state: DurableObjectState;
  private readonly env: Env;
  private roomId = "";
  /** SEC-12 flood buckets, keyed by socket — instance memory only (an active
   * flood keeps the DO alive, so the bucket persists through the abuse) */
  private readonly flood = new Map<WebSocket, FloodState>();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    // Keep idle hibernating sockets alive through load-balancer pings.
    // Optional: pings then simply wake the DO instead. Runtimes disagree on
    // the method name (autoResponse vs autoResponsePair) — support both.
    const api = state as unknown as {
      setWebSocketAutoResponse?: (p: WebSocketRequestResponsePair) => void;
      setWebSocketAutoResponsePair?: (p: WebSocketRequestResponsePair) => void;
    };
    try {
      const pair = new WebSocketRequestResponsePair("ping", "pong");
      (api.setWebSocketAutoResponse ?? api.setWebSocketAutoResponsePair)?.call(api, pair);
    } catch {
      /* not supported here */
    }
  }

  /** Enumerate live sockets with their {peerId, name} attachment. */
  private roster(): RosterEntry[] {
    return this.state
      .getWebSockets()
      .map((ws) => ({ ws, meta: ws.deserializeAttachment() as PeerMeta }))
      .filter((e): e is RosterEntry => Boolean(e.meta?.peerId));
  }

  /** The sockets that actually participate in the room (probes excluded). */
  private realRoster(): RosterEntry[] {
    return this.roster().filter((e) => !e.meta.probe);
  }

  private send(ws: WebSocket, obj: unknown): void {
    try {
      ws.send(JSON.stringify(obj));
    } catch {
      /* socket died mid-send; the close handler cleans up */
    }
  }

  private broadcast(obj: unknown, exceptPeerId: string): void {
    for (const { ws, meta } of this.realRoster()) {
      if (meta.peerId !== exceptPeerId) this.send(ws, obj);
    }
  }

  /** The room host: the longest-tenured member (lowest admission seq). The
   * designation is server-authoritative — clients learn it from the welcome
   * and from host-change broadcasts, never by self-assertion. */
  private hostPeerId(): string | null {
    let host: RosterEntry | null = null;
    for (const e of this.realRoster()) {
      if (!host || (e.meta.seq ?? Infinity) < (host.meta.seq ?? Infinity)) host = e;
    }
    return host?.meta.peerId ?? null;
  }

  /** Elect/persist the host and tell the room when it changed. `exceptPeerId`
   * skips the peer that just joined — its welcome already carried the host. */
  private async electHost(exceptPeerId = ""): Promise<void> {
    const host = this.hostPeerId();
    const prev = await this.state.storage.get<string | null>("host");
    if (host === prev) return;
    if (host == null) await this.state.storage.put("host", null);
    else await this.state.storage.put("host", host);
    for (const { ws, meta } of this.realRoster()) {
      if (meta.peerId !== exceptPeerId) this.send(ws, { t: "host", peerId: host });
    }
  }

  /** Push the current roster summary to the discovery lobby (best effort). */
  private announceLobby(): Promise<void> {
    const ips: Record<string, number> = {};
    const names: string[] = [];
    for (const { meta } of this.realRoster()) {
      if (!meta.ip) continue; // identity-less join (invalid forwarded header)
      ips[meta.ip] = (ips[meta.ip] ?? 0) + 1;
      if (names.length < 8 && !names.includes(meta.name)) names.push(meta.name);
    }
    const lobby = this.env.LOBBY.get(this.env.LOBBY.idFromName(LOBBY_NAME));
    return lobby
      .fetch("https://lobby/announce", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roomId: this.roomId, ips, names } satisfies Announce),
      })
      .then(
        () => undefined,
        () => undefined,
      );
  }

  /** While the room has sockets, keep the lobby entry fresh via alarms. */
  private async scheduleHeartbeat() {
    const next = Date.now() + HEARTBEAT_MS;
    const current = await this.state.storage.getAlarm();
    if (current == null || current > next) await this.state.storage.setAlarm(next);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname !== "/ws" || req.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }

    const roomId = url.searchParams.get("room") ?? "";
    const peerId = url.searchParams.get("peer") ?? "";
    const name = (url.searchParams.get("name") || "peer").slice(0, 48);
    if (!RE_ROOM.test(roomId) || !RE_PEER.test(peerId)) {
      return new Response("invalid room or peer id", { status: 400 });
    }

    this.roomId = roomId;
    // unconditional: the drain-cleanup alarm wipes storage (NV-04), so every
    // admission rebuilds the row rather than trusting stale state
    await this.state.storage.put("roomId", roomId);

    // SEC-10: identity fails closed. An absent header is the internal
    // headerless dev fallback ("local"); a present-but-invalid value — an
    // arbitrary string or the 'local' marker itself — contributes no identity
    // and can therefore never become a matchable member address.
    const fwdIp = req.headers.get("CF-Connecting-IP");
    const ip = fwdIp == null ? "local" : isValidIp(fwdIp) ? fwdIp : "";
    const probe = url.searchParams.get("probe") === "1";

    // SEC-05: refuse joins beyond the room-size and per-address caps BEFORE
    // accepting any socket, so roster broadcasts stay within the caps. Probe
    // joins are exempt (bounded separately by the client probe cap).
    const members = this.realRoster();
    if (!probe && members.length >= MAX_ROOM_MEMBERS) {
      return new Response("room is full", { status: 429 });
    }
    if (!probe && members.filter((e) => e.meta.ip === ip).length >= MAX_MEMBERS_PER_ADDRESS) {
      return new Response("too many connections from this address", { status: 429 });
    }

    // SEC-08: a peer id is owned by whoever first claimed it. The ownership
    // token is minted at first admission, persisted in DO storage (it survives
    // hibernation/restart) and handed to the client in the welcome — a later
    // join presenting the same peer id evicts the incumbent only with the
    // matching token; without it the join is refused and the incumbent stays.
    // Probe joins never touch the token flow (existing early-return below).
    let token: string | undefined;
    if (!probe) {
      // SEC-11: a session the host removed cannot reclaim its peer id — the
      // tombstone outlives the socket and dies with the drained room
      if (await this.state.storage.get(`kicked:${peerId}`)) {
        return new Response("removed from this room", { status: 410 });
      }
      const stored = await this.state.storage.get<string>(`token:${peerId}`);
      if (stored == null) {
        token = crypto.randomUUID();
        await this.state.storage.put(`token:${peerId}`, token);
      } else if (url.searchParams.get("token")?.slice(0, 128) !== stored) {
        return new Response("peer id in use", { status: 409 });
      } else {
        token = stored;
      }
    }

    // SEC-11 room policy: the CREATOR (first real member) may open key-share
    // approvals to every member; otherwise the default host-only applies.
    // Later joins cannot change it — the param is only honored on an empty room.
    if (!probe && url.searchParams.get("ks") === "anyone" && this.realRoster().length === 0) {
      await this.state.storage.put("keyShare", "anyone");
    }
    const keyShare: KeySharePolicy =
      (await this.state.storage.get<KeySharePolicy>("keyShare")) ?? "host";

    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);
    // admission order lives in storage (survives reconnects and restarts);
    // the per-peer row is what makes a rejoining member keep host status
    let seq: number | undefined;
    if (!probe) {
      seq = (await this.state.storage.get<number>(`seq:${peerId}`)) ?? (await this.nextSeq());
      await this.state.storage.put(`seq:${peerId}`, seq);
    }
    pair[1].serializeAttachment({ peerId, name, ip, probe, token, seq } satisfies PeerMeta);

    if (probe) {
      // discovery verification: a room member opens a host-only WebRTC
      // connection to the prober; the room itself stays untouched
      const member = this.realRoster()[0];
      if (member) this.send(member.ws, { t: "probe-request", from: peerId });
      else this.send(pair[1], { t: "probe-empty" });
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    // A reconnecting peer replaces its old socket
    for (const { ws, meta } of this.roster()) {
      if (meta.peerId === peerId && ws !== pair[1]) {
        try {
          ws.close(4000, "replaced");
        } catch {
          /* already closing */
        }
      }
    }

    this.send(pair[1], {
      t: "welcome",
      you: peerId,
      token,
      host: this.hostPeerId() ?? undefined,
      ks: keyShare,
      peers: this.realRoster()
        .map((e) => e.meta)
        .filter((m) => m.peerId !== peerId)
        .map((m) => ({ peerId: m.peerId, name: m.name })),
      // On the edge there is no LAN to advertise; the request origin is the room endpoint
      addresses: [url.origin],
    });

    this.broadcast({ t: "peer-join", peerId, name }, peerId);
    await this.electHost(peerId);

    await this.announceLobby();
    await this.scheduleHeartbeat();

    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** admission counter — the room host is the lowest seq (SEC-11) */
  private async nextSeq(): Promise<number> {
    const next = ((await this.state.storage.get<number>("seq")) ?? 0) + 1;
    await this.state.storage.put("seq", next);
    return next;
  }

  /** SEC-12: refill-and-consume one signaling message slot for this socket.
   * A full bucket clears past violations, so a one-off legitimate burst never
   * accumulates toward the close threshold. */
  private allowSignaling(ws: WebSocket): boolean {
    let st = this.flood.get(ws);
    if (!st) {
      st = { tokens: FLOOD_BURST, last: Date.now(), violations: 0 };
      this.flood.set(ws, st);
    }
    const now = Date.now();
    st.tokens = Math.min(FLOOD_BURST, st.tokens + ((now - st.last) / 1000) * FLOOD_RATE);
    st.last = now;
    if (st.tokens >= FLOOD_BURST) st.violations = 0;
    if (st.tokens >= 1) {
      st.tokens -= 1;
      return true;
    }
    st.violations += 1;
    return st.violations <= FLOOD_MAX_VIOLATIONS;
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string" || message.length > 300_000) return;
    // the flood check runs before any parsing so abuse costs the least work
    if (!this.allowSignaling(ws)) {
      try {
        ws.close(4409, "flood");
      } catch {
        /* already closing */
      }
      return;
    }
    const msg = parseSignal(message);
    if (!msg) return;
    let meta: PeerMeta;
    try {
      meta = ws.deserializeAttachment() as PeerMeta;
    } catch {
      return;
    }
    if (!meta?.peerId) return;

    if (msg.t === "signal" && RE_PEER.test(msg.to)) {
      const target = this.roster().find((e) => e.meta.peerId === msg.to);
      if (target) {
        // NV-06 (validated: a browser dialed an attacker-supplied internal
        // candidate): internal-address candidates only flow between provably
        // co-network peers; everyone else's SDP gets them stripped at relay
        let data = msg.data;
        if (
          data &&
          typeof data === "object" &&
          typeof (data as { sdp?: unknown }).sdp === "string"
        ) {
          const { sdp, ...rest } = data as { sdp: string };
          data = { ...rest, sdp: sanitizeSdpCandidates(sdp, meta.ip, target.meta.ip) };
        }
        this.send(target.ws, { t: "signal", from: meta.peerId, data });
      }
    } else if (msg.t === "name") {
      meta.name = msg.name.slice(0, 48);
      ws.serializeAttachment(meta);
      this.broadcast({ t: "peer-name", peerId: meta.peerId, name: meta.name }, meta.peerId);
    } else if (msg.t === "leave") {
      try {
        ws.close(1000, "bye");
      } catch {
        /* already closing */
      }
    } else if (msg.t === "kick") {
      // SEC-11: only the room host may remove a member ("keep them out").
      // The check is server-side — a non-host client sending kick is a no-op.
      if (meta.peerId !== this.hostPeerId()) return;
      const target = this.realRoster().find((e) => e.meta.peerId === msg.peerId);
      if (!target || target.meta.peerId === meta.peerId) return;
      // the tombstone blocks the removed session from reclaiming its peer id
      // until the room drains; a brand-new session (fresh id) can still join —
      // the room key remains the real capability
      await this.state.storage.put(`kicked:${target.meta.peerId}`, Date.now());
      this.send(target.ws, { t: "kicked" });
      try {
        target.ws.close(4403, "kicked");
      } catch {
        /* already closing */
      }
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    let meta: PeerMeta;
    try {
      meta = ws.deserializeAttachment() as PeerMeta;
    } catch {
      return;
    }
    if (!meta?.peerId) return;
    if (meta.probe) {
      // a prober hitting an EMPTY room leaves no member behind to arm the
      // drain alarm — arm it here, or the admission's roomId row lingers in
      // SQLite forever (and any room id can spawn one via a probe request)
      if (!this.realRoster().length) await this.scheduleDrain();
      return;
    }
    this.flood.delete(ws);
    this.broadcast({ t: "peer-leave", peerId: meta.peerId }, meta.peerId);
    // the host may have left — re-elect and tell the room (SEC-11)
    await this.electHost();
    await this.announceLobby();
    // room drained: forget ownership tokens once the grace period passes
    if (!this.realRoster().length) await this.scheduleDrain();
  }

  /** reclaim the room's storage TOKEN_GRACE_MS after the roster empties */
  private async scheduleDrain(): Promise<void> {
    const next = Date.now() + TOKEN_GRACE_MS;
    const current = await this.state.storage.getAlarm();
    if (current == null || current > next) await this.state.storage.setAlarm(next);
  }

  async webSocketError(_ws: WebSocket): Promise<void> {
    /* the close handler does the cleanup */
  }

  async alarm(): Promise<void> {
    if (!this.roomId) this.roomId = (await this.state.storage.get("roomId")) ?? "";
    if (!this.roomId) return;
    if (!this.realRoster().length) {
      // the room drained TOKEN_GRACE_MS ago — reclaim the DO's storage
      // entirely (roomId + ownership tokens). A flood of bare joins mints
      // ~80 KB of permanent SQLite per room (NV-04: 27.61 MB measured on
      // staging from ~350 test rooms); this bounds every abandoned room to a
      // 60-second lifetime instead of forever. The in-memory roomId stays so
      // a rejoin re-seeds storage; tokens re-mint per SEC-08.
      await this.state.storage.deleteAll();
      return;
    }
    await this.announceLobby();
    // one-shot alarm: only re-arm while the room is still alive; the close
    // handler announces the empty roster which removes the lobby entry
    if (this.realRoster().length) await this.scheduleHeartbeat();
  }
}

/**
 * Discovery registry: every live Room heartbeats a roster summary (client IP
 * -> connection count and display names; no payloads, no room keys). Runs
 * entirely in memory — after a restart the next heartbeat repopulates it.
 */
export class Lobby {
  private readonly rooms = new Map<string, LobbyRoom>();

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/discover") {
      // SEC-10: the caller's identity is validated like the join path's —
      // an invalid external value matches nothing
      const fwd = req.headers.get("x-client-ip");
      const ip = fwd == null ? "local" : isValidIp(fwd) ? fwd : "";
      // SEC-07: non-provable matches return the room id only — member names,
      // counts and creation time are withheld (roster content remains
      // available to actual joiners via the welcome message after signaling)
      return Response.json({
        rooms: this.forIp(ip).map(({ provable, ...room }) =>
          provable ? room : { roomId: room.roomId },
        ),
      });
    }
    if (req.method === "POST" && url.pathname === "/announce") {
      const body = (await req.json().catch(() => null)) as Announce | null;
      if (!body || !RE_ROOM.test(body.roomId) || body.ips == null || typeof body.ips !== "object") {
        return new Response("invalid announce", { status: 400 });
      }
      const ips: Record<string, number> = {};
      for (const [ip, count] of Object.entries(body.ips)) {
        if (ip.length <= 45 && typeof count === "number" && Number.isFinite(count) && count > 0) {
          ips[ip] = Math.min(Math.floor(count), 64);
        }
      }
      const names = (Array.isArray(body.names) ? body.names : [])
        .filter((n): n is string => typeof n === "string")
        .map((n) => n.slice(0, 32))
        .slice(0, 8);
      if (!Object.keys(ips).length) {
        this.rooms.delete(body.roomId);
      } else {
        const now = Date.now();
        this.rooms.set(body.roomId, {
          ips,
          names,
          since: this.rooms.get(body.roomId)?.since ?? now,
          updatedAt: now,
        });
      }
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  }

  /**
   * Rooms whose roster includes a peer from the caller's network, with a flag
   * saying whether the IP relation PROVES a shared network (SEC-07). A match
   * is a candidate; only a provable relation may carry roster content —
   * the room id itself always accompanies a match so the client's host-only
   * probe can verify it for real.
   */
  private forIp(
    ip: string,
  ): { roomId: string; people: number; names: string[]; since: number; provable: boolean }[] {
    const now = Date.now();
    const out: {
      roomId: string;
      people: number;
      names: string[];
      since: number;
      provable: boolean;
    }[] = [];
    for (const [roomId, entry] of this.rooms) {
      if (now - entry.updatedAt > STALE_MS) {
        this.rooms.delete(roomId);
        continue;
      }
      if (!ip) continue;
      let match = false;
      let provable = false;
      for (const peer of Object.keys(entry.ips)) {
        if (!provable && provableLan(ip, peer)) {
          provable = true;
          match = true;
          break;
        }
        if (!match && sameLan(ip, peer)) match = true;
      }
      if (!match) continue;
      const people = Object.values(entry.ips).reduce((a, b) => a + b, 0);
      out.push({ roomId, people, names: entry.names, since: entry.since, provable });
    }
    out.sort((a, b) => b.since - a.since);
    return out;
  }
}

/**
 * NV-05 (validated: a foreign socket planted a discovery-visible room): only
 * the app itself may hold a signaling socket. Browsers always send an Origin
 * header on WS handshakes and the app dials its own host, so same-origin
 * covers every deployment (workers.dev, custom domain, LAN, localhost dev);
 * extra hosts ride ALLOWED_ORIGINS. Headerless/foreign-origin upgrades —
 * every cross-origin page and non-browser flooder — are refused before the
 * DO is reached. A hostile non-browser client can still fake the header;
 * that residual is inherent to header-based gates and documented.
 */
function originAllowed(req: Request, url: URL, env: Env): boolean {
  const origin = req.headers.get("Origin");
  if (!origin) return false;
  if (origin === url.origin) return true;
  return (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(origin);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname === "/ws") {
      if (!originAllowed(req, url, env)) {
        return new Response("origin not allowed", { status: 403 });
      }
      if (
        !(await allowRate(
          env.RATE_LIMITER_WS,
          `ws:${req.headers.get("CF-Connecting-IP") ?? "local"}`,
        ))
      ) {
        return new Response("too many requests", { status: 429 });
      }
      const room = url.searchParams.get("room") || "default";
      const id = env.ROOM.idFromName(room);
      return env.ROOM.get(id).fetch(req);
    }
    if (url.pathname === "/api/discover") {
      // polled every 5s by an open home page (12/min) — 30/min leaves headroom
      if (
        !(await allowRate(
          env.RATE_LIMITER_DISCOVER,
          `discover:${req.headers.get("CF-Connecting-IP") ?? "local"}`,
        ))
      ) {
        return new Response("too many requests", { status: 429 });
      }
      // the DO stub fetch drops the original client context, so the edge IP
      // travels in a private header — only /discover reads it
      const lobby = env.LOBBY.get(env.LOBBY.idFromName(LOBBY_NAME));
      // absence forwards as absence: only the deployment's own headerless
      // traffic maps to the internal 'local' fallback — a present-but-garbage
      // value travels verbatim and fails closed in the Lobby (SEC-10)
      const clientIp = req.headers.get("CF-Connecting-IP");
      const headers: HeadersInit = {};
      if (clientIp != null) headers["x-client-ip"] = clientIp;
      return lobby.fetch("https://lobby/discover", { headers });
    }
    // HTML navigations flow through here ("/" via run_worker_first, /r/:room
    // and any deep link as unmatched paths) so social previews are rewritten
    // for the serving origin — crawlers ignore relative og:image, and the
    // image URL carries a build hash that busts chat-app preview caches
    if (req.method === "GET") {
      const res = await env.ASSETS.fetch(req);
      if (!res.headers.get("content-type")?.includes("text/html")) return res;
      const room = RE_ROOM_PATH.exec(url.pathname)?.[1];
      return new Response(rewriteShareHtml(await res.text(), url.origin, room), {
        status: res.status,
        headers: {
          ...HTML_SECURITY_HEADERS,
          "content-type": "text/html; charset=utf-8",
          // revalidate every time: the shell changes on each deploy (security
          // headers, og rewrite) and per-room markup must never be served
          // stale — hashed assets stay immutable-cached, only HTML revalidates
          "cache-control": "public, no-cache",
        },
      });
    }
    return env.ASSETS.fetch(req);
  },
};
