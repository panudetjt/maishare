// Ticket 02 / SECURITY-SPEC.md SEC-01 — keyed rooms withhold payload frames
// (chat, file-start, chunks) from peers that have not proven key possession
// by echoing a sealed nonce pong, unless the user explicitly consents.
// Drives the real RoomClient through the shared harness; assertions read the
// wire (captured data-channel frames), and the public store snapshot — never
// client internals. The test knows the room key, so it can decode the
// victim's sealed frames exactly as a real peer would.
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
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

let restoreStubs: () => void;
let h: RoomHarness;
let victimCipher: RoomCipher; // the harness's own key — decodes what it sealed

const ROOM_KEY = "correct horse battery staple";

beforeEach(async () => {
  restoreStubs = installRoomClientStubs();
  h = createRoomHarness({ key: ROOM_KEY });
  victimCipher = await RoomCipher.fromKey(ROOM_KEY);
});

afterEach(() => {
  h.dispose();
  restoreStubs();
});

/** every control frame the victim put on the wire, sealed ones opened */
async function wireControls(ch: FakeDataChannel): Promise<Control[]> {
  const out: Control[] = [];
  for (const f of ch.sent) {
    if (f[0] === FRAME.CONTROL) {
      out.push(JSON.parse(decodeFrame(f).body) as Control);
    } else if (f[0] === FRAME.CONTROL_ENC) {
      out.push(
        JSON.parse(
          decoder.decode(await victimCipher.open(f.subarray(1) as Uint8Array<ArrayBuffer>)),
        ) as Control,
      );
    }
  }
  return out;
}

async function payloadCount(ch: FakeDataChannel): Promise<number> {
  return (await wireControls(ch)).filter((c) => c.t === "chat" || c.t === "file-start").length;
}

/** the peer side answers the victim's sealed challenge with a sealed pong */
async function answerProofChallenge(ch: FakeDataChannel, peerCipher: RoomCipher) {
  const sealed = [...ch.sent].reverse().find((f) => f[0] === FRAME.CONTROL_ENC);
  if (!sealed) throw new Error("peer received no sealed challenge");
  const ping = JSON.parse(
    decoder.decode(await peerCipher.open(sealed.subarray(1) as Uint8Array<ArrayBuffer>)),
  ) as {
    t: string;
    n?: string;
  };
  expect(ping.t).toBe("ping");
  expect(ping.n).toBeTruthy();
  const pong: Control = { t: "pong", at: Date.now(), n: ping.n };
  // cipher.seal already emits the full wire frame ([type][iv][ct])
  ch.receive(await peerCipher.seal(FRAME.CONTROL_ENC, encoder.encode(JSON.stringify(pong))));
  await h.flush();
}

function deliverHello(ch: FakeDataChannel, e2e: boolean) {
  const hello: Control = { t: "hello", name: "stranger", platform: "test", e2e };
  ch.receive(concatFrame(FRAME.CONTROL, encoder.encode(JSON.stringify(hello))));
}

describe("withholding from unproven peers (SEC-01)", () => {
  it("withholds chat from an incapable peer; our protocol frames still flow", async () => {
    await h.start();
    const peer = h.addPeer(IMPOLITE_PEER);
    const ch = h.openChannel(peer);
    await h.flush();

    // our hello went out as a PLAIN protocol frame even in a keyed room
    const hello = decodeFrame(ch.sent[0]);
    expect(hello.type).toBe(FRAME.CONTROL);
    expect(JSON.parse(hello.body).t).toBe("hello");

    // peer cannot do WebCrypto (iOS on plain http) — the consent gate queues
    deliverHello(ch, false);
    await h.settle(); // store emits on a 50ms debounce — settle before reading
    expect(h.client.getSnapshot().consents).toEqual([{ peerId: IMPOLITE_PEER, name: "stranger" }]);

    h.client.sendChat("secret plan");
    await h.flush();
    // nothing payload-shaped on the wire — not plaintext, not sealed
    expect(await payloadCount(ch)).toBe(0);

    // refusal keeps withholding and is remembered (no re-prompt)
    h.client.respondConsent(IMPOLITE_PEER, false);
    await h.settle();
    expect(h.client.getSnapshot().consents).toEqual([]);
    h.client.sendChat("second attempt");
    await h.flush();
    expect(await payloadCount(ch)).toBe(0);
    expect(h.client.getSnapshot().consents).toEqual([]);
  });

  it("releases withheld payloads as plaintext after explicit consent", async () => {
    await h.start();
    const peer = h.addPeer(IMPOLITE_PEER);
    const ch = h.openChannel(peer);
    await h.flush();
    deliverHello(ch, false);
    await h.flush();

    h.client.sendChat("consented secret");
    await h.flush();
    expect(await payloadCount(ch)).toBe(0);

    h.client.respondConsent(IMPOLITE_PEER, true);
    await h.settle();
    const controls = await wireControls(ch);
    const chat = controls.find((c) => c.t === "chat");
    expect(chat).toMatchObject({ t: "chat", text: "consented secret" });
    // the frame itself is plaintext — the explicit downgrade
    const raw = [...ch.sent].reverse().find((f) => decodeFrame(f).body.includes("consented"));
    expect(raw?.[0]).toBe(FRAME.CONTROL);
  });

  it("marks a peer proven on a sealed echoing pong and delivers sealed payloads", async () => {
    await h.start();
    const peer = h.addPeer(IMPOLITE_PEER);
    const ch = h.openChannel(peer);
    await h.flush();
    deliverHello(ch, true);
    await h.flush();

    const peerCipher = await RoomCipher.fromKey(ROOM_KEY);
    await answerProofChallenge(ch, peerCipher);
    expect(h.client.getSnapshot().consents).toEqual([]); // capable peers are never asked

    h.client.sendChat("now you can read this");
    await h.flush();
    const controls = await wireControls(ch);
    const chat = controls.filter((c) => c.t === "chat");
    expect(chat).toHaveLength(1);
    expect(chat[0]).toMatchObject({ t: "chat", text: "now you can read this" });
    // the chat frame itself is sealed on the wire
    const last = ch.sent.at(-1)!;
    expect(last[0]).toBe(FRAME.CONTROL_ENC);
  });

  it("never proves a peer on an unsealed or wrong-nonce pong — payloads still sealed", async () => {
    await h.start();
    const peer = h.addPeer(IMPOLITE_PEER);
    const ch = h.openChannel(peer);
    await h.flush();
    deliverHello(ch, true);
    await h.flush();

    const peerCipher = await RoomCipher.fromKey(ROOM_KEY);
    const sealed = [...ch.sent].reverse().find((f) => f[0] === FRAME.CONTROL_ENC)!;
    const ping = JSON.parse(
      decoder.decode(await peerCipher.open(sealed.subarray(1) as Uint8Array<ArrayBuffer>)),
    ) as {
      n?: string;
    };

    // plaintext echo proves nothing — the nonce is only secret inside a seal
    ch.receive(
      concatFrame(
        FRAME.CONTROL,
        encoder.encode(JSON.stringify({ t: "pong", at: Date.now(), n: ping.n })),
      ),
    );
    await h.flush();
    h.client.sendChat("sealed anyway");
    await h.flush();
    // the unproven peer still receives the ciphertext — an unreadable frame
    // the far side renders as an explicit bubble, never silence — but NO
    // plaintext ever leaves without proof or consent
    expect(await payloadCount(ch)).toBe(1);
    // the chat left as ciphertext (CONTROL_ENC), never plaintext
    expect(ch.sent.at(-1)![0]).toBe(FRAME.CONTROL_ENC);

    // wrong nonce in a sealed pong proves nothing either
    ch.receive(
      await peerCipher.seal(
        FRAME.CONTROL_ENC,
        encoder.encode(JSON.stringify({ t: "pong", at: Date.now(), n: "forged" })),
      ),
    );
    await h.flush();
    h.client.sendChat("still ciphertext");
    await h.flush();
    expect(await payloadCount(ch)).toBe(2);
    expect(ch.sent.at(-1)![0]).toBe(FRAME.CONTROL_ENC);
  });

  it("sends sealed payloads to a keyless-capable joiner — never silence", async () => {
    await h.start();
    const peer = h.addPeer(IMPOLITE_PEER);
    const ch = h.openChannel(peer);
    await h.flush();
    // secure-context joiner without the key: claims capability, never answers
    deliverHello(ch, true);
    await h.flush();

    h.client.sendChat("you get ciphertext");
    await h.flush();
    // the joiner receives the SEALED frame and its client renders an explicit
    // undecryptable bubble — withheld silence is what hid the old receive bug
    expect(await payloadCount(ch)).toBe(1);
    expect(ch.sent.at(-1)![0]).toBe(FRAME.CONTROL_ENC);
    // capable-but-unproven peers draw no consent prompt — nothing is plaintext
    expect(h.client.getSnapshot().consents).toEqual([]);
  });

  it("holds deferred traffic queued before connection until proven/consented", async () => {
    // chats and files queued while nobody was connected
    h.client.sendChat("queued chat");
    h.client.sendFiles([
      new File([new Uint8Array(16).fill(7)], "queued.bin", { type: "application/octet-stream" }),
    ]);
    await h.flush();

    const peer = h.addPeer(IMPOLITE_PEER);
    const ch = h.openChannel(peer);
    await h.flush();
    deliverHello(ch, false);
    await h.flush();
    // keyed + unproven: the deferred queue is NOT flushed
    expect(await payloadCount(ch)).toBe(0);

    h.client.respondConsent(IMPOLITE_PEER, true);
    await h.settle();
    const controls = await wireControls(ch);
    expect(controls.find((c) => c.t === "chat")).toMatchObject({ text: "queued chat" });
    expect(controls.find((c) => c.t === "file-start")).toBeDefined();
  });

  it("wrong-key member stays on the undecryptable path — sealed bytes, never plaintext", async () => {
    await h.start();
    const peer = h.addPeer(IMPOLITE_PEER);
    const ch = h.openChannel(peer);
    await h.flush();
    deliverHello(ch, true);
    await h.flush();

    // the peer holds the WRONG key: our sealed challenge cannot be opened, so
    // the designed warning fires on their side and the back-channel toast on ours
    const sealed = [...ch.sent].reverse().find((f) => f[0] === FRAME.CONTROL_ENC)!;
    const wrongCipher = await RoomCipher.fromKey("not the room key");
    await expect(wrongCipher.open(sealed.subarray(1) as Uint8Array<ArrayBuffer>)).rejects.toThrow();
    // the peer's undecryptable back-channel arrives (always plain)
    ch.receive(
      concatFrame(
        FRAME.CONTROL,
        encoder.encode(JSON.stringify({ t: "undecryptable", detail: "sealed" })),
      ),
    );
    await h.settle();
    expect(h.client.getSnapshot().toasts.some((t) => t.msg.toLowerCase().includes("decrypt"))).toBe(
      true,
    );

    // the wrong-key member receives the payload as SEALED ciphertext — their
    // client renders an explicit bubble per message, and nothing readable
    // ever leaves this side without their proving the key
    h.client.sendChat("not for mallory");
    await h.flush();
    expect(await payloadCount(ch)).toBe(1); // the sealed chat (pings are not payloads)
    expect(ch.sent.at(-1)![0]).toBe(FRAME.CONTROL_ENC);
    expect(h.client.getSnapshot().consents).toEqual([]);
  });

  it("keeps the keyless room fully open (no gating without a key)", async () => {
    const restore = installRoomClientStubs();
    try {
      const open = createRoomHarness(); // no key
      await open.start();
      const peer = open.addPeer(IMPOLITE_PEER);
      const ch = open.openChannel(peer);
      await open.flush();
      deliverHello(ch, false);
      await open.flush();
      expect(open.client.getSnapshot().consents).toEqual([]);
      open.client.sendChat("plaintext room");
      await open.flush();
      const raw = [...ch.sent]
        .reverse()
        .find((f) => decodeFrame(f).body.includes("plaintext room"));
      expect(raw?.[0]).toBe(FRAME.CONTROL);
      open.dispose();
    } finally {
      restore();
    }
  });
});
