import { useEffect, useRef, useState } from "react";
import { LanProbe } from "./p2p/lan-probe";
import { Signaling } from "./p2p/signaling";
import { uuid } from "./device";
import {
  freshProbeState,
  mayProbe,
  onProbeResult,
  roomIdentity,
  syncProbeIdentity,
  type ProbeBackoffState,
} from "./lan-probe-backoff";

export interface LanRoom {
  roomId: string;
  /** roster content is withheld (absent) unless the IP relation provably
   * implies a shared network — SEC-07 id-only candidates carry just the id */
  people?: number;
  names?: string[];
  since?: number;
}

export type DiscoveryStatus = "loading" | "live" | "offline";

/** concurrent host-only probes a single home page will run */
const MAX_PROBES = 3;

/**
 * One-shot LAN verification: connects to a room as an invisible prober and
 * opens a host-only (no STUN/TURN) WebRTC channel with a member. Success is
 * proof of shared LAN — an IP match alone can be a CGNAT false positive,
 * a host-to-host connection cannot.
 */
function verifyRoom(roomId: string, timeoutMs = 8000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    let target = "";

    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      probe.close();
      sig.close();
      resolve(ok);
    };

    const probe = new LanProbe({
      initiator: false,
      onSignal: (data) => {
        if (target) sig.send({ t: "signal", to: target, data });
      },
      onConnected: () => finish(true),
    });

    const sig = new Signaling({
      roomId,
      peerId: `probe-${uuid()}`,
      name: "discoverer",
      probe: true,
    });
    sig.bind({
      onStatus: () => {},
      onMessage: (m) => {
        if (m.t === "signal") {
          target = m.from;
          void probe.onSignal(m.data);
        } else if (m.t === "probe-empty") {
          finish(false);
        }
      },
    });

    timer = setTimeout(() => finish(false), timeoutMs);
    sig.connect();
  });
}

/**
 * Polls the worker for candidate rooms on the caller's network (a cheap IP
 * pre-filter) and shows only the ones that pass a host-only WebRTC probe.
 * The server never leaks other networks' rooms or raw IPs.
 */
export function useLanRooms(pollMs = 5000): { rooms: LanRoom[]; status: DiscoveryStatus } {
  const [rooms, setRooms] = useState<LanRoom[]>([]);
  const [status, setStatus] = useState<DiscoveryStatus>("loading");
  const inFlight = useRef(new Set<string>());
  const verifiedAt = useRef(new Map<string, number>());
  /** per-room probe backoff (see lan-probe-backoff.ts) — a failing room is
   * re-probed on a ladder instead of every tick, then goes dormant until its
   * roster changes; without this a single stale tab floods the signaling DO */
  const probeState = useRef(new Map<string, ProbeBackoffState>());
  const candidates = useRef<LanRoom[]>([]);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;

    const publish = () => {
      if (!alive.current) return;
      setRooms(candidates.current.filter((c) => verifiedAt.current.has(c.roomId)));
    };

    const tick = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const res = await fetch("/api/discover", { cache: "no-store" });
        if (!res.ok) throw new Error(`discover ${res.status}`);
        const data = (await res.json()) as { rooms?: LanRoom[] };
        if (!alive.current) return;
        candidates.current = Array.isArray(data.rooms) ? data.rooms : [];
        setStatus("live");
      } catch {
        if (alive.current) setStatus("offline");
        return;
      }

      const now = Date.now();
      for (const c of candidates.current) {
        if (inFlight.current.size >= MAX_PROBES) break;
        if (inFlight.current.has(c.roomId)) continue;
        const identity = roomIdentity(c.people, c.names);
        let st = probeState.current.get(c.roomId);
        if (!st) {
          st = freshProbeState(identity);
          probeState.current.set(c.roomId, st);
        } else {
          probeState.current.set(c.roomId, syncProbeIdentity(st, identity));
          st = probeState.current.get(c.roomId)!;
        }
        if (!mayProbe(st, verifiedAt.current.get(c.roomId) ?? 0, now)) continue;
        inFlight.current.add(c.roomId);
        void verifyRoom(c.roomId).then((ok) => {
          inFlight.current.delete(c.roomId);
          const cur = probeState.current.get(c.roomId);
          if (cur) onProbeResult(cur, ok, Date.now());
          if (ok) verifiedAt.current.set(c.roomId, Date.now());
          else verifiedAt.current.delete(c.roomId);
          publish();
        });
      }
      // rooms that left the discovery list take their backoff state with them
      const advertised = new Set(candidates.current.map((c) => c.roomId));
      for (const roomId of probeState.current.keys()) {
        if (!advertised.has(roomId)) probeState.current.delete(roomId);
      }
      publish();
    };

    void tick();
    const timer = setInterval(() => void tick(), pollMs);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [pollMs]);

  return { rooms, status };
}
