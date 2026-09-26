import { useState } from "react";
import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { z } from "zod";
import { loadName, makeRoomCode, makeRoomKey, saveName } from "../lib/device";
import { useLanRooms } from "../lib/discovery";
import { clearRecents, loadRecents, type Recent } from "../lib/recents";
import { Bolt, Logo, QrIcon, TrashIcon, UsersIcon, WifiIcon } from "../components/Icons";
import { NearbyShare } from "../components/NearbyShare";

const indexSearchSchema = z.object({
  name: z.string().trim().max(32).optional().catch(undefined),
});

export const Route = createFileRoute("/")({
  validateSearch: (input) => indexSearchSchema.parse(input),
  loader: () => ({
    recents: loadRecents(),
    webrtc: typeof RTCPeerConnection !== "undefined" && typeof WebSocket !== "undefined",
    isSecure: window.isSecureContext,
  }),
  pendingComponent: HomePending,
  component: HomeComponent,
});

function HomeComponent() {
  const search = Route.useSearch();
  const { recents: initialRecents, webrtc, isSecure } = Route.useLoaderData();
  const navigate = useNavigate({ from: Route.fullPath });
  const [name, setName] = useState(search.name ?? loadName());
  const [joinValue, setJoinValue] = useState("");
  const [recents, setRecents] = useState<Recent[]>(initialRecents);
  const [nearbyOpen, setNearbyOpen] = useState(false);

  function commitName(v: string) {
    const n = v.trim().slice(0, 32);
    if (!n) return;
    saveName(n);
    void navigate({ search: (prev) => ({ ...prev, name: n }), replace: true });
  }

  function startRoom() {
    void navigate({
      to: "/r/$roomId",
      params: { roomId: makeRoomCode() },
      search: { k: makeRoomKey(), name, tab: "chat" },
    });
  }

  function parseInvite(v: string): { roomId: string; k?: string } | null {
    const s = v.trim();
    if (!s) return null;
    if (/^https?:\/\//i.test(s)) {
      try {
        const u = new URL(s);
        const m = u.pathname.match(/\/r\/([\w-]{2,64})/i);
        if (m) return { roomId: m[1], k: u.searchParams.get("k") ?? undefined };
        return null;
      } catch {
        return null;
      }
    }
    if (/^[\w-]{2,64}$/.test(s)) return { roomId: s.toLowerCase() };
    const m = s.match(/\/r\/([\w-]{2,64})/i);
    return m ? { roomId: m[1] } : null;
  }

  function joinRoom() {
    const parsed = parseInvite(joinValue);
    if (!parsed) {
      setJoinValue("");
      return;
    }
    void navigate({
      to: "/r/$roomId",
      params: { roomId: parsed.roomId },
      search: { ...(parsed.k ? { k: parsed.k } : {}), name, tab: "chat" },
    });
  }

  return (
    <div className="page home">
      <header className="home-hero">
        <div className="brand">
          <Logo size={30} />
          <span className="brand-name">maishare</span>
        </div>
        <p className="tagline">
          Local-first, <strong>peer-to-peer</strong> sharing for files, clipboard, text and pastes.
          <br />
          No cloud. No accounts. Data never leaves your network.
        </p>
      </header>

      <div className="home-grid">
        <section className="panel home-card">
          <h2>Start sharing</h2>
          <p className="muted">Creates a room with an end-to-end key baked into the invite link.</p>
          <label className="field">
            <span>Your name</span>
            <input
              value={name}
              maxLength={32}
              onChange={(e) => setName(e.target.value)}
              onBlur={(e) => commitName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && commitName(e.currentTarget.value)}
              aria-label="Your display name"
            />
          </label>
          <button className="btn btn-primary btn-lg" onClick={startRoom} disabled={!webrtc}>
            <Bolt size={17} /> Create a room
          </button>
          {!webrtc && <p className="notice">This browser doesn’t support WebRTC.</p>}
        </section>

        <section className="panel home-card">
          <h2>Join a room</h2>
          <p className="muted">Paste an invite link, or type the room code.</p>
          <form
            className="join-form"
            onSubmit={(e) => {
              e.preventDefault();
              joinRoom();
            }}
          >
            <input
              value={joinValue}
              onChange={(e) => setJoinValue(e.target.value)}
              placeholder="e.g. k7m2xq or http://192.168.1.20:8787/r/k7m2xq?k=…"
              aria-label="Room code or invite link"
            />
            <button type="submit" className="btn" disabled={!joinValue.trim()}>
              Join
            </button>
          </form>
          {recents.length > 0 ? (
            <div className="recents">
              <div className="recents-head">
                <span className="muted small">Recent rooms</span>
                <button
                  className="btn-icon"
                  aria-label="Clear recent rooms"
                  title="Clear recents"
                  onClick={() => {
                    clearRecents();
                    setRecents([]);
                  }}
                >
                  <TrashIcon size={14} />
                </button>
              </div>
              <ul className="recent-list">
                {recents.map((r) => (
                  <li key={r.roomId}>
                    <Link
                      to="/r/$roomId"
                      params={{ roomId: r.roomId }}
                      search={{ ...(r.k ? { k: r.k } : {}), tab: "chat" }}
                      className="recent-chip"
                    >
                      <QrIcon size={14} />
                      <code>{r.roomId}</code>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {!isSecure && (
            <p className="notice">
              Open over <code>localhost</code> or HTTPS for full clipboard access — pasting works
              anywhere.
            </p>
          )}
        </section>

        <section className={`panel home-card nearby-home ${nearbyOpen ? "nearby-open" : ""}`}>
          <h2>Nearby share</h2>
          <p className="muted">
            Send files straight to another device on the same Wi-Fi via a QR handshake — no room, no
            server, works offline.
          </p>
          {nearbyOpen ? (
            <NearbyShare onClose={() => setNearbyOpen(false)} />
          ) : (
            <button className="btn btn-lg" onClick={() => setNearbyOpen(true)}>
              <WifiIcon size={16} /> Start nearby share
            </button>
          )}
        </section>
      </div>

      <LanRooms />

      <footer className="home-foot muted">
        Transfers run over WebRTC data channels — direct device-to-device. The tiny signaling server
        only introduces peers and never touches your bytes.
      </footer>
    </div>
  );
}

/** Rooms currently open by devices on the same network, refreshed live. */
function LanRooms() {
  const { rooms, status } = useLanRooms();
  return (
    <section className="panel lan-panel">
      <div className="lan-head">
        <h2>
          <WifiIcon size={17} /> On your network
        </h2>
        <span
          className={`dot ${status === "offline" ? "dot-err" : status === "live" ? "dot-ok" : "dot-warn"}`}
          aria-hidden="true"
        />
        <span className="muted small">
          {status === "offline"
            ? "discovery offline"
            : status === "live"
              ? "live — each room verified over a direct connection"
              : "looking…"}
        </span>
      </div>
      {rooms.length === 0 ? (
        <p className="muted lan-empty">
          {status === "offline"
            ? "Room discovery is unavailable right now."
            : "No verified rooms on this network yet. Create one — devices on the same Wi-Fi will see it here."}
        </p>
      ) : (
        <ul className="lan-list">
          {rooms.map((r) => {
            const shown = r.names.slice(0, 3).join(", ");
            return (
              <li key={r.roomId}>
                <Link
                  className="lan-room"
                  to="/r/$roomId"
                  params={{ roomId: r.roomId }}
                  search={{ tab: "chat" }}
                >
                  <code>{r.roomId}</code>
                  <span className="lan-meta muted small">
                    <UsersIcon size={13} />
                    {r.people} online{shown ? ` · ${shown}` : ""}
                    {r.people > 3 ? "…" : ""}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function HomePending() {
  return (
    <div className="page home">
      <div className="skeleton skeleton-hero" />
      <div className="home-grid">
        <div className="skeleton skeleton-card" />
        <div className="skeleton skeleton-card" />
      </div>
    </div>
  );
}
