import { useEffect, useRef, useState } from "react";
import type { PeerView, RoomState } from "../lib/p2p/room-client";
import { UsersIcon, XIcon } from "./Icons";

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

export function PeerList({
  state,
  onKick,
}: {
  state: RoomState;
  /** host-only: removes a member from the room (server enforces authority) */
  onKick?: (peerId: string) => void;
}) {
  const open = state.peers.filter((p) => p.status === "open").length;
  const isHost = (peerId: string) => state.hostId != null && peerId === state.hostId;
  const selfIsHost = state.hostId != null && state.selfId === state.hostId;
  // a kick is irreversible — the removed peer's id is barred from rejoining —
  // so the first tap only arms the button and the second one confirms
  const [armed, setArmed] = useState<string | null>(null);
  const armTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => clearTimeout(armTimer.current), []);
  const tapKick = (peerId: string) => {
    if (armed === peerId) {
      clearTimeout(armTimer.current);
      setArmed(null);
      onKick?.(peerId);
      return;
    }
    setArmed(peerId);
    clearTimeout(armTimer.current);
    armTimer.current = window.setTimeout(
      () => setArmed((cur) => (cur === peerId ? null : cur)),
      2600,
    );
  };
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
              {selfIsHost ? <em className="host-tag">host</em> : null}
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
              <span className="peer-name">
                {p.name}
                {isHost(p.peerId) ? <em className="host-tag">host</em> : null}
              </span>
              <span className="peer-meta">
                {p.status === "open" ? p.platform || "connected" : statusLabel(p.status)}
                {p.rtt != null && p.status === "open" ? ` · ${p.rtt} ms` : ""}
              </span>
            </span>
            {selfIsHost && onKick && !isHost(p.peerId) ? (
              <button
                type="button"
                className={`btn-icon peer-kick ${armed === p.peerId ? "is-armed" : ""}`}
                onClick={() => tapKick(p.peerId)}
                aria-label={
                  armed === p.peerId
                    ? `Confirm removing ${p.name}`
                    : `Remove ${p.name} from the room`
                }
                title={armed === p.peerId ? "Tap again to remove" : "Remove from room"}
              >
                <XIcon size={13} />
              </button>
            ) : (
              <span className={dotClass(p.status)} title={p.status} />
            )}
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
