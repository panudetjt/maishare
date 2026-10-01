// Ticket 03 / SECURITY-SPEC.md SEC-02 — the announced transfer header bounds
// what the receiver accepts. Claims are validated before any state is built
// (safe non-negative integer size under a hard ceiling; name/mime clamped in
// length), and the first chunk byte past the announced size is a protocol
// violation: the transfer aborts, the context clears, file-cancel backpressure
// names the reason, and one toast tells the user. The byte counter reflects
// bytes actually received and is never rewritten to the claim.
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { concatFrame, encoder, FRAME, type Control } from "./protocol";
import {
  createRoomHarness,
  decodeFrame,
  installRoomClientStubs,
  IMPOLITE_PEER,
  type FakeDataChannel,
  type RoomHarness,
} from "./room-client.test-harness";
import { MAX_MIME_CHARS, MAX_NAME_CHARS } from "./room-client";
import { MAX_STREAMABLE_SIZE, RAM_BUFFER_LIMIT } from "./spill";

let restoreStubs: () => void;
let h: RoomHarness;

beforeEach(() => {
  restoreStubs = installRoomClientStubs();
  h = createRoomHarness();
});

afterEach(() => {
  h.dispose();
  restoreStubs();
});

function fileStart(
  id: string,
  size: number,
  name = "file.bin",
  mime = "application/octet-stream",
): Uint8Array {
  const c: Control = { t: "file-start", id, name, size, mime, g: "grp" };
  return concatFrame(FRAME.CONTROL, encoder.encode(JSON.stringify(c)));
}

function chunk(bytes: Uint8Array): Uint8Array {
  return concatFrame(FRAME.CHUNK, bytes);
}

function fileEnd(id: string): Uint8Array {
  const c: Control = { t: "file-end", id };
  return concatFrame(FRAME.CONTROL, encoder.encode(JSON.stringify(c)));
}

async function outboundControls(ch: FakeDataChannel): Promise<Control[]> {
  return ch.sent
    .filter((f) => f[0] === FRAME.CONTROL)
    .map((f) => JSON.parse(decodeFrame(f).body) as Control);
}

function inboundView(): {
  status: string;
  bytes: number;
  size: number;
  name: string;
  mime: string;
  blob?: Blob;
} {
  const v = h.client.getSnapshot().transfers.find((t) => t.dir === "in");
  if (!v) throw new Error("no inbound transfer view");
  return v;
}

describe("transfer size cross-check (SEC-02)", () => {
  it("aborts the transfer on the first chunk byte past the claim", async () => {
    await h.start();
    const peer = h.addPeer(IMPOLITE_PEER);
    const ch = h.openChannel(peer);
    await h.flush();

    ch.receive(fileStart("t1", 1));
    await h.settle();
    expect(inboundView().status).toBe("active");

    // 8 bytes against a 1-byte claim — protocol violation
    ch.receive(chunk(new Uint8Array(8).fill(9)));
    await h.settle();

    const v = inboundView();
    expect(v.status).toBe("error");
    expect(v.bytes).toBe(0); // the violating chunk was never accepted
    // explicit backpressure naming the reason
    const cancel = (await outboundControls(ch)).find((c) => c.t === "file-cancel");
    expect(cancel).toMatchObject({ t: "file-cancel", id: "t1", reason: "size-mismatch" });
    // exactly one user-visible toast
    expect(
      h.client.getSnapshot().toasts.filter((t) => t.msg.includes("more data than announced")),
    ).toHaveLength(1);
  });

  it("clears the incoming context after the abort (late chunks are orphans)", async () => {
    await h.start();
    const peer = h.addPeer(IMPOLITE_PEER);
    const ch = h.openChannel(peer);
    await h.flush();

    ch.receive(fileStart("t1", 1));
    ch.receive(chunk(new Uint8Array(4).fill(1)));
    await h.flush();
    ch.receive(chunk(new Uint8Array(4).fill(2)));
    await h.settle();

    // a chunk after the abort has no context: the orphan warning fires exactly
    // once (deduped), and no second size-violation toast appears
    expect(
      h.client
        .getSnapshot()
        .chats.filter((c) => c.system && c.text.includes("without its transfer header")),
    ).toHaveLength(1);
    expect(
      h.client.getSnapshot().toasts.filter((t) => t.msg.includes("more data than announced")),
    ).toHaveLength(1);
    // a late file-end for the aborted id changes nothing
    ch.receive(fileEnd("t1"));
    await h.settle();
    expect(inboundView().status).toBe("error");
  });

  it("rejects invalid claims at the header with backpressure and no state", async () => {
    await h.start();
    const peer = h.addPeer(IMPOLITE_PEER);
    const ch = h.openChannel(peer);
    await h.flush();

    const badSizes = [NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, MAX_STREAMABLE_SIZE + 1];
    for (const [i, size] of badSizes.entries()) {
      ch.receive(fileStart(`bad-${i}`, size));
    }
    await h.flush();

    expect(h.client.getSnapshot().transfers).toHaveLength(0);
    const cancels = (await outboundControls(ch)).filter((c) => c.t === "file-cancel");
    expect(cancels).toHaveLength(badSizes.length);
    for (const c of cancels) expect(c.reason).toBe("invalid-header");
  });

  it("clamps over-length name and mime claims before they reach state", async () => {
    await h.start();
    const peer = h.addPeer(IMPOLITE_PEER);
    const ch = h.openChannel(peer);
    await h.flush();

    ch.receive(fileStart("t1", 8, "x".repeat(1000), "application/x".repeat(20)));
    await h.settle();

    const v = inboundView();
    expect(v.name.length).toBe(MAX_NAME_CHARS);
    expect(v.mime.length).toBe(MAX_MIME_CHARS);
    expect(v.size).toBe(8);
  });

  it("honest multi-chunk transfers complete byte-exactly (fix-safety)", async () => {
    await h.start();
    const peer = h.addPeer(IMPOLITE_PEER);
    const ch = h.openChannel(peer);
    await h.flush();

    const payload = new Uint8Array(24).map((_, i) => i);
    ch.receive(fileStart("honest", 24));
    ch.receive(chunk(payload.slice(0, 10)));
    ch.receive(chunk(payload.slice(10, 20)));
    ch.receive(chunk(payload.slice(20)));
    ch.receive(fileEnd("honest"));
    await h.settle();
    await h.settle();

    const v = inboundView();
    expect(v.status).toBe("done");
    expect(v.bytes).toBe(24);
    expect(v.size).toBe(24);
    expect(v.blob?.size).toBe(24);
    expect(h.client.getSnapshot().recvTotal).toBe(24);
    // no cancel went back to the honest sender
    expect((await outboundControls(ch)).some((c) => c.t === "file-cancel")).toBe(false);
  });

  it("never rewrites the byte counter to the claim at file-end", async () => {
    await h.start();
    const peer = h.addPeer(IMPOLITE_PEER);
    const ch = h.openChannel(peer);
    await h.flush();

    // short delivery: 10 of the announced 16 bytes, then file-end — the
    // counter keeps the RECEIVED bytes (10, not the claimed 16) and the
    // transfer settles as error, never as a silent empty "received"
    ch.receive(fileStart("short", 16));
    ch.receive(chunk(new Uint8Array(10).fill(3)));
    ch.receive(fileEnd("short"));
    await h.settle();

    const v = inboundView();
    expect(v.status).toBe("error");
    expect(v.bytes).toBe(10); // received bytes, not the claimed 16
  });

  it("enforces the same bounds for plaintext frames in keyed rooms", async () => {
    const restore = installRoomClientStubs();
    try {
      const keyed = createRoomHarness({ key: "some room key" });
      await keyed.start();
      const peer = keyed.addPeer(IMPOLITE_PEER);
      const ch = keyed.openChannel(peer);
      await keyed.flush();

      // a wrong-key (plaintext) sender floods past a 1-byte claim
      ch.receive(fileStart("plain-1", 1));
      ch.receive(chunk(new Uint8Array(16).fill(5)));
      await keyed.settle();

      const v = keyed.client.getSnapshot().transfers.find((t) => t.dir === "in")!;
      expect(v.status).toBe("error");
      const cancel = ch.sent
        .filter((f) => f[0] === FRAME.CONTROL)
        .map((f) => JSON.parse(decodeFrame(f).body) as Control)
        .find((c) => c.t === "file-cancel");
      expect(cancel).toMatchObject({ id: "plain-1", reason: "size-mismatch" });
      keyed.dispose();
    } finally {
      restore();
    }
  });
  it("refuses a disk-bound header without OPFS instead of buffering it", async () => {
    await h.start();
    const peer = h.addPeer(IMPOLITE_PEER);
    const ch = h.openChannel(peer);
    await h.flush();

    // node has no navigator.storage → pickIncomingSink must say too-large
    ch.receive(fileStart("huge", RAM_BUFFER_LIMIT + 1, "iso.img"));
    await h.settle();

    expect(h.client.getSnapshot().transfers).toHaveLength(0);
    const cancel = (await outboundControls(ch)).find((c) => c.t === "file-cancel");
    expect(cancel).toMatchObject({ id: "huge", reason: "too-large" });
  });

  it("streams a disk-bound transfer to OPFS and finishes from disk", async () => {
    const files = new Map<string, Uint8Array[]>();
    const root = {
      async getDirectoryHandle() {
        return rootThis();
      },
      async getFileHandle(name: string, opts?: { create?: boolean }) {
        if (opts?.create) files.set(name, []);
        const parts = files.get(name);
        if (!parts) throw new Error("missing");
        return {
          async createWritable() {
            let open = true;
            return {
              async write(data: ArrayBuffer) {
                if (!open) throw new Error("closed");
                parts.push(new Uint8Array(data));
              },
              async close() {
                open = false;
              },
              async abort() {
                open = false;
              },
            };
          },
          async getFile() {
            const total = parts.reduce((n, p) => n + p.byteLength, 0);
            const out = new Uint8Array(total);
            let off = 0;
            for (const p of parts) {
              out.set(p, off);
              off += p.byteLength;
            }
            return new File([out], name);
          },
        };
      },
      async removeEntry(name: string) {
        files.delete(name);
      },
    };
    function rootThis() {
      return root;
    }
    vi.stubGlobal("navigator", { storage: { getDirectory: () => Promise.resolve(root) } });
    try {
      await h.start();
      const peer = h.addPeer(IMPOLITE_PEER);
      const ch = h.openChannel(peer);
      await h.flush();

      // announce far past the RAM limit, deliver the full claim in one chunk,
      // finish
      ch.receive(fileStart("big", RAM_BUFFER_LIMIT + 1024, "big.iso"));
      await h.settle();
      const v1 = h.client.getSnapshot().transfers.find((t) => t.id === "big");
      expect(v1?.status).toBe("active");

      ch.receive(chunk(new Uint8Array(RAM_BUFFER_LIMIT + 1024).fill(7)));
      ch.receive(fileEnd("big"));
      await h.settle();

      const v = h.client.getSnapshot().transfers.find((t) => t.id === "big")!;
      expect(v.status).toBe("done");
      expect(v.bytes).toBe(RAM_BUFFER_LIMIT + 1024);
      expect(v.blob?.size).toBe(RAM_BUFFER_LIMIT + 1024);
      expect(files.size).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
