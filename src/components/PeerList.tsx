import type { PeerView, RoomState } from "../lib/p2p/room-client";
import { UsersIcon } from "./Icons";

function dotClass(status: PeerView["status"]): string {
  switch (status) {
    case "open":
      return "dot dot-ok";
    case "connecting":
      return "dot dot-warn";
    default:
      return "dot dot-err";
  }
}

export function PeerList({ state }: { state: RoomState }) {
  const open = state.peers.filter((p) => p.status === "open").length;
  return (
    <aside className="peers panel">
      <div className="peers-head">
        <UsersIcon size={16} />
        <span>In this room</span>
        <span className="count-chip">{state.peers.length + 1}</span>
      </div>
      <ul className="peer-list">
        <li className="peer">
          <span className="avatar avatar-self">{initial(state.selfName)}</span>
          <span className="peer-info">
            <span className="peer-name">
              {state.selfName} <em className="you-tag">you</em>
            </span>
            <span className="peer-meta">
              {state.encrypted ? "end-to-end encrypted" : "dtls encrypted"}
            </span>
          </span>
          <span className="dot dot-ok" title="that's you" />
        </li>
        {state.peers.map((p) => (
          <li key={p.peerId} className="peer">
            <span className="avatar">{initial(p.name)}</span>
            <span className="peer-info">
              <span className="peer-name">{p.name}</span>
              <span className="peer-meta">
                {p.status === "open" ? p.platform || "connected" : statusLabel(p.status)}
                {p.rtt != null && p.status === "open" ? ` · ${p.rtt} ms` : ""}
              </span>
            </span>
            <span className={dotClass(p.status)} title={p.status} />
          </li>
        ))}
        {!state.peers.length && (
          <li className="peers-empty">
            {open === 0
              ? "Waiting for someone to open the invite link…"
              : "Share the invite link (or QR) with devices on the same network."}
          </li>
        )}
      </ul>
      {state.addresses.length > 0 && (
        <p className="peers-hint">
          LAN endpoint: <code>{state.addresses[0]}</code>
        </p>
      )}
    </aside>
  );
}

function initial(name: string): string {
  return (name || "?").trim().charAt(0).toUpperCase();
}

function statusLabel(s: PeerView["status"]): string {
  switch (s) {
    case "connecting":
      return "connecting…";
    case "closed":
      return "disconnected";
    case "failed":
      return "failed";
    default:
      return s;
  }
}
