// maishare signaling worker (TypeScript): static SPA assets + WebSocket
// signaling via the Room Durable Object (one instance per room id).
// Payloads stay P2P — the DO only relays WebRTC handshakes (SDP/ICE).
// The Lobby DO powers LAN room discovery: rooms heartbeat a roster summary
// (IP -> connection count + display names), and /api/discover lists only the
// rooms reachable from the caller's own network. Raw IPs never leave the DOs.

import { sameLan } from "./lan";
import { rewriteShareHtml } from "./share-html";

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

/** 1-day supply-chain policy: only versions older than the window resolve */
interface PeerMeta {
  peerId: string;
  name: string;
  /** client IP as seen by the edge (used for LAN discovery matching) */
  ip: string;
  /** discovery probers ride the room's relay but are invisible to the room */
  probe?: boolean;
}

/** shape of messages peers send over the signaling channel */
type SignalMessage =
  | { t: "signal"; to: string; data: unknown }
  | { t: "name"; name: string }
  | { t: "leave" };

interface Env {
  /** one Durable Object instance per room id */
  ROOM: DurableObjectNamespace;
  /** discovery registry (single global instance) */
  LOBBY: DurableObjectNamespace;
  /** the SPA build output (wired by @cloudflare/vite-plugin) */
  ASSETS: Fetcher;
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

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    // Keep idle hibernating sockets alive through load-balancer pings.
    // Optional: pings then simply wake the DO instead. Runtimes disagree on
    // the method name (autoResponse vs autoResponsePair) — support both.
    const pair = new WebSocketRequestResponsePair("ping", "pong");
    const api = state as unknown as {
      setWebSocketAutoResponse?: (p: WebSocketRequestResponsePair) => void;
      setWebSocketAutoResponsePair?: (p: WebSocketRequestResponsePair) => void;
    };
    try {
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

  /** Push the current roster summary to the discovery lobby (best effort). */
  private announceLobby(): Promise<void> {
    const ips: Record<string, number> = {};
    const names: string[] = [];
    for (const { meta } of this.realRoster()) {
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

    if (this.roomId !== roomId) {
      this.roomId = roomId;
      await this.state.storage.put("roomId", roomId);
    }

    const ip = req.headers.get("CF-Connecting-IP") || "local";
    const probe = url.searchParams.get("probe") === "1";
    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ peerId, name, ip, probe } satisfies PeerMeta);

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
      peers: this.realRoster()
        .map((e) => e.meta)
        .filter((m) => m.peerId !== peerId)
        .map((m) => ({ peerId: m.peerId, name: m.name })),
      // On the edge there is no LAN to advertise; the request origin is the room endpoint
      addresses: [url.origin],
    });

    this.broadcast({ t: "peer-join", peerId, name }, peerId);

    await this.announceLobby();
    await this.scheduleHeartbeat();

    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string" || message.length > 300_000) return;
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
      if (target) this.send(target.ws, { t: "signal", from: meta.peerId, data: msg.data });
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
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    let meta: PeerMeta;
    try {
      meta = ws.deserializeAttachment() as PeerMeta;
    } catch {
      return;
    }
    if (!meta?.peerId || meta.probe) return;
    this.broadcast({ t: "peer-leave", peerId: meta.peerId }, meta.peerId);
    await this.announceLobby();
  }

  async webSocketError(_ws: WebSocket): Promise<void> {
    /* the close handler does the cleanup */
  }

  async alarm(): Promise<void> {
    if (!this.roomId) this.roomId = (await this.state.storage.get("roomId")) ?? "";
    if (!this.roomId) return;
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
      const ip = req.headers.get("x-client-ip") ?? "";
      return Response.json({ rooms: this.forIp(ip) });
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

  /** Rooms whose roster includes a peer from the caller's network. */
  private forIp(ip: string): { roomId: string; people: number; names: string[]; since: number }[] {
    const now = Date.now();
    const out: { roomId: string; people: number; names: string[]; since: number }[] = [];
    for (const [roomId, entry] of this.rooms) {
      if (now - entry.updatedAt > STALE_MS) {
        this.rooms.delete(roomId);
        continue;
      }
      if (!ip) continue;
      let match = false;
      for (const peer of Object.keys(entry.ips)) {
        if (sameLan(ip, peer)) {
          match = true;
          break;
        }
      }
      if (!match) continue;
      const people = Object.values(entry.ips).reduce((a, b) => a + b, 0);
      out.push({ roomId, people, names: entry.names, since: entry.since });
    }
    out.sort((a, b) => b.since - a.since);
    return out;
  }
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
      const room = url.searchParams.get("room") || "default";
      const id = env.ROOM.idFromName(room);
      return env.ROOM.get(id).fetch(req);
    }
    if (url.pathname === "/api/discover") {
      // the DO stub fetch drops the original client context, so the edge IP
      // travels in a private header — only /discover reads it
      const lobby = env.LOBBY.get(env.LOBBY.idFromName(LOBBY_NAME));
      return lobby.fetch("https://lobby/discover", {
        headers: { "x-client-ip": req.headers.get("CF-Connecting-IP") ?? "" },
      });
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
          "content-type": "text/html; charset=utf-8",
          // rewritten per room — short TTL so previews refresh, and caching
          // can never serve one room's markup under another room's URL
          "cache-control": res.headers.get("cache-control") ?? "public, max-age=300",
        },
      });
    }
    return env.ASSETS.fetch(req);
  },
};
