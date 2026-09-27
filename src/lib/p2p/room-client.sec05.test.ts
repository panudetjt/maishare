// Ticket 06 / SECURITY-SPEC.md SEC-05 (client half) — the peers map refuses
// allocation beyond a small cap (roster entries beyond it stay inert: no
// connection, no channel, no offers), never-connecting peer contexts are
// evicted after a timeout with no remote description, and a failed connection
// state releases its context. Reconnect rebuilds honor the cap too.
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createRoomHarness,
  installRoomClientStubs,
  POLITE_PEER,
  type RoomHarness,
} from "./room-client.test-harness";
import { CONNECT_TIMEOUT_MS, MAX_PEERS } from "./room-client";

let restoreStubs: () => void;
let h: RoomHarness;

beforeEach(() => {
  restoreStubs = installRoomClientStubs();
  h = createRoomHarness();
});

afterEach(() => {
  vi.useRealTimers();
  h.dispose();
  restoreStubs();
});

function roster(n: number): { peerId: string; name: string }[] {
  return Array.from({ length: n }, (_, i) => ({
    peerId: `${POLITE_PEER}${String(i).padStart(3, "0")}`,
    name: `p${i}`,
  }));
}

describe("mesh fan-out caps (SEC-05)", () => {
  it("allocates exactly the cap for an oversized welcome roster; extras stay inert", async () => {
    await h.start();
    const before = 0; // no connections yet
    h.transport.deliver({
      t: "welcome",
      you: h.client.selfId,
      peers: roster(MAX_PEERS + 5),
      addresses: [],
    });
    await h.settle();

    expect(h.peerIds()).toHaveLength(MAX_PEERS);
    // exactly MAX_PEERS connection objects exist — extras got nothing
    expect(h.client.getSnapshot().peers.length).toBe(MAX_PEERS);
    expect(before).toBe(0);
  });

  it("ignores a peer-join beyond the cap (no connection, no toast)", async () => {
    await h.start();
    h.transport.deliver({
      t: "welcome",
      you: h.client.selfId,
      peers: roster(MAX_PEERS),
      addresses: [],
    });
    await h.settle();
    expect(h.peerIds()).toHaveLength(MAX_PEERS);
    const toastsBefore = h.client.getSnapshot().toasts.length;

    h.transport.deliver({ t: "peer-join", peerId: "extra-peer-9999", name: "extra" });
    await h.settle();
    expect(h.peerIds()).toHaveLength(MAX_PEERS);
    expect(h.client.getSnapshot().toasts.length).toBe(toastsBefore);
    // signals from the inert entry are ignored too
    h.transport.deliver({
      t: "signal",
      from: "extra-peer-9999",
      data: { type: "offer", sdp: "v=0" },
    });
    await h.flush();
    expect(
      h.transport.sent.filter(
        (m) => m.t === "signal" && (m as { to?: string }).to === "extra-peer-9999",
      ),
    ).toHaveLength(0);
  });

  it("evicts a peer still connecting past the timeout with no remote description", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearInterval", "setInterval", "performance"] });
    try {
      await h.client.start();
      const peer = h.addPeer(POLITE_PEER);
      await vi.advanceTimersByTimeAsync(60);
      expect(h.peerIds()).toContain(POLITE_PEER);

      // past the timeout with no SDP ever arriving: the phantom is released
      await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS + 6_000);
      expect(h.peerIds()).not.toContain(POLITE_PEER);
      expect(peer.pc.connectionState).toBe("closed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a peer whose negotiation is progressing (remote description arrived)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearInterval", "setInterval", "performance"] });
    try {
      await h.client.start();
      h.addPeer(POLITE_PEER);
      await vi.advanceTimersByTimeAsync(60);
      h.offer(POLITE_PEER);
      await vi.advanceTimersByTimeAsync(60);
      await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS + 6_000);
      expect(h.peerIds()).toContain(POLITE_PEER);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases the context when the connection fails (no failed-entry forever)", async () => {
    await h.start();
    const peer = h.addPeer(POLITE_PEER);
    await h.settle();

    // first failure triggers the ICE restart retry
    peer.pc.connectionState = "failed";
    peer.pc.onconnectionstatechange?.();
    await h.settle();
    expect(h.peerIds()).toContain(POLITE_PEER);

    // second failure releases the context entirely
    peer.pc.connectionState = "failed";
    peer.pc.onconnectionstatechange?.();
    await h.settle();
    expect(h.peerIds()).not.toContain(POLITE_PEER);
    expect(peer.pc.connectionState).toBe("closed");
  });

  it("reconnect rebuild honors the cap (wholesale rebuild never exceeds it)", async () => {
    await h.start();
    h.transport.deliver({ t: "welcome", you: h.client.selfId, peers: roster(4), addresses: [] });
    await h.settle();
    expect(h.peerIds()).toHaveLength(4);

    h.transport.setStatus("offline");
    h.transport.setStatus("online");
    h.transport.deliver({
      t: "welcome",
      you: h.client.selfId,
      peers: roster(MAX_PEERS + 3),
      addresses: [],
    });
    await h.settle();
    expect(h.peerIds()).toHaveLength(MAX_PEERS);
  });
});
