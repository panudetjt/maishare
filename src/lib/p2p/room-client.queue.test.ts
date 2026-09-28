// Multi-file queue visibility: the sender announces every queued file with a
// file-queued frame the moment it is queued (before any byte moves), so the
// receiver renders the whole queue up front and never mistakes the first
// finished file for the end of the transfer. Previews are informational —
// validated like file-start claims (SEC-02), capped per peer, swept when
// their file-start never comes, and retractable from both ends.
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { RoomCipher } from "./crypto";
import { concatFrame, decoder, encoder, FRAME, type Control } from "./protocol";
import {
  createRoomHarness,
  decodeFrame,
  installRoomClientStubs,
  IMPOLITE_PEER,
  type FakeDataChannel,
  type RoomHarness,
} from "./room-client.test-harness";
import { MAX_QUEUED_INCOMING_PER_PEER, PING_EVERY, QUEUED_STALE_MS } from "./room-client";
import { MAX_STREAMABLE_SIZE } from "./spill";

let restoreStubs: () => void;
let h: RoomHarness;
let victimCipher: RoomCipher; // the harness's own key — decodes what it sealed

const ROOM_KEY = "queue announce room key";

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

function fileQueued(
  id: string,
  size = 8,
  name = "q.bin",
  mime = "application/octet-stream",
  g = "g",
): Uint8Array {
  const c: Control = { t: "file-queued", id, name, size, mime, g };
  return concatFrame(FRAME.CONTROL, encoder.encode(JSON.stringify(c)));
}

function fileStart(
  id: string,
  size = 8,
  name = "q.bin",
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

function fileCancel(id: string, reason = "user"): Uint8Array {
  const c: Control = { t: "file-cancel", id, reason };
  return concatFrame(FRAME.CONTROL, encoder.encode(JSON.stringify(c)));
}

function outboundControls(ch: FakeDataChannel): (Control & { id?: string; reason?: string })[] {
  return ch.sent
    .filter((f) => f[0] === FRAME.CONTROL)
    .map((f) => JSON.parse(decodeFrame(f).body) as Control & { id?: string; reason?: string });
}

function inboundViews(): { id: string; status: string; name: string }[] {
  return h.client
    .getSnapshot()
    .transfers.filter((t) => t.dir === "in")
    .map((t) => ({ id: t.id, status: t.status, name: t.name }));
}

function file(name: string, bytes = 16): File {
  return new File([new Uint8Array(bytes).fill(7)], name, { type: "application/octet-stream" });
}

describe("sender queue announce", () => {
  it("announces every file of a message before any transfer starts", async () => {
    await h.start();
    const peer = h.addPeer(IMPOLITE_PEER);
    const ch = h.openChannel(peer);
    await h.flush();

    h.client.sendFiles([file("one.bin"), file("two.bin"), file("three.bin")]);
    await h.settle();

    const controls = outboundControls(ch);
    const announceNames: string[] = [];
    const announceIndexes: number[] = [];
    controls.forEach((c, i) => {
      if (c.t === "file-queued") {
        announceNames.push(c.name);
        announceIndexes.push(i);
      }
    });
    expect(announceNames).toEqual(["one.bin", "two.bin", "three.bin"]);
    const firstStart = controls.findIndex((c) => c.t === "file-start");
    expect(firstStart).toBeGreaterThanOrEqual(0);
    // the whole queue is on the wire before the first byte moves
    expect(announceIndexes.every((i) => i < firstStart)).toBe(true);
  });

  it("seals the announce in keyed rooms like every other payload frame", async () => {
    const restore = installRoomClientStubs();
    try {
      const keyed = createRoomHarness({ key: ROOM_KEY });
      victimCipher = await RoomCipher.fromKey(ROOM_KEY);
      await keyed.start();
      const peer = keyed.addPeer(IMPOLITE_PEER);
      const ch = keyed.openChannel(peer);
      await keyed.flush();
      // a WebCrypto-capable joiner: deliverable, but unproven — payloads go
      // out SEALED (never plaintext, never silence)
      ch.receive(
        concatFrame(
          FRAME.CONTROL,
          encoder.encode(
            JSON.stringify({ t: "hello", name: "stranger", platform: "test", e2e: true }),
          ),
        ),
      );
      await keyed.flush();

      keyed.client.sendFiles([file("sealed.bin")]);
      await keyed.settle();

      // every control frame on the wire, sealed ones opened with the room key
      const controls: Control[] = [];
      for (const f of ch.sent) {
        if (f[0] === FRAME.CONTROL) {
          controls.push(JSON.parse(decodeFrame(f).body) as Control);
        } else if (f[0] === FRAME.CONTROL_ENC) {
          controls.push(
            JSON.parse(
              decoder.decode(await victimCipher.open(f.subarray(1) as Uint8Array<ArrayBuffer>)),
            ) as Control,
          );
        }
      }
      expect(controls.find((c) => c.t === "file-queued")).toMatchObject({ name: "sealed.bin" });
      keyed.dispose();
    } finally {
      restore();
    }
  });

  it("cancelling a queued file retracts the announce on the wire", async () => {
    await h.start();
    const peer = h.addPeer(IMPOLITE_PEER);
    const ch = h.openChannel(peer);
    await h.flush();

    const views = h.client.sendFiles([file("keep.bin"), file("drop.bin")]);
    // cancel before the pump reaches the second job — it is still parked
    h.client.cancelTransfer(views[1].id);
    await h.settle();

    const controls = outboundControls(ch);
    expect(controls.filter((c) => c.t === "file-cancel" && c.id === views[1].id)).toHaveLength(1);
    // the retracted file never starts transferring
    expect(controls.some((c) => c.t === "file-start" && c.id === views[1].id)).toBe(false);
    const byId = new Map(
      h.client
        .getSnapshot()
        .transfers.filter((t) => t.dir === "out")
        .map((t) => [t.name, t.status]),
    );
    expect(byId.get("drop.bin")).toBe("cancelled");
    expect(byId.get("keep.bin")).toBe("done");
  });

  it("retracts its queued file when the receiver cancels the preview", async () => {
    await h.start();
    const peer = h.addPeer(IMPOLITE_PEER);
    const ch = h.openChannel(peer);
    await h.flush();

    const views = h.client.sendFiles([file("stay.bin"), file("gone.bin")]);
    // the receiver saw the announce and decided against "gone.bin"
    ch.receive(fileCancel(views[1].id));
    await h.settle();

    expect(views[1].status).toBe("cancelled");
    const controls = outboundControls(ch);
    expect(controls.some((c) => c.t === "file-start" && c.id === views[1].id)).toBe(false);
    expect(controls.some((c) => c.t === "file-start" && c.id === views[0].id)).toBe(true);
  });
});

describe("receiver queue preview", () => {
  it("renders the whole queue up front and promotes rows in place", async () => {
    await h.start();
    const peer = h.addPeer(IMPOLITE_PEER);
    const ch = h.openChannel(peer);
    await h.flush();

    ch.receive(fileQueued("q1", 8, "q1.bin"));
    ch.receive(fileQueued("q2", 8, "q2.bin"));
    ch.receive(fileQueued("q3", 8, "q3.bin"));
    await h.settle();
    expect(inboundViews()).toEqual([
      { id: "q3", status: "queued", name: "q3.bin" },
      { id: "q2", status: "queued", name: "q2.bin" },
      { id: "q1", status: "queued", name: "q1.bin" },
    ]);

    // the first file starts: its preview row is promoted (no duplicate), the
    // start frame's claim wins, and the rest of the queue stays visible
    ch.receive(fileStart("q1", 8, "q1-real.bin", "text/plain"));
    ch.receive(chunk(8));
    ch.receive(fileEnd("q1"));
    await h.settle();
    expect(inboundViews()).toEqual([
      { id: "q3", status: "queued", name: "q3.bin" },
      { id: "q2", status: "queued", name: "q2.bin" },
      { id: "q1", status: "done", name: "q1-real.bin" },
    ]);

    // the queue keeps draining exactly as announced
    ch.receive(fileStart("q2"));
    ch.receive(chunk(8));
    ch.receive(fileEnd("q2"));
    await h.settle();
    const byId = new Map(inboundViews().map((v) => [v.id, v.status]));
    expect(byId.get("q2")).toBe("done");
    expect(byId.get("q3")).toBe("queued");
    // previews never draw backpressure — the file-start carries it when due
    expect(outboundControls(ch).some((c) => c.t === "file-cancel")).toBe(false);
  });

  it("ignores duplicate announces, before and after the transfer", async () => {
    await h.start();
    const peer = h.addPeer(IMPOLITE_PEER);
    const ch = h.openChannel(peer);
    await h.flush();

    ch.receive(fileQueued("q1"));
    ch.receive(fileQueued("q1"));
    ch.receive(fileStart("q1"));
    ch.receive(chunk(8));
    ch.receive(fileEnd("q1"));
    ch.receive(fileQueued("q1"));
    await h.settle();
    expect(inboundViews()).toEqual([{ id: "q1", status: "done", name: "q.bin" }]);
  });

  it("ignores invalid announce claims without backpressure", async () => {
    await h.start();
    const peer = h.addPeer(IMPOLITE_PEER);
    const ch = h.openChannel(peer);
    await h.flush();

    ch.receive(fileQueued("over", MAX_STREAMABLE_SIZE + 1));
    ch.receive(fileQueued("negative", -1));
    ch.receive(fileQueued("fractional", 1.5));
    ch.receive(fileQueued("noname", 8, 42 as unknown as string));
    await h.settle();
    expect(inboundViews()).toEqual([]);
    // announces are informational: the file-start is where backpressure lives
    expect(outboundControls(ch).some((c) => c.t === "file-cancel")).toBe(false);
  });

  it("caps retained previews per peer, still without backpressure", async () => {
    await h.start();
    const peer = h.addPeer(IMPOLITE_PEER);
    const ch = h.openChannel(peer);
    await h.flush();

    for (let i = 0; i < MAX_QUEUED_INCOMING_PER_PEER + 5; i++) ch.receive(fileQueued(`q-${i}`));
    await h.settle();

    const queued = inboundViews().filter((v) => v.status === "queued");
    expect(queued).toHaveLength(MAX_QUEUED_INCOMING_PER_PEER);
    expect(outboundControls(ch).some((c) => c.t === "file-cancel")).toBe(false);
  });

  it("settles a preview whose file-start is refused", async () => {
    await h.start();
    const peer = h.addPeer(IMPOLITE_PEER);
    const ch = h.openChannel(peer);
    await h.flush();

    ch.receive(fileQueued("q1"));
    ch.receive(fileStart("ahead"));
    ch.receive(chunk(8));
    await h.settle();
    expect(inboundViews().find((v) => v.id === "q1")?.status).toBe("queued");

    // the announced transfer is bounced (busy) — its preview must not linger
    ch.receive(fileStart("q1"));
    await h.settle();
    const byId = new Map(inboundViews().map((v) => [v.id, v.status]));
    expect(byId.get("ahead")).toBe("cancelled");
    expect(byId.get("q1")).toBe("cancelled");
    const cancels = outboundControls(ch).filter((c) => c.t === "file-cancel");
    expect(cancels.some((c) => c.id === "q1" && c.reason === "busy")).toBe(true);
  });

  it("retracts a preview on the sender's file-cancel", async () => {
    await h.start();
    const peer = h.addPeer(IMPOLITE_PEER);
    const ch = h.openChannel(peer);
    await h.flush();

    ch.receive(fileQueued("q1"));
    await h.settle();
    expect(inboundViews()[0].status).toBe("queued");

    ch.receive(fileCancel("q1"));
    await h.settle();
    expect(inboundViews()[0].status).toBe("cancelled");
  });

  it("tells the sender when the user cancels a preview", async () => {
    await h.start();
    const peer = h.addPeer(IMPOLITE_PEER);
    const ch = h.openChannel(peer);
    await h.flush();

    ch.receive(fileQueued("q1"));
    await h.settle();
    h.client.cancelTransfer("q1");
    await h.settle();

    expect(inboundViews()[0].status).toBe("cancelled");
    expect(outboundControls(ch).some((c) => c.t === "file-cancel" && c.id === "q1")).toBe(true);
  });

  it("fails a peer's previews when the peer leaves", async () => {
    await h.start();
    const peer = h.addPeer(IMPOLITE_PEER);
    const ch = h.openChannel(peer);
    await h.flush();

    ch.receive(fileQueued("q1"));
    await h.settle();
    h.removePeer(IMPOLITE_PEER);
    await h.settle();
    expect(inboundViews()[0]).toMatchObject({ id: "q1", status: "error" });
  });
});

describe("preview sweep (SEC-04 companion)", () => {
  it("retires previews whose file-start never came once nothing is in flight", async () => {
    vi.useFakeTimers({ toFake: [...FAKED] });
    try {
      await h.client.start();
      const peer = h.addPeer(IMPOLITE_PEER);
      const ch = h.openChannel(peer);
      await vi.advanceTimersByTimeAsync(60);

      ch.receive(fileQueued("ghost"));
      await vi.advanceTimersByTimeAsync(60);
      expect(inboundViews()[0].status).toBe("queued");

      // sweeps inside the window leave it alone
      await vi.advanceTimersByTimeAsync(PING_EVERY * 2);
      expect(inboundViews()[0].status).toBe("queued");

      // creep to just under the window, then cross it on exactly one ping
      // sweep — the retire toast's own 4 s auto-dismiss timer stays outside
      // this advance, so the toast is still observable for the assertion
      await vi.advanceTimersByTimeAsync(QUEUED_STALE_MS - PING_EVERY * 2);
      await vi.advanceTimersByTimeAsync(PING_EVERY);
      expect(inboundViews()[0].status).toBe("cancelled");
      expect(h.client.getSnapshot().toasts.some((t) => t.msg.includes("announced"))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never sweeps a preview while the sender is actively transferring", async () => {
    vi.useFakeTimers({ toFake: [...FAKED] });
    try {
      await h.client.start();
      const peer = h.addPeer(IMPOLITE_PEER);
      const ch = h.openChannel(peer);
      await vi.advanceTimersByTimeAsync(60);

      // a long file is in flight while later files sit in the sender's queue
      ch.receive(fileQueued("q-later"));
      ch.receive(fileStart("busy", 240));
      for (let i = 0; i < 20; i++) {
        ch.receive(chunk(8));
        await vi.advanceTimersByTimeAsync(PING_EVERY * 1.5);
      }
      // far past QUEUED_STALE_MS, but the queue is alive — the preview stays
      expect(inboundViews().find((v) => v.id === "q-later")?.status).toBe("queued");

      // the pump reaches it the moment the current file ends — age is no bar
      ch.receive(fileEnd("busy"));
      ch.receive(fileStart("q-later"));
      ch.receive(chunk(8));
      ch.receive(fileEnd("q-later"));
      await vi.advanceTimersByTimeAsync(60);
      expect(inboundViews().find((v) => v.id === "q-later")?.status).toBe("done");
    } finally {
      vi.useRealTimers();
    }
  });
});
