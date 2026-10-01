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
  type HarnessPeer,
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

function systemBubblesOf(harness: RoomHarness): { text: string }[] {
  return harness.client
    .getSnapshot()
    .chats.filter((c) => c.system)
    .map((c) => ({ text: c.text }));
}

const PLAIN = (c: Control) => concatFrame(FRAME.CONTROL, encoder.encode(JSON.stringify(c)));

/** add a peer and script its far end BEFORE the channel opens, so the peer
 * sees the client's very first hello (the impolite side pre-creates it) */
function openScripted(
  harness: RoomHarness,
  peerId: string,
  opts: { key?: string; reportWhileKeyless?: boolean } = {},
): { peer: HarnessPeer; ch: FakeDataChannel } {
  const peer = harness.addPeer(peerId);
  const created = peer.channel as FakeDataChannel;
  if (!created) throw new Error("impolite peer must have a pre-created channel");
  scriptPeer(created, opts);
  return { peer, ch: harness.openChannel(peer) };
}

/** A scripted far end that reacts to every frame the client puts on the wire.
 * With `key` it behaves like a keyed member (challenges the client on hello);
 * without one it behaves like a keyless joiner (asks for the key, adopts a
 * key-offer, answers the sealed challenge once it holds the key).
 * `reportWhileKeyless` toggles today's receiver behavior of reporting the
 * first sealed frame it cannot open — the proof-challenge ping — back to the
 * sender; the fixed receiver stays quiet while it holds no key at all. */
function scriptPeer(
  ch: FakeDataChannel,
  opts: { key?: string; reportWhileKeyless?: boolean } = {},
) {
  const state: { cipher: RoomCipher | null } = { cipher: null };
  let reported = false;
  const ready: Promise<void> = opts.key
    ? RoomCipher.fromKey(opts.key).then((c) => {
        state.cipher = c;
      })
    : Promise.resolve();
  const challengeReport = () => {
    if (reported || !(opts.reportWhileKeyless ?? false)) return;
    reported = true;
    ch.receive(PLAIN({ t: "undecryptable", detail: "sealed", kind: "frame" }));
  };
  const react = async (frame: Uint8Array) => {
    await ready;
    const body = frame.subarray(1) as Uint8Array<ArrayBuffer>;
    if (frame[0] === FRAME.CONTROL) {
      const c = JSON.parse(decoder.decode(body)) as Control & { keyed?: boolean; k?: string };
      if (c.t === "hello") {
        if (!state.cipher && c.keyed === true) {
          ch.receive(PLAIN({ t: "key-request" }));
        } else if (state.cipher) {
          ch.receive(
            await state.cipher.seal(
              FRAME.CONTROL_ENC,
              encoder.encode(JSON.stringify({ t: "ping", at: Date.now(), n: "peer-challenge" })),
            ),
          );
        }
      } else if (c.t === "key-offer" && typeof c.k === "string" && !state.cipher) {
        state.cipher = await RoomCipher.fromKey(c.k);
        ch.receive(
          PLAIN({ t: "hello", name: "stranger", platform: "test", e2e: true, keyed: true }),
        );
      }
      return;
    }
    if (frame[0] !== FRAME.CONTROL_ENC) return;
    if (!state.cipher) {
      challengeReport();
      return;
    }
    try {
      const pt = await state.cipher.open(body);
      const c = JSON.parse(decoder.decode(pt)) as { t?: string; n?: string; at?: number };
      if (c.t === "ping" && c.n) {
        ch.receive(
          await state.cipher.seal(
            FRAME.CONTROL_ENC,
            encoder.encode(JSON.stringify({ t: "pong", at: c.at, n: c.n })),
          ),
        );
      }
    } catch {
      challengeReport();
    }
  };
  const origSend = ch.send.bind(ch);
  ch.send = (frame: Uint8Array) => {
    origSend(frame);
    void react(frame);
  };
  return state;
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

  it("suppresses toast and bubble when the report names nothing in the ledger", async () => {
    await h.start();
    const peer = h.addPeer(IMPOLITE_PEER);
    const ch = h.openChannel(peer);
    await h.flush();
    deliverHello(ch, true);
    await h.flush();

    // the only sealed frame an empty ledger can explain is the proof-challenge
    // ping — a protocol frame the receiver was never meant to read, not a
    // message. Reporting it as "couldn't read your recent messages" would
    // warn about a failure that never happened.
    deliverReport(ch, "sealed", "frame");
    await h.settle();

    expect(h.client.getSnapshot().chats.every((c) => !c.unreadableBy?.length)).toBe(true);
    expect(systemBubbles()).toEqual([]);
    expect(
      h.client
        .getSnapshot()
        .toasts.map((t) => t.msg)
        .filter((m) => m.includes("decrypt")),
    ).toEqual([]);
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

  it("a receiver holding no key stays quiet about sealed frames it cannot open", async () => {
    // keyless client, keyed far end: the sealed challenge the far end sends is
    // the expected join state (we asked for the key; every sealed frame fails
    // until it arrives) — it must not raise a decrypt warning or a report
    const keyless = createRoomHarness({ name: "keyless joiner" });
    try {
      await keyless.start();
      const { ch } = openScripted(keyless, IMPOLITE_PEER, { key: ROOM_KEY });
      await keyless.flush();
      await keyless.settle();

      expect(systemBubblesOf(keyless)).toEqual([]);
      expect(
        keyless.client
          .getSnapshot()
          .toasts.map((t) => t.msg)
          .filter((m) => m.includes("decrypt")),
      ).toEqual([]);
      const reports = ch.sent
        .filter((f) => f[0] === FRAME.CONTROL)
        .map((f) => JSON.parse(decoder.decode(f.subarray(1)) as string) as Control)
        .filter((c) => c.t === "undecryptable");
      expect(reports).toEqual([]);
    } finally {
      keyless.dispose();
    }
  });

  it("a receiver holding a DIFFERENT key still reports the failure", async () => {
    // the suppression covers only "no key at all" — a wrong key is a real
    // anomaly and must keep bubbling and reporting
    const wrongKey = createRoomHarness({ key: "a different room key" });
    try {
      await wrongKey.start();
      const { ch } = openScripted(wrongKey, IMPOLITE_PEER, { key: ROOM_KEY });
      await wrongKey.flush();
      await wrongKey.settle();

      const reports = ch.sent
        .filter((f) => f[0] === FRAME.CONTROL)
        .map((f) => JSON.parse(decoder.decode(f.subarray(1)) as string) as Control)
        .filter((c) => c.t === "undecryptable");
      expect(reports.length).toBeGreaterThan(0);
      expect(systemBubblesOf(wrongKey).length).toBeGreaterThan(0);
    } finally {
      wrongKey.dispose();
    }
  });
});

describe("join and key-share lifecycle", () => {
  it("a keyless joiner's join produces no unreadable warning on the sender", async () => {
    // the exact reported symptom: the moment a keyless peer joins a keyed
    // room, the sender sees "couldn't read your recent messages" even though
    // nothing was sent yet — triggered by the unreadable proof-challenge ping
    await h.start();
    const { ch } = openScripted(h, IMPOLITE_PEER, { reportWhileKeyless: true }); // today's receiver
    await h.flush();
    deliverHello(ch, true);
    await h.settle();

    const bubbles = systemBubbles().filter((b) => b.text.includes("couldn't read"));
    expect(bubbles).toEqual([]);
    expect(
      h.client
        .getSnapshot()
        .toasts.map((t) => t.msg)
        .filter((m) => m.includes("decrypt")),
    ).toEqual([]);
    expect(h.client.getSnapshot().chats.every((c) => !c.unreadableBy?.length)).toBe(true);
  });

  it("approving a key request stamps the messages that went out before the key", async () => {
    await h.start();
    const { ch } = openScripted(h, IMPOLITE_PEER); // quiet while keyless, adopts the offer
    await h.flush();
    deliverHello(ch, true);
    await h.flush();

    h.client.sendChat("before the key");
    await h.flush();

    // the keyless joiner asked for the key on our hello (the scripted far
    // end); approve — and the pre-offer ledger, delivered to a demonstrably
    // keyless peer, must be stamped at decision time
    await h.settle();
    expect(h.client.getSnapshot().keyRequests.map((q) => q.peerId)).toEqual([IMPOLITE_PEER]);
    h.client.respondKeyRequest(IMPOLITE_PEER, true);
    await h.settle();

    expect(
      h.client.getSnapshot().chats.find((c) => c.text === "before the key")?.unreadableBy,
    ).toEqual(["stranger"]);
    // the joiner proved possession — no aggregate warning bubble was created
    // for the key-share flow (the badges carry the per-message truth)
    expect(systemBubbles().some((b) => b.text.includes("couldn't read"))).toBe(false);
  });

  it("proof resolves the unreadable-warning bubble but keeps the stamps", async () => {
    await h.start();
    const { ch } = openScripted(h, IMPOLITE_PEER);
    await h.flush();
    deliverHello(ch, true);
    await h.flush();

    h.client.sendChat("lost pre-proof");
    await h.flush();
    deliverReport(ch, "sealed", "frame");
    await h.settle();
    expect(systemBubbles().some((b) => b.text.includes("couldn't read"))).toBe(true);

    // the joiner acquires the key (key-offer path) and proves — the warning's
    // advice ("share the key or resend once they do") is fulfilled for the
    // share half, so the aggregate bubble resolves; the per-message stamps
    // stay: those frames were dropped for good
    h.client.respondKeyRequest(IMPOLITE_PEER, true);
    await h.settle();

    expect(systemBubbles().some((b) => b.text.includes("couldn't read"))).toBe(false);
    expect(
      h.client.getSnapshot().chats.find((c) => c.text === "lost pre-proof")?.unreadableBy,
    ).toEqual(["stranger"]);
  });
});
