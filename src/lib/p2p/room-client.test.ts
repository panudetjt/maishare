// Ticket 01 / SECURITY-SPEC.md SEC-06 — the pre-description ICE-candidate
// buffer is capped. Drives the real RoomClient through the shared test
// harness (fake transport + stub WebRTC): assertions read wire frames, the
// WebRTC sink, and the public store snapshot — never client internals.
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { concatFrame, encoder, FRAME } from "./protocol";
import {
  createRoomHarness,
  decodeFrame,
  installRoomClientStubs,
  IMPOLITE_PEER,
  POLITE_PEER,
  type RoomHarness,
} from "./room-client.test-harness";
import { MAX_PENDING_CANDIDATES } from "./room-client";

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

describe("candidate queue cap (SEC-06)", () => {
  it("drops candidates beyond the cap when no SDP ever arrives", async () => {
    await h.start();
    const peer = h.addPeer(POLITE_PEER);
    expect(peer.pc.candidates).toHaveLength(0);

    for (let i = 0; i < MAX_PENDING_CANDIDATES * 3; i++) h.candidate(POLITE_PEER, i);
    // nothing reached the WebRTC sink yet — no description has arrived
    expect(peer.pc.candidates).toHaveLength(0);

    h.offer(POLITE_PEER);
    await h.flush();

    // exactly the cap drained, in arrival order; the flood beyond it is gone
    expect(peer.pc.candidates).toHaveLength(MAX_PENDING_CANDIDATES);
    expect(peer.pc.candidates[0]?.candidate).toContain("candidate:0");
    expect(peer.pc.candidates[MAX_PENDING_CANDIDATES - 1]?.candidate).toContain(
      `candidate:${MAX_PENDING_CANDIDATES - 1}`,
    );
    // no error surfaced anywhere — the drop is silent
    expect(h.client.getSnapshot().chats.every((c) => !c.system)).toBe(true);
  });

  it("drains exactly the queued set on the first description", async () => {
    await h.start();
    const peer = h.addPeer(POLITE_PEER);

    for (let i = 0; i < 5; i++) h.candidate(POLITE_PEER, i);
    h.offer(POLITE_PEER);
    await h.flush();

    expect(peer.pc.candidates).toHaveLength(5);
    // the polite answer still goes out on the wire
    const outbound = h.transport.signalsTo(POLITE_PEER);
    expect(outDescriptionTypes(outbound)).toContain("answer");
  });

  it("bypasses the queue for candidates arriving after the description", async () => {
    await h.start();
    const peer = h.addPeer(POLITE_PEER);

    for (let i = 0; i < MAX_PENDING_CANDIDATES * 2; i++) h.candidate(POLITE_PEER, i);
    h.offer(POLITE_PEER);
    await h.flush();
    expect(peer.pc.candidates).toHaveLength(MAX_PENDING_CANDIDATES);

    // steady-state trickle goes straight to the sink, cap or no cap
    h.candidate(POLITE_PEER, "late-1");
    h.candidate(POLITE_PEER, "late-2");
    await h.flush();
    expect(peer.pc.candidates).toHaveLength(MAX_PENDING_CANDIDATES + 2);
    expect(peer.pc.candidates.at(-1)?.candidate).toContain("candidate:late-2");
  });

  it("releases the queue when the peer leaves", async () => {
    await h.start();
    const first = h.addPeer(POLITE_PEER);
    for (let i = 0; i < 7; i++) h.candidate(POLITE_PEER, i);

    h.removePeer(POLITE_PEER);
    await h.settle();
    expect(h.peerIds()).not.toContain(POLITE_PEER);

    // the peer returns: a fresh connection with a fresh (empty) queue —
    // only the new candidate drains, the old buffered flood is gone
    const second = h.addPeer(POLITE_PEER);
    expect(second.pc).not.toBe(first.pc);
    h.candidate(POLITE_PEER, "after-return");
    h.offer(POLITE_PEER);
    await h.flush();
    expect(second.pc.candidates).toHaveLength(1);
    expect(second.pc.candidates[0]?.candidate).toContain("candidate:after-return");
  });

  it("releases the queue when a reconnect rebuilds the mesh", async () => {
    await h.start();
    const first = h.addPeer(POLITE_PEER);
    for (let i = 0; i < 9; i++) h.candidate(POLITE_PEER, i);

    h.transport.setStatus("offline");
    h.transport.setStatus("online");
    await h.settle();
    expect(h.peerIds()).not.toContain(POLITE_PEER);
    expect(first.pc.connectionState).toBe("closed");

    const second = h.addPeer(POLITE_PEER);
    expect(second.pc).not.toBe(first.pc);
    h.candidate(POLITE_PEER, "post-reconnect");
    h.offer(POLITE_PEER);
    await h.flush();
    expect(second.pc.candidates).toHaveLength(1);
  });
});

describe("harness: the real client over the test seam (fix-safety)", () => {
  it("runs a normal negotiation unchanged", async () => {
    await h.start();
    const peer = h.addPeer(POLITE_PEER);

    // a polite peer answers an offer and relays its local description back
    h.offer(POLITE_PEER);
    await h.flush();
    expect(peer.pc.remoteDescription?.type).toBe("offer");
    const outbound = h.transport.signalsTo(POLITE_PEER);
    expect(outDescriptionTypes(outbound)).toContain("answer");
  });

  it("captures outbound frames byte- and type-exactly over an open channel", async () => {
    await h.start();
    const peer = h.addPeer(IMPOLITE_PEER);

    // the impolite side creates the channel itself and offers
    await h.flush();
    const offered = outDescriptionTypes(h.transport.signalsTo(IMPOLITE_PEER));
    expect(offered).toContain("offer");

    const ch = h.openChannel(peer);
    expect(ch.sent.length).toBeGreaterThan(0);

    // first frame on the wire is the hello control frame
    const hello = decodeFrame(ch.sent[0]);
    expect(hello.type).toBe(FRAME.CONTROL);
    expect(JSON.parse(hello.body).t).toBe("hello");

    // chat goes out as a plain control frame with the text verbatim
    h.client.sendChat("hi there");
    await h.flush();
    const chat = decodeFrame(ch.sent.at(-1)!);
    expect(chat.type).toBe(FRAME.CONTROL);
    expect(JSON.parse(chat.body)).toMatchObject({ t: "chat", text: "hi there" });

    // a peer chat frame arrives back and lands in the public store
    ch.receive(
      concatFrame(
        FRAME.CONTROL,
        encoder.encode(JSON.stringify({ t: "chat", id: "c1", text: "yo", at: 1 })),
      ),
    );
    await h.settle();
    const inbound = h.client.getSnapshot().chats.find((c) => c.text === "yo");
    expect(inbound).toMatchObject({ mine: false, peerId: IMPOLITE_PEER });
  });
});

function outDescriptionTypes(msgs: { data: unknown }[]): string[] {
  return msgs
    .map((m) => m.data as { type?: string })
    .map((d) => d.type)
    .filter((t): t is string => t != null);
}
