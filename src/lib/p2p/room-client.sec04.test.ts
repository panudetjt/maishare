// Ticket 05 / SECURITY-SPEC.md SEC-04 — the receiver's transfer list is always
// boundable: concurrent in-flight inbound transfers per peer are capped with
// explicit file-cancel backpressure, a superseding file-start settles the
// previous transfer as cancelled (never orphaned 'active'), an inactivity
// watchdog riding the per-peer ping interval fails stalled transfers, and the
// bulk Clear retires stale actives and revokes dropped entries' object URLs.
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { concatFrame, encoder, FRAME, type Control } from "./protocol";
import {
  createRoomHarness,
  decodeFrame,
  installRoomClientStubs,
  IMPOLITE_PEER,
  revokedObjectUrls,
  type FakeDataChannel,
  type RoomHarness,
} from "./room-client.test-harness";
import { DONE_TAIL_GRACE_MS, INCOMING_STALE_MS, PING_EVERY } from "./room-client";

let restoreStubs: () => void;
let h: RoomHarness;

const FAKED = [
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "setImmediate",
  "clearImmediate",
  "Date",
  "performance",
] as const;

beforeEach(() => {
  restoreStubs = installRoomClientStubs();
  h = createRoomHarness();
});

afterEach(() => {
  vi.useRealTimers();
  h.dispose();
  restoreStubs();
});

function fileStart(
  id: string,
  size = 1024,
  name = "flood.bin",
  mime = "application/octet-stream",
): Uint8Array {
  const c: Control = { t: "file-start", id, name, size, mime, g: "g" };
  return concatFrame(FRAME.CONTROL, encoder.encode(JSON.stringify(c)));
}

function chunk(n: number): Uint8Array {
  return concatFrame(FRAME.CHUNK, new Uint8Array(n).fill(1));
}

function fileEnd(id: string): Uint8Array {
  const c: Control = { t: "file-end", id };
  return concatFrame(FRAME.CONTROL, encoder.encode(JSON.stringify(c)));
}

function outboundControls(ch: FakeDataChannel): (Control & { id?: string; reason?: string })[] {
  return ch.sent
    .filter((f) => f[0] === FRAME.CONTROL)
    .map((f) => JSON.parse(decodeFrame(f).body) as Control & { id?: string; reason?: string });
}

function inboundViews(): { id: string; status: string }[] {
  return h.client
    .getSnapshot()
    .transfers.filter((t) => t.dir === "in")
    .map((t) => ({ id: t.id, status: t.status }));
}

describe("transfer-list caps, supersede settle, stale sweep (SEC-04)", () => {
  it("caps concurrent in-flight inbound transfers with file-cancel backpressure", async () => {
    await h.start();
    const peer = h.addPeer(IMPOLITE_PEER);
    const ch = h.openChannel(peer);
    await h.flush();

    // a bare file-start flood: only the first header ever creates a view
    for (let i = 0; i < 20; i++) ch.receive(fileStart(`flood-${i}`));
    await h.settle();

    const views = inboundViews();
    expect(views.length).toBeLessThanOrEqual(2); // bounded — no entry per frame
    expect(views.filter((v) => v.status === "active").length).toBeLessThanOrEqual(1);
    // every refused header drew explicit backpressure
    const cancels = outboundControls(ch);
    expect(cancels.filter((c) => c.t === "file-cancel").length).toBeGreaterThanOrEqual(19);
  });

  it("settles a superseded transfer as cancelled; a late file-end changes nothing", async () => {
    await h.start();
    const peer = h.addPeer(IMPOLITE_PEER);
    const ch = h.openChannel(peer);
    await h.flush();

    ch.receive(fileStart("first"));
    await h.settle();
    expect(inboundViews()).toEqual([{ id: "first", status: "active" }]);

    // a second header while the first is in flight: the previous settles as
    // cancelled and the excess header is refused without a list entry
    ch.receive(fileStart("second"));
    await h.settle();
    expect(inboundViews()).toEqual([{ id: "first", status: "cancelled" }]);
    const cancels = outboundControls(ch).filter((c) => c.t === "file-cancel");
    expect(cancels.some((c) => c.id === "first" && c.reason === "superseded")).toBe(true);
    expect(cancels.some((c) => c.id === "second" && c.reason === "busy")).toBe(true);

    // a late file-end for the settled id changes nothing
    ch.receive(fileEnd("first"));
    await h.settle();
    expect(inboundViews()).toEqual([{ id: "first", status: "cancelled" }]);
  });

  it("fails a stalled 'active' inbound transfer after the inactivity timeout", async () => {
    vi.useFakeTimers({ toFake: [...FAKED] });
    try {
      await h.client.start();
      const peer = h.addPeer(IMPOLITE_PEER);
      const ch = h.openChannel(peer);
      await vi.advanceTimersByTimeAsync(60);

      ch.receive(fileStart("stalled"));
      ch.receive(chunk(16)); // one chunk, then silence
      await vi.advanceTimersByTimeAsync(60);
      expect(inboundViews()[0].status).toBe("active");

      // ping-interval sweeps run while progress is fresh: no spurious fail
      await vi.advanceTimersByTimeAsync(PING_EVERY * 2);
      expect(inboundViews()[0].status).toBe("active");

      // past the stale window the watchdog fails the transfer
      await vi.advanceTimersByTimeAsync(PING_EVERY * 9);
      expect(inboundViews()[0].status).toBe("error");
      // the incoming context is gone: further chunks hit the orphan path
      ch.receive(chunk(8));
      await vi.advanceTimersByTimeAsync(60);
      expect(
        h.client
          .getSnapshot()
          .chats.filter((c) => c.system && c.text.includes("without its transfer header")),
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a completed transfer's late tail silent — no false orphan alarm", async () => {
    vi.useFakeTimers({ toFake: [...FAKED] });
    try {
      await h.client.start();
      const peer = h.addPeer(IMPOLITE_PEER);
      const ch = h.openChannel(peer);
      await vi.advanceTimersByTimeAsync(60);

      // finish a transfer cleanly: header → chunk → file-end
      ch.receive(fileStart("late", 8));
      ch.receive(chunk(8));
      await vi.advanceTimersByTimeAsync(60);
      ch.receive(fileEnd("late"));
      await vi.advanceTimersByTimeAsync(60);
      expect(inboundViews()[0]).toMatchObject({ id: "late", status: "done" });

      // a tail chunk right after completion: the file is already whole, so
      // the "ask the sender to resend" alarm would be false
      ch.receive(chunk(8));
      await vi.advanceTimersByTimeAsync(60);
      expect(
        h.client
          .getSnapshot()
          .chats.filter((c) => c.system && c.text.includes("without its transfer header")),
      ).toHaveLength(0);

      // past the grace window a header-less stream still trips the alarm once
      await vi.advanceTimersByTimeAsync(DONE_TAIL_GRACE_MS + 1000);
      ch.receive(chunk(8));
      await vi.advanceTimersByTimeAsync(60);
      expect(
        h.client
          .getSnapshot()
          .chats.filter((c) => c.system && c.text.includes("without its transfer header")),
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fail a transfer under active progress (fix-safety)", async () => {
    vi.useFakeTimers({ toFake: [...FAKED] });
    try {
      await h.client.start();
      const peer = h.addPeer(IMPOLITE_PEER);
      const ch = h.openChannel(peer);
      await vi.advanceTimersByTimeAsync(60);

      ch.receive(fileStart("busy", 240));
      await vi.advanceTimersByTimeAsync(60);
      for (let i = 0; i < 30; i++) {
        ch.receive(chunk(8));
        await vi.advanceTimersByTimeAsync(PING_EVERY * 1.5); // sweep between chunks
      }
      ch.receive(fileEnd("busy"));
      await vi.advanceTimersByTimeAsync(60);
      expect(inboundViews()[0]).toMatchObject({ id: "busy", status: "done" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("sequential multi-file transfers behave exactly as before (fix-safety)", async () => {
    await h.start();
    const peer = h.addPeer(IMPOLITE_PEER);
    const ch = h.openChannel(peer);
    await h.flush();

    // file-end precedes each next start — no overlap, no cooldown
    for (const id of ["a", "b", "c"]) {
      ch.receive(fileStart(id, 8, `${id}.bin`));
      ch.receive(chunk(8));
      ch.receive(fileEnd(id));
    }
    await h.settle();

    const byId = new Map(inboundViews().map((v) => [v.id, v.status]));
    expect(byId.get("a")).toBe("done");
    expect(byId.get("b")).toBe("done");
    expect(byId.get("c")).toBe("done");
    expect(outboundControls(ch).some((c) => c.t === "file-cancel")).toBe(false);
  });

  it("Clear retires stale actives and revokes dropped entries' object URLs", async () => {
    vi.useFakeTimers({ toFake: [...FAKED] });
    try {
      await h.client.start();
      const peer = h.addPeer(IMPOLITE_PEER);
      const ch = h.openChannel(peer);
      await vi.advanceTimersByTimeAsync(60);

      // a completed inbound image (holds a blob URL) and a stale active
      ch.receive(fileStart("done-one", 8, "pic.png", "image/png"));
      ch.receive(chunk(8));
      ch.receive(fileEnd("done-one"));
      await vi.advanceTimersByTimeAsync(60);
      ch.receive(fileStart("stale-one"));
      ch.receive(chunk(8));
      await vi.advanceTimersByTimeAsync(60);
      await vi.advanceTimersByTimeAsync(INCOMING_STALE_MS + PING_EVERY);
      expect(inboundViews().find((v) => v.id === "stale-one")?.status).toBe("error");

      const urlFor = (id: string) =>
        h.client.getSnapshot().transfers.find((t) => t.id === id)?.blobUrl;
      const doneUrl = urlFor("done-one");
      expect(doneUrl).toBeTruthy();

      h.client.clearFinishedTransfers();
      await vi.advanceTimersByTimeAsync(60);
      // Clear retires the stale active (removing it) and releases the
      // completed entry's blob URL — the list it leaves behind is bounded
      expect(inboundViews()).toHaveLength(0);
      expect(revokedObjectUrls).toContain(doneUrl);
      // the stale transfer's sender was told (file-cancel backpressure)
      const cancels = outboundControls(ch).filter((c) => c.t === "file-cancel");
      expect(cancels.some((c) => c.id === "stale-one" && c.reason === "stalled")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds plaintext file-start floods from a wrong-key peer identically", async () => {
    const restore = installRoomClientStubs();
    try {
      const keyed = createRoomHarness({ key: "keyed flood room" });
      await keyed.start();
      const peer = keyed.addPeer(IMPOLITE_PEER);
      const ch = keyed.openChannel(peer);
      await keyed.flush();

      for (let i = 0; i < 15; i++) ch.receive(fileStart(`pf-${i}`));
      await keyed.settle();

      const views = keyed.client.getSnapshot().transfers.filter((t) => t.dir === "in");
      expect(views.length).toBeLessThanOrEqual(2);
      expect(views.filter((v) => v.status === "active").length).toBeLessThanOrEqual(1);
      const cancels = ch.sent
        .filter((f) => f[0] === FRAME.CONTROL)
        .map((f) => JSON.parse(decodeFrame(f).body) as Control)
        .filter((c) => c.t === "file-cancel");
      expect(cancels.length).toBeGreaterThanOrEqual(14);
      keyed.dispose();
    } finally {
      restore();
    }
  });
});
