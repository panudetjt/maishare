// WebMCP room tools — the agent contract is the toolset, not the DOM: tools
// must register only when document.modelContext exists, observe the live
// RoomClient snapshot, and push chat/file sends through the same pipeline
// the UI uses (wire frames, queue-until-join, size validation included).
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { FRAME, type Control } from "./protocol";
import {
  createRoomHarness,
  decodeFrame,
  installRoomClientStubs,
  IMPOLITE_PEER,
  type FakeDataChannel,
  type RoomHarness,
} from "./room-client.test-harness";
import { registerRoomTools, type WebMcpTool } from "./webmcp";

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

class FakeModelContext {
  registered: { tool: WebMcpTool; signal?: AbortSignal }[] = [];

  registerTool(tool: WebMcpTool, options?: { signal?: AbortSignal }): void {
    this.registered.push({ tool, signal: options?.signal });
  }

  names(): string[] {
    return this.registered.map((r) => r.tool.name);
  }

  execute(name: string, input: Record<string, unknown>): unknown {
    const r = this.registered.find((x) => x.tool.name === name);
    if (!r) throw new Error(`tool not registered: ${name}`);
    return r.tool.execute(input);
  }
}

const b64 = (u8: Uint8Array) => Buffer.from(u8).toString("base64");

function outboundControls(ch: FakeDataChannel): (Control & { id?: string })[] {
  return ch.sent
    .filter((f) => f[0] === FRAME.CONTROL)
    .map((f) => JSON.parse(decodeFrame(f).body) as Control & { id?: string });
}

describe("WebMCP room tools", () => {
  it("is a no-op without document.modelContext (feature-detected)", () => {
    expect(registerRoomTools(h.client, undefined)).toBeUndefined();
  });

  it("registers the four tools with security-minded annotations", () => {
    const mc = new FakeModelContext();
    const dispose = registerRoomTools(h.client, mc);
    expect(dispose).toBeTypeOf("function");
    expect(mc.names()).toEqual([
      "maishare_room_status",
      "maishare_send_message",
      "maishare_send_file",
      "maishare_transfers_status",
    ]);
    const by = (n: string) => mc.registered.find((r) => r.tool.name === n)!.tool;
    expect(by("maishare_room_status").annotations).toEqual({ readOnlyHint: true });
    expect(by("maishare_transfers_status").annotations).toEqual({ readOnlyHint: true });
    expect(by("maishare_send_message").annotations).toEqual({ consequentialHint: true });
    expect(by("maishare_send_file").annotations).toEqual({ consequentialHint: true });
  });

  it("room_status observes the live snapshot", async () => {
    const mc = new FakeModelContext();
    registerRoomTools(h.client, mc);
    await h.start();
    const peer = h.addPeer(IMPOLITE_PEER);
    h.openChannel(peer);
    await h.settle();

    const status = mc.execute("maishare_room_status", {}) as {
      roomId: string;
      encrypted: boolean;
      peers: { name: string; status: string }[];
    };
    expect(status.roomId).toBe(h.client.getSnapshot().roomId);
    expect(status.encrypted).toBe(false); // keyless harness room
    expect(status.peers[0]).toMatchObject({ name: "peer", status: "open" });
  });

  it("send_message lands on the wire like a user-typed message", async () => {
    const mc = new FakeModelContext();
    registerRoomTools(h.client, mc);
    await h.start();
    const peer = h.addPeer(IMPOLITE_PEER);
    const ch = h.openChannel(peer);
    await h.settle();

    const res = mc.execute("maishare_send_message", { text: "hello from webmcp" }) as {
      sent: boolean;
      openPeerCount: number;
    };
    expect(res).toEqual({ sent: true, openPeerCount: 1 });
    await h.settle();
    const chat = outboundControls(ch).find((c) => c.t === "chat");
    expect(chat).toMatchObject({ t: "chat", text: "hello from webmcp" });
    expect(() => mc.execute("maishare_send_message", { text: "   " })).toThrow(/text/);
  });

  it("send_file assembles chunks and drives the real transfer pipeline", async () => {
    const mc = new FakeModelContext();
    registerRoomTools(h.client, mc);
    await h.start();
    const peer = h.addPeer(IMPOLITE_PEER);
    const ch = h.openChannel(peer);
    await h.settle();

    const partA = new Uint8Array(200).fill(7);
    const partB = new Uint8Array(100).fill(9);
    const mid = mc.execute("maishare_send_file", {
      name: "clip.mp4",
      size: 300,
      mime: "video/mp4",
      seq: 0,
      dataBase64: b64(partA),
    }) as { complete: boolean; receivedBytes: number };
    expect(mid).toEqual({ complete: false, receivedBytes: 200, totalBytes: 300 });

    const done = mc.execute("maishare_send_file", {
      name: "clip.mp4",
      size: 300,
      mime: "video/mp4",
      seq: 1,
      dataBase64: b64(partB),
      final: true,
    }) as { complete: true; transfer: { id: string; status: string } | null };
    expect(done.complete).toBe(true);
    expect(done.transfer?.status).toMatch(/queued|active/);

    // the file went out through the ordinary pipeline: header + chunks
    await h.settle();
    const start = outboundControls(ch).find((c) => c.t === "file-start");
    expect(start).toMatchObject({
      t: "file-start",
      name: "clip.mp4",
      size: 300,
      mime: "video/mp4",
    });
    const wireBytes = ch.sent
      .filter((f) => f[0] === FRAME.CHUNK)
      .reduce((n, f) => n + f.byteLength - 1, 0);
    expect(wireBytes).toBe(300);

    // transfers_status reports the same transfer for polling agents
    const list = mc.execute("maishare_transfers_status", {}) as {
      id: string;
      name: string;
      dir: string;
      size: number;
    }[];
    expect(list[0]).toMatchObject({
      id: done.transfer!.id,
      name: "clip.mp4",
      dir: "out",
      size: 300,
    });
  });

  it("send_file validates the chunk protocol", () => {
    const mc = new FakeModelContext();
    registerRoomTools(h.client, mc);

    expect(() =>
      mc.execute("maishare_send_file", {
        name: "a",
        size: 10,
        seq: 1,
        dataBase64: b64(new Uint8Array(4)),
      }),
    ).toThrow(/seq 0/);

    mc.execute("maishare_send_file", {
      name: "b",
      size: 4,
      seq: 0,
      dataBase64: b64(new Uint8Array(4)),
      final: true,
    });
    // announcing 8 but delivering only 4 must refuse to invent missing bytes
    mc.execute("maishare_send_file", {
      name: "b",
      size: 8,
      seq: 0,
      dataBase64: b64(new Uint8Array(4)),
    });
    expect(() =>
      mc.execute("maishare_send_file", {
        name: "b",
        size: 8,
        seq: 1,
        dataBase64: b64(new Uint8Array(0)),
        final: true,
      }),
    ).toThrow(/received 4/);

    // chunk data past the announced size aborts the upload
    expect(() =>
      mc.execute("maishare_send_file", {
        name: "c",
        size: 2,
        seq: 0,
        dataBase64: b64(new Uint8Array(5)),
      }),
    ).toThrow(/exceeds/);
  });
});
