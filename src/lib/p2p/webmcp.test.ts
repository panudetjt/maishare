// WebMCP room tools — the agent contract is the toolset, not the DOM: tools
// must register only when document.modelContext exists, observe the live
// RoomClient snapshot, and push chat/file sends through the same pipeline
// the UI uses (wire frames, queue-until-join, size validation included).
// Home tools cover room creation, recents and the nearby share handshake
// (share codes as plain strings instead of QR).
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { concatFrame, encoder, FRAME, type Control } from "./protocol";
import { unpackShareCode } from "./share-code";
import {
  createRoomHarness,
  decodeFrame,
  installRoomClientStubs,
  IMPOLITE_PEER,
  type FakeDataChannel,
  type RoomHarness,
} from "./room-client.test-harness";
import { registerHomeTools, registerRoomTools, type WebMcpTool } from "./webmcp";

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

  execute(name: string, input: Record<string, unknown>): Promise<unknown> {
    const r = this.registered.find((x) => x.tool.name === name);
    if (!r) return Promise.reject(new Error(`tool not registered: ${name}`));
    try {
      return Promise.resolve(r.tool.execute(input));
    } catch (err) {
      // the browser's executeTool surfaces sync throws as tool errors
      return Promise.reject(err);
    }
  }
}

const b64 = (u8: Uint8Array) => Buffer.from(u8).toString("base64");

function outboundControls(ch: FakeDataChannel): (Control & { id?: string })[] {
  return ch.sent
    .filter((f) => f[0] === FRAME.CONTROL)
    .map((f) => JSON.parse(decodeFrame(f).body) as Control & { id?: string });
}

const ROOM_TOOLS = [
  "maishare_room_status",
  "maishare_get_messages",
  "maishare_transfers_status",
  "maishare_wait_peer",
  "maishare_wait_transfer",
  "maishare_read_file",
  "maishare_send_message",
  "maishare_send_file",
  "maishare_set_name",
  "maishare_respond_consent",
  "maishare_cancel_transfer",
  "maishare_clear_history",
];

describe("WebMCP room tools", () => {
  it("is a no-op without document.modelContext (feature-detected)", () => {
    expect(registerRoomTools(() => h.client, undefined)).toBeUndefined();
    expect(registerHomeTools(undefined)).toBeUndefined();
  });

  it("registers the toolset with security-minded annotations", () => {
    const mc = new FakeModelContext();
    const dispose = registerRoomTools(() => h.client, mc, {
      getInvite: () => "https://x/r/ab#k=k",
    });
    expect(dispose).toBeTypeOf("function");
    expect(mc.names()).toEqual([
      ...ROOM_TOOLS.slice(0, 3),
      "maishare_get_invite",
      ...ROOM_TOOLS.slice(3),
    ]);
    const by = (n: string) => mc.registered.find((r) => r.tool.name === n)!.tool;
    for (const n of [
      "maishare_room_status",
      "maishare_get_messages",
      "maishare_transfers_status",
      "maishare_get_invite",
      "maishare_wait_peer",
      "maishare_wait_transfer",
      "maishare_read_file",
    ]) {
      expect(by(n).annotations, n).toEqual({
        readOnlyHint: true,
        ...(n === "maishare_get_messages" || n === "maishare_read_file"
          ? { untrustedContentHint: true }
          : {}),
      });
    }
    for (const n of [
      "maishare_send_message",
      "maishare_send_file",
      "maishare_respond_consent",
      "maishare_clear_history",
    ]) {
      expect(by(n).annotations, n).toEqual({ consequentialHint: true });
    }
  });

  it("room tools refuse to guess before a session exists", async () => {
    const mc = new FakeModelContext();
    registerRoomTools(() => null, mc);
    await expect(mc.execute("maishare_room_status", {})).rejects.toThrow(/no active session/);
  });

  it("room_status observes the live snapshot; set_name sticks", async () => {
    const mc = new FakeModelContext();
    registerRoomTools(() => h.client, mc);
    await h.start();
    const peer = h.addPeer(IMPOLITE_PEER);
    h.openChannel(peer);
    await h.settle();

    const status = (await mc.execute("maishare_room_status", {})) as {
      roomId: string;
      encrypted: boolean;
      peers: { name: string; status: string }[];
    };
    expect(status.roomId).toBe(h.client.getSnapshot().roomId);
    expect(status.encrypted).toBe(false); // keyless harness room
    expect(status.peers[0]).toMatchObject({ name: "peer", status: "open" });

    expect(await mc.execute("maishare_set_name", { name: "agent-b" })).toEqual({ name: "agent-b" });
    await h.settle();
    expect(h.client.getSnapshot().selfName).toBe("agent-b");
  });

  it("send_message lands on the wire; get_messages reads the timeline", async () => {
    const mc = new FakeModelContext();
    registerRoomTools(() => h.client, mc);
    await h.start();
    const peer = h.addPeer(IMPOLITE_PEER);
    const ch = h.openChannel(peer);
    await h.settle();

    const res = (await mc.execute("maishare_send_message", { text: "hello from webmcp" })) as {
      sent: boolean;
      openPeerCount: number;
    };
    expect(res).toEqual({ sent: true, openPeerCount: 1 });
    await h.settle();
    const chat = outboundControls(ch).find((c) => c.t === "chat");
    expect(chat).toMatchObject({ t: "chat", text: "hello from webmcp" });

    const msgs = (await mc.execute("maishare_get_messages", {})) as {
      text: string;
      mine: boolean;
    }[];
    expect(msgs.at(-1)).toEqual({
      name: expect.any(String),
      mine: true,
      system: false,
      text: "hello from webmcp",
      at: expect.any(Number),
    });
    await expect(mc.execute("maishare_send_message", { text: "   " })).rejects.toThrow(/text/);

    await mc.execute("maishare_clear_history", {});
    await h.settle();
    expect(h.client.getSnapshot().chats).toHaveLength(0);
  });

  it("send_file assembles chunks, drives the pipeline, waits and cancels", async () => {
    const mc = new FakeModelContext();
    registerRoomTools(() => h.client, mc);
    await h.start();
    const peer = h.addPeer(IMPOLITE_PEER);
    const ch = h.openChannel(peer);
    await h.settle();

    const partA = new Uint8Array(200).fill(7);
    const partB = new Uint8Array(100).fill(9);
    const mid = (await mc.execute("maishare_send_file", {
      name: "clip.mp4",
      size: 300,
      mime: "video/mp4",
      seq: 0,
      dataBase64: b64(partA),
    })) as { complete: boolean; receivedBytes: number };
    expect(mid).toEqual({ complete: false, receivedBytes: 200, totalBytes: 300 });

    const done = (await mc.execute("maishare_send_file", {
      name: "clip.mp4",
      size: 300,
      mime: "video/mp4",
      seq: 1,
      dataBase64: b64(partB),
      final: true,
    })) as { complete: true; transfer: { id: string; status: string } | null };
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

    const settled = (await mc.execute("maishare_wait_transfer", {
      id: done.transfer!.id,
      timeoutMs: 5000,
    })) as { status: string };
    expect(settled.status).toBe("done");

    // cancel is a no-op on settled transfers but reports their state
    const cancelled = (await mc.execute("maishare_cancel_transfer", { id: done.transfer!.id })) as {
      status: string;
    };
    expect(cancelled.status).toBe("done");
    expect(
      await mc.execute("maishare_wait_transfer", { id: "nope", timeoutMs: 100 }),
    ).toMatchObject({ status: "unknown" });
  });

  it("read_file pages a received file back out as base64", async () => {
    const mc = new FakeModelContext();
    registerRoomTools(() => h.client, mc);
    await h.start();
    const peer = h.addPeer(IMPOLITE_PEER);
    const ch = h.openChannel(peer);
    await h.settle();

    const payload = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
    const hdr: Control = {
      t: "file-start",
      id: "gotcha",
      name: "in.bin",
      size: 8,
      mime: "application/octet-stream",
      g: "g",
    };
    ch.receive(concatFrame(FRAME.CONTROL, encoder.encode(JSON.stringify(hdr))));
    ch.receive(concatFrame(FRAME.CHUNK, payload));
    ch.receive(
      concatFrame(
        FRAME.CONTROL,
        encoder.encode(JSON.stringify({ t: "file-end", id: "gotcha" } as Control)),
      ),
    );
    await h.settle();

    const page = (await mc.execute("maishare_read_file", {
      id: "gotcha",
      offset: 2,
      length: 4,
    })) as {
      dataBase64: string;
      eof: boolean;
      size: number;
    };
    expect(page).toEqual({
      offset: 2,
      size: 8,
      dataBase64: b64(new Uint8Array([30, 40, 50, 60])),
      eof: false,
    });
    const tail = (await mc.execute("maishare_read_file", {
      id: "gotcha",
      offset: 6,
      length: 100,
    })) as {
      dataBase64: string;
      eof: boolean;
    };
    expect(tail).toEqual({
      offset: 6,
      size: 8,
      dataBase64: b64(new Uint8Array([70, 80])),
      eof: true,
    });
    await expect(mc.execute("maishare_read_file", { id: "missing" })).rejects.toThrow(
      /unknown transfer/,
    );
  });

  it("respond_consent refuses when nothing is pending", async () => {
    const mc = new FakeModelContext();
    registerRoomTools(() => h.client, mc);
    await expect(mc.execute("maishare_respond_consent", { allow: true })).rejects.toThrow(
      /no pending consent/,
    );
  });

  it("wait_peer times out honestly with no peer", async () => {
    const mc = new FakeModelContext();
    registerRoomTools(() => h.client, mc);
    await h.start();
    const res = (await mc.execute("maishare_wait_peer", { timeoutMs: 100 })) as {
      connected: boolean;
      reason?: string;
    };
    expect(res.connected).toBe(false);
    expect(res.reason).toBe("timeout");
  });

  it("send_file validates the chunk protocol", async () => {
    const mc = new FakeModelContext();
    registerRoomTools(() => h.client, mc);

    await expect(
      mc.execute("maishare_send_file", {
        name: "a",
        size: 10,
        seq: 1,
        dataBase64: b64(new Uint8Array(4)),
      }),
    ).rejects.toThrow(/seq 0/);

    await mc.execute("maishare_send_file", {
      name: "b",
      size: 4,
      seq: 0,
      dataBase64: b64(new Uint8Array(4)),
      final: true,
    });
    // announcing 8 but delivering only 4 must refuse to invent missing bytes
    await mc.execute("maishare_send_file", {
      name: "b",
      size: 8,
      seq: 0,
      dataBase64: b64(new Uint8Array(4)),
    });
    await expect(
      mc.execute("maishare_send_file", {
        name: "b",
        size: 8,
        seq: 1,
        dataBase64: b64(new Uint8Array(0)),
        final: true,
      }),
    ).rejects.toThrow(/received 4/);

    // chunk data past the announced size aborts the upload
    await expect(
      mc.execute("maishare_send_file", {
        name: "c",
        size: 2,
        seq: 0,
        dataBase64: b64(new Uint8Array(5)),
      }),
    ).rejects.toThrow(/exceeds/);
  });
});

describe("WebMCP home tools", () => {
  it("create_room returns a fragment-keyed invite; recent_rooms is a list", async () => {
    const mc = new FakeModelContext();
    registerHomeTools(mc);
    const room = (await mc.execute("maishare_create_room", {})) as {
      roomId: string;
      key: string;
      inviteUrl: string;
    };
    expect(room.roomId).toMatch(/^[\w-]{2,64}$/);
    expect(room.key.length).toBeGreaterThan(10);
    expect(room.inviteUrl).toContain(`/r/${room.roomId}#k=`);
    expect(Array.isArray(await mc.execute("maishare_recent_rooms", {}))).toBe(true);
  });

  it("nearby handshake produces real share codes; room tools bind after start", async () => {
    const mc = new FakeModelContext();
    registerHomeTools(mc);

    // before any session the shared room tools refuse to guess
    await expect(mc.execute("maishare_room_status", {})).rejects.toThrow(/no active session/);

    const start = (await mc.execute("maishare_nearby_start", { name: "agent-a" })) as {
      offerCode: string;
    };
    const offer = await unpackShareCode(start.offerCode);
    expect(offer.type).toBe("offer");
    expect(offer.name).toBe("agent-a");

    // once the initiator session exists the room tools bind to it
    const status = (await mc.execute("maishare_room_status", {})) as { roomId: string };
    expect(status.roomId).toBe("direct");

    // confirming a garbage answer fails loudly instead of half-connecting
    await expect(mc.execute("maishare_nearby_confirm", { answerCode: "x" })).rejects.toThrow();
    const acc = new FakeModelContext();
    registerHomeTools(acc);
    await expect(acc.execute("maishare_nearby_accept", { offerCode: "garbage" })).rejects.toThrow();
  });
});
