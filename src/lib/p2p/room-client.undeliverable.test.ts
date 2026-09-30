// Unreadable-delivery feedback: when a peer reports a frame it could not
// open (the `undecryptable` back-channel), the sender must learn WHICH of
// its messages/files failed — persistently, not in a four-second toast that
// fires once per connection. The receiver cannot name the item (the sealed
// payload is unreadable to it too), so the sender correlates the report
// against the ledger of payloads it sealed to that peer while it was still
// unproven — the only frames the peer could have dropped. Drives the real
// RoomClient through the shared harness; assertions read wire frames and
// the public store snapshot.
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { RoomCipher } from "./crypto";
import { concatFrame, decoder, encoder, FRAME, type Control } from "./protocol";
import {
  createRoomHarness,
  installRoomClientStubs,
  IMPOLITE_PEER,
  type FakeDataChannel,
  type RoomHarness,
} from "./room-client.test-harness";

let restoreStubs: () => void;
let h: RoomHarness;

const ROOM_KEY = "unreadable report room key";

beforeEach(() => {
  restoreStubs = installRoomClientStubs();
  h = createRoomHarness({ key: ROOM_KEY });
});

afterEach(() => {
  h.dispose();
  restoreStubs();
});

/** a plain undecryptable report arrives from the peer — the receiver sends
 * it as a PLAIN control frame so any sender can parse it regardless of keys */
function deliverReport(
  ch: FakeDataChannel,
  detail: "sealed" | "malformed" | "orphan",
  kind?: "frame" | "chunk",
) {
  const c: Control = { t: "undecryptable", detail, ...(kind ? { kind } : {}) };
  ch.receive(concatFrame(FRAME.CONTROL, encoder.encode(JSON.stringify(c))));
}

function deliverHello(ch: FakeDataChannel, e2e: boolean) {
  const hello: Control = { t: "hello", name: "stranger", platform: "test", e2e };
  ch.receive(concatFrame(FRAME.CONTROL, encoder.encode(JSON.stringify(hello))));
}

function systemBubbles(): { text: string }[] {
  return h.client
    .getSnapshot()
    .chats.filter((c) => c.system)
    .map((c) => ({ text: c.text }));
}

describe("sender-side unreadable-delivery feedback", () => {
  it("stamps every chat sent sealed-unproven and appends a persistent bubble", async () => {
    await h.start();
    const peer = h.addPeer(IMPOLITE_PEER);
    const ch = h.openChannel(peer);
    await h.flush();
    // capable joiner without the key: receives SEALED payloads it cannot open
    deliverHello(ch, true);
    await h.flush();

    h.client.sendChat("first secret");
    h.client.sendChat("second secret");
    await h.flush();

    // the peer reports its first unreadable frame (it latches to one per
    // connection) — the ledger must cover BOTH pre-proof chats
    deliverReport(ch, "sealed", "frame");
    await h.settle();

    const chats = h.client.getSnapshot().chats;
    expect(chats.find((c) => c.text === "first secret")?.unreadableBy).toEqual(["stranger"]);
    expect(chats.find((c) => c.text === "second secret")?.unreadableBy).toEqual(["stranger"]);
    const bubble = systemBubbles().find((b) => b.text.includes("stranger"));
    expect(bubble?.text).toContain("couldn't read your recent messages");
    expect(bubble?.text).toContain("room key");
  });

  it("stamps a file transfer on a chunk-kind report", async () => {
    await h.start();
    const peer = h.addPeer(IMPOLITE_PEER);
    const ch = h.openChannel(peer);
    await h.flush();
    deliverHello(ch, true);
    await h.flush();

    h.client.sendFiles([
      new File([new Uint8Array(32).fill(9)], "report.bin", { type: "application/octet-stream" }),
    ]);
    await h.settle();

    deliverReport(ch, "sealed", "chunk");
    await h.settle();

    const view = h.client.getSnapshot().transfers.find((t) => t.name === "report.bin");
    expect(view?.unreadableBy).toEqual(["stranger"]);
    expect(systemBubbles().some((b) => b.text.includes("couldn't read the file you sent"))).toBe(
      true,
    );
  });

  it("clears the ledger on proof — post-proof messages are never stamped", async () => {
    await h.start();
    const peer = h.addPeer(IMPOLITE_PEER);
    const ch = h.openChannel(peer);
    await h.flush();
    deliverHello(ch, true);
    await h.flush();

    h.client.sendChat("before proof");
    await h.flush();
    deliverReport(ch, "sealed", "frame");
    await h.settle();
    expect(
      h.client.getSnapshot().chats.find((c) => c.text === "before proof")?.unreadableBy,
    ).toEqual(["stranger"]);

    // the joiner acquires the key and answers the sealed challenge — proof.
    // The challenge is the sealed PING (a chat went out after it, also
    // sealed — so search for the ping by payload, not by position).
    const peerCipher = await RoomCipher.fromKey(ROOM_KEY);
    let nonce: string | undefined;
    for (const f of ch.sent.filter((x) => x[0] === FRAME.CONTROL_ENC)) {
      try {
        const payload = JSON.parse(
          decoder.decode(await peerCipher.open(f.subarray(1) as Uint8Array<ArrayBuffer>)),
        ) as { t?: string; n?: string };
        if (payload.t === "ping" && payload.n) {
          nonce = payload.n;
          break;
        }
      } catch {
        // sealed with a different key or corrupt — not the challenge
      }
    }
    if (!nonce) throw new Error("no sealed challenge found on the wire");
    ch.receive(
      await peerCipher.seal(
        FRAME.CONTROL_ENC,
        encoder.encode(JSON.stringify({ t: "pong", at: Date.now(), n: nonce })),
      ),
    );
    await h.flush();

    h.client.sendChat("after proof");
    await h.flush();
    deliverReport(ch, "sealed", "frame"); // a late duplicate report
    await h.settle();

    // frames sent after proof open on their side — never stamped
    const after = h.client.getSnapshot().chats.find((c) => c.text === "after proof");
    expect(after?.unreadableBy).toBeUndefined();
    // pre-proof stamps survive: those frames were already dropped for good
    expect(
      h.client.getSnapshot().chats.find((c) => c.text === "before proof")?.unreadableBy,
    ).toEqual(["stranger"]);
  });

  it("stamps nothing when the ledger is empty but still bubbles", async () => {
    await h.start();
    const peer = h.addPeer(IMPOLITE_PEER);
    const ch = h.openChannel(peer);
    await h.flush();
    deliverHello(ch, true);
    await h.flush();

    // a report with nothing sealed-unproven behind it (stale peer, odd state):
    // no badges — never invent guilt — but the situation is still surfaced
    deliverReport(ch, "sealed", "frame");
    await h.settle();

    expect(h.client.getSnapshot().chats.every((c) => !c.unreadableBy?.length)).toBe(true);
    expect(systemBubbles().some((b) => b.text.includes("stranger"))).toBe(true);
  });

  it("keeps malformed/orphan reports toast-only — no stamps, no bubble", async () => {
    await h.start();
    const peer = h.addPeer(IMPOLITE_PEER);
    const ch = h.openChannel(peer);
    await h.flush();
    deliverHello(ch, true);
    await h.flush();

    h.client.sendChat("sealed anyway");
    await h.flush();
    deliverReport(ch, "orphan");
    await h.settle();

    expect(
      h.client.getSnapshot().chats.find((c) => c.text === "sealed anyway")?.unreadableBy,
    ).toBeUndefined();
    expect(systemBubbles()).toEqual([]);
  });
});

describe("receiver-side back-channel", () => {
  it("names the failed kind on the wire so the sender can tell message from file", async () => {
    await h.start();
    const peer = h.addPeer(IMPOLITE_PEER);
    const ch = h.openChannel(peer);
    await h.flush();

    // a sealed control frame the victim cannot open (bogus ciphertext)
    ch.receive(concatFrame(FRAME.CONTROL_ENC, new Uint8Array(40).fill(5)));
    await h.settle();
    const reports = () =>
      ch.sent
        .filter((f) => f[0] === FRAME.CONTROL)
        .map(
          (f) =>
            JSON.parse(decoder.decode(f.subarray(1)) as string) as Control & {
              kind?: string;
            },
        )
        .filter((c) => c.t === "undecryptable");
    expect(reports().at(-1)).toMatchObject({ detail: "sealed", kind: "frame" });

    // the back-channel fires once per connection — a fresh connection is
    // needed to observe the chunk-kind report
    h.removePeer(IMPOLITE_PEER);
    await h.settle();
    const peer2 = h.addPeer(IMPOLITE_PEER);
    const ch2 = h.openChannel(peer2);
    await h.flush();
    ch2.receive(concatFrame(FRAME.CHUNK_ENC, new Uint8Array(40).fill(5)));
    await h.settle();
    const chunkReports = ch2.sent
      .filter((f) => f[0] === FRAME.CONTROL)
      .map(
        (f) => JSON.parse(decoder.decode(f.subarray(1)) as string) as Control & { kind?: string },
      )
      .filter((c) => c.t === "undecryptable");
    expect(chunkReports.at(-1)).toMatchObject({ detail: "sealed", kind: "chunk" });
  });
});
