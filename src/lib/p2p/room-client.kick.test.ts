// Host kick + short-transfer integrity:
//  - kickPeer (the PeerList "remove" button behind it) asks the server to
//    remove the member — the wire carries { t: "kick", peerId } — and drops
//    the peer from the local roster without waiting for the round-trip.
//  - an inbound transfer whose end-frame arrives short (a phone suspended
//    mid-transfer dropping chunks is the classic case) settles as error with
//    no blob, never as a reassuring "received" empty file.
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { concatFrame, encoder, FRAME, type Control } from "./protocol";
import {
  createRoomHarness,
  installRoomClientStubs,
  IMPOLITE_PEER,
  type RoomHarness,
} from "./room-client.test-harness";

const ROOM_KEY = "correct horse battery staple";
let restoreStubs: () => void;
let host: RoomHarness;
let member: RoomHarness;

beforeEach(() => {
  restoreStubs = installRoomClientStubs();
  host = createRoomHarness({ name: "host", key: ROOM_KEY });
  member = createRoomHarness({ name: "member" }); // keyless joiner
});

afterEach(() => {
  host.dispose();
  member.dispose();
  restoreStubs();
});

function fileStart(id: string, size: number, name = "t.bin"): Uint8Array {
  const c: Control = { t: "file-start", id, name, size, mime: "application/octet-stream", g: "g" };
  return concatFrame(FRAME.CONTROL, encoder.encode(JSON.stringify(c)));
}

function chunk(n: number): Uint8Array {
  return concatFrame(FRAME.CHUNK, new Uint8Array(n).fill(1));
}

function fileEnd(id: string): Uint8Array {
  const c: Control = { t: "file-end", id };
  return concatFrame(FRAME.CONTROL, encoder.encode(JSON.stringify(c)));
}

describe("host kick", () => {
  it("sends the server kick and drops the peer from the roster immediately", async () => {
    await host.start();
    await member.start();
    host.addPeer(member.client.selfId, "member");
    member.addPeer(host.client.selfId, "host");
    await host.settle();
    expect(host.client.getSnapshot().peers).toHaveLength(1);

    host.client.kickPeer(member.client.selfId);
    await host.settle();

    // host-authoritative removal is the server's call — the client only asks
    expect(host.transport.sent).toContainEqual({ t: "kick", peerId: member.client.selfId });
    // the roster updates without waiting for the peer-leave round-trip
    expect(host.client.getSnapshot().peers.map((p) => p.peerId)).not.toContain(
      member.client.selfId,
    );
  });

  it("marks frames it sealed to the kicked peer as unreadable-by them", async () => {
    await host.start();
    await member.start();
    const peer = host.addPeer(member.client.selfId, "member");
    const ch = host.openChannel(peer);
    // e2e-capable but not yet proven — the host seals payloads to it (SEC-01)
    ch.receive(
      concatFrame(
        FRAME.CONTROL,
        encoder.encode(JSON.stringify({ t: "hello", name: "member", platform: "test", e2e: true })),
      ),
    );
    await host.settle();

    // a chat sealed to the still-connected member, then the kick
    host.client.sendChat("for you, briefly");
    await host.settle();
    host.client.kickPeer(member.client.selfId);
    await host.settle();

    const msg = host.client.getSnapshot().chats.find((c) => c.text === "for you, briefly");
    expect(msg?.unreadableBy).toContain("member");
  });
});

describe("short inbound transfer", () => {
  it("settles as error with no blob — never a silent empty 'received'", async () => {
    await host.start();
    const peer = host.addPeer(IMPOLITE_PEER);
    const ch = host.openChannel(peer);
    await host.flush();

    ch.receive(fileStart("t1", 8));
    ch.receive(chunk(4));
    await host.flush();
    ch.receive(fileEnd("t1"));
    await host.settle();

    const v = host.client.getSnapshot().transfers.find((t) => t.id === "t1");
    expect(v?.status).toBe("error");
    expect(v?.bytes).toBe(4);
    expect(v?.blob).toBeUndefined();
    expect(host.client.getSnapshot().toasts.some((t) => t.msg.includes("arrived incomplete"))).toBe(
      true,
    );
  });

  it("a complete transfer still lands as done with its blob", async () => {
    await host.start();
    const peer = host.addPeer(IMPOLITE_PEER);
    const ch = host.openChannel(peer);
    await host.flush();

    ch.receive(fileStart("t2", 4));
    ch.receive(chunk(4));
    await host.flush();
    ch.receive(fileEnd("t2"));
    await host.settle();

    const v = host.client.getSnapshot().transfers.find((t) => t.id === "t2");
    expect(v?.status).toBe("done");
    expect(v?.bytes).toBe(4);
    expect(v?.blob).toBeTruthy();
    expect(v?.blobUrl).toBeTruthy();
  });
});
