// LAN-list join into a keyed room — live bug regression. The "On your
// network" list opens /r/:roomId with NO #k= fragment, so the joiner holds no
// room key: it could not open the sealed challenge, drew the "Could not
// decrypt" warning, and every member payload stayed withheld while its own
// chats flowed out in plaintext. These tests wire two REAL RoomClients over
// a duplex fake channel with real AES-GCM and lock down the key-share flow:
// request once, human approves, key travels over the DTLS channel, proof
// completes both directions, everything seals end-to-end.
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { concatFrame, decoder, encoder, FRAME, type Control } from "./protocol";
import {
  createRoomHarness,
  decodeFrame,
  FakeDataChannel,
  installRoomClientStubs,
  IMPOLITE_PEER,
  type FakeDataChannel as FDC,
  type HarnessPeer,
  type RoomHarness,
} from "./room-client.test-harness";

const ROOM_KEY = "pr6mB46ESQ18o4g5ieSgg69t";
const UNDECRYPTABLE =
  "⚠︎ Could not decrypt this message — the sender's app may be outdated or the room key differs.";

let restoreStubs: () => void;
let win: RoomHarness;
let mac: RoomHarness;

beforeEach(() => {
  restoreStubs = installRoomClientStubs();
  // Windows holds the invite key (creator or invite-URL join)
  win = createRoomHarness({ key: ROOM_KEY, name: "windows" });
  // Mac clicked the room in the "On your network" list → /r/:roomId, no #k=
  mac = createRoomHarness({ name: "mac" });
});

afterEach(() => {
  win.dispose();
  mac.dispose();
  restoreStubs();
});

/** full-duplex data channel wire: whatever one client sends, the other receives */
function wire(a: FakeDataChannel, b: FakeDataChannel) {
  const sa = a.send.bind(a);
  a.send = (f) => {
    sa(f);
    b.receive(f);
  };
  const sb = b.send.bind(b);
  b.send = (f) => {
    sb(f);
    a.receive(f);
  };
}

/** inject the polite side's data channel WITHOUT opening it, so the duplex
 * wire is attached before any hello fires */
function injectChannel(p: HarnessPeer): FakeDataChannel {
  const ch = new FakeDataChannel("maishare");
  p.pc.ondatachannel?.({ channel: ch });
  p.channel = ch;
  return ch;
}

/** a real data channel is bidirectional: frames only flow once the ONE
 * channel is open in both directions. The fake splits it into two objects,
 * so defer onopen to a microtask — both sides are "open" before the first
 * hello crosses, matching real WebRTC (a hello can never arrive on a channel
 * whose peer side is still connecting). */
function deferredOpen(ch: FakeDataChannel) {
  if (ch.readyState === "open") return;
  ch.readyState = "open";
  queueMicrotask(() => ch.onopen?.());
}

/** wire ONE pair of clients like the real mesh would: roster join both ways,
 * the single data channel wired duplex (open in both directions before any
 * hello crosses), so the phantom-peer sweep never evicts the pair mid-test */
async function connectPair(a: RoomHarness, b: RoomHarness): Promise<[HarnessPeer, HarnessPeer]> {
  const aOnA = a.addPeer(b.client.selfId, b === win ? "windows" : b === mac ? "mac" : "bob");
  const bOnB = b.addPeer(a.client.selfId, a === win ? "windows" : a === mac ? "mac" : "bob");
  const aChannel = aOnA.pc.channels[0];
  const bChannel = bOnB.pc.channels[0];
  const createdCh = (aChannel ?? bChannel)!;
  const politeCh = aChannel ? injectChannel(bOnB) : injectChannel(aOnA);
  wire(createdCh, politeCh);
  deferredOpen(createdCh);
  deferredOpen(politeCh);
  await a.settle();
  return [aOnA, bOnB];
}

async function connectPeers(): Promise<[HarnessPeer, HarnessPeer]> {
  return connectPair(win, mac);
}

/** tell a harness's client who the host is and what the room policy is */
function announce(h: RoomHarness, host: string, ks: "host" | "anyone" = "host") {
  h.transport.deliver({
    t: "welcome",
    you: h.client.selfId,
    peers: [],
    addresses: [],
    host,
    ks,
  });
}

describe("LAN-list join into a keyed room (key share)", () => {
  it("asks once, and approval unseals the room end-to-end in both directions", async () => {
    await win.start();
    await mac.start();
    await connectPeers();

    // the keyless joiner asked exactly once; the member sees the gate
    expect(win.client.getSnapshot().keyRequests).toEqual([
      { peerId: mac.client.selfId, name: "mac" },
    ]);
    expect(mac.client.getSnapshot().keyRequests).toEqual([]);

    win.client.respondKeyRequest(mac.client.selfId, true);
    await win.settle();
    await mac.settle();

    // the joiner now holds the key and re-proved itself to the member…
    expect(mac.client.getSnapshot().selfKey).toBe(ROOM_KEY);
    expect(mac.client.getSnapshot().encrypted).toBe(true);
    // …and the member proved itself back (the joiner challenged on adoption)
    const macPeer = mac.client.getSnapshot().peers[0];
    expect(macPeer).toBeTruthy();

    // the transient handshake warning is gone
    expect(mac.client.getSnapshot().chats.some((c) => c.system && c.text === UNDECRYPTABLE)).toBe(
      false,
    );

    // member → joiner now delivers, sealed
    win.client.sendChat("hello from windows");
    await win.settle();
    const atMac = mac.client.getSnapshot().chats.find((c) => c.text === "hello from windows");
    expect(atMac).toBeTruthy();
    expect(atMac!.sealed).toBe(true);

    // joiner → member now delivers sealed too (the joiner challenged the
    // member after adopting the key, so the member is proven on its side)
    mac.client.sendChat("hello from mac");
    await mac.settle();
    const atWin = win.client.getSnapshot().chats.find((c) => c.text === "hello from mac");
    expect(atWin).toBeTruthy();
    expect(atWin!.sealed).toBe(true);

    // the gate is consumed
    expect(win.client.getSnapshot().keyRequests).toEqual([]);
  });

  it("refusal keeps the joiner keyless: member payloads withheld, joiner plaintext flows out", async () => {
    await win.start();
    await mac.start();
    await connectPeers();
    expect(win.client.getSnapshot().keyRequests).toHaveLength(1);

    win.client.respondKeyRequest(mac.client.selfId, false);
    await win.settle();

    // no key arrived
    expect(mac.client.getSnapshot().selfKey).toBeNull();
    expect(mac.client.getSnapshot().encrypted).toBe(false);

    // the member's chat arrives only as unreadable ciphertext — the text
    // itself never shows up…
    win.client.sendChat("not for the keyless");
    await win.settle();
    expect(mac.client.getSnapshot().chats.some((c) => c.text === "not for the keyless")).toBe(
      false,
    );
    // …but an explicit undecryptable bubble DOES (no silence)
    expect(mac.client.getSnapshot().chats.some((c) => c.system && c.text === UNDECRYPTABLE)).toBe(
      true,
    );

    // the joiner's own chats reach the member (plaintext, DTLS-only)
    mac.client.sendChat("hello from mac");
    await mac.settle();
    expect(win.client.getSnapshot().chats.some((c) => c.text === "hello from mac")).toBe(true);

    // no re-prompt: the decision is final for this connection
    win.client.sendChat("still nothing");
    await win.settle();
    expect(win.client.getSnapshot().keyRequests).toEqual([]);

    // SEC-11: the denial also asked the server to remove the joiner
    expect(win.transport.sent).toContainEqual({ t: "kick", peerId: mac.client.selfId });
  });

  it("undecryptable messages never vanish — one bubble each on the keyless side", async () => {
    await win.start();
    await mac.start();
    const [, macToWin] = await connectPeers();

    // three member messages to a joiner that cannot decrypt yet: EACH one
    // leaves an explicit bubble in the joiner's timeline (the no-silence rule)
    win.client.sendChat("one");
    win.client.sendChat("two");
    win.client.sendChat("three");
    await win.settle();

    const bubbles = mac.client
      .getSnapshot()
      .chats.filter((c) => c.system && c.text === UNDECRYPTABLE);
    // 1 per undecryptable message — the sealed challenge ping (the first
    // sealed frame of any connection) is absorbed silently on the keyless
    // side: failing it is the designed join state, not a lost message
    expect(bubbles.length).toBe(3);

    // the sender learns once (throttled back-channel), not per message
    const backChannels = macToWin.channel!.sent.filter(
      (f) => f[0] === FRAME.CONTROL && decodeFrame(f).body.includes("undecryptable"),
    );
    expect(backChannels).toHaveLength(1);
  });

  it("two key holders need no share at all — plain E2E both ways", async () => {
    mac.dispose();
    mac = createRoomHarness({ key: ROOM_KEY, name: "mac2" });
    await win.start();
    await mac.start();
    await connectPeers();

    expect(win.client.getSnapshot().keyRequests).toEqual([]);
    expect(mac.client.getSnapshot().keyRequests).toEqual([]);

    win.client.sendChat("both keyed 1");
    mac.client.sendChat("both keyed 2");
    await win.settle();
    await mac.settle();

    const atMac = mac.client.getSnapshot().chats.find((c) => c.text === "both keyed 1");
    expect(atMac?.sealed).toBe(true);
    const atWin = win.client.getSnapshot().chats.find((c) => c.text === "both keyed 2");
    expect(atWin?.sealed).toBe(true);
  });
});

describe("key-share guards (single harness)", () => {
  let restore: () => void;
  let h: RoomHarness;

  beforeEach(() => {
    restore = installRoomClientStubs();
    h = createRoomHarness({ key: ROOM_KEY, name: "member" });
  });

  afterEach(() => {
    h.dispose();
    restore();
  });

  function plainControls(ch: FDC): Control[] {
    return ch.sent
      .filter((f) => f[0] === FRAME.CONTROL)
      .map((f) => JSON.parse(decoder.decode(f.subarray(1))) as Control);
  }

  function deliverHello(ch: FDC, e2e: boolean, keyed: boolean) {
    const hello: Control = { t: "hello", name: "joiner", platform: "test", e2e, keyed };
    ch.receive(concatFrame(FRAME.CONTROL, encoder.encode(JSON.stringify(hello))));
  }

  it("requests the key once per peer no matter how many hellos arrive", async () => {
    // the REQUESTER is the keyless side — swap the harness for one without a key
    h.dispose();
    h = createRoomHarness({ name: "keyless-joiner" });
    await h.start();
    const peer = h.addPeer(IMPOLITE_PEER);
    const ch = h.openChannel(peer);
    await h.flush();
    deliverHello(ch, true, true);
    await h.flush();
    deliverHello(ch, true, true);
    await h.flush();

    expect(plainControls(ch).filter((c) => c.t === "key-request")).toHaveLength(1);
    // a keyed hello never draws a request; a keyless peer draws none either
    deliverHello(ch, true, false);
    await h.flush();
    expect(plainControls(ch).filter((c) => c.t === "key-request")).toHaveLength(1);
  });

  it("ignores a key-offer when a cipher already exists", async () => {
    await h.start();
    const peer = h.addPeer(IMPOLITE_PEER);
    const ch = h.openChannel(peer);
    await h.flush();
    ch.receive(
      concatFrame(
        FRAME.CONTROL,
        encoder.encode(JSON.stringify({ t: "key-offer", k: "other-key-123" })),
      ),
    );
    await h.settle();

    // the harness holds ROOM_KEY — the offer must not replace it
    expect(h.client.getSnapshot().selfKey).toBe(ROOM_KEY);
    expect(h.client.getSnapshot().chats.some((c) => c.system)).toBe(false);
  });

  it("ignores malformed key-offers", async () => {
    for (const bad of ["", "short", "x".repeat(201)]) {
      const restore2 = installRoomClientStubs();
      try {
        const keyless = createRoomHarness({ name: "keyless" });
        await keyless.start();
        const peer = keyless.addPeer(IMPOLITE_PEER);
        const ch = keyless.openChannel(peer);
        await keyless.flush();
        ch.receive(
          concatFrame(FRAME.CONTROL, encoder.encode(JSON.stringify({ t: "key-offer", k: bad }))),
        );
        await keyless.settle();
        expect(keyless.client.getSnapshot().selfKey).toBeNull();
        expect(keyless.client.getSnapshot().encrypted).toBe(false);
        keyless.dispose();
      } finally {
        restore2();
      }
    }
  });
});

describe("host-gated key share (SEC-11)", () => {
  let restore: () => void;
  let bob: RoomHarness;

  beforeEach(() => {
    restore = installRoomClientStubs();
    // a second keyed member who is NOT the host
    bob = createRoomHarness({ key: ROOM_KEY, name: "bob" });
  });

  afterEach(() => {
    win.dispose();
    mac.dispose();
    bob.dispose();
    restore();
  });

  it("host-only policy: the joiner asks the host alone; a non-host prompt never appears", async () => {
    await win.start();
    await bob.start();
    await mac.start();
    announce(win, win.client.selfId, "host");
    announce(bob, win.client.selfId, "host");
    announce(mac, win.client.selfId, "host");

    await connectPair(win, mac);
    await connectPair(bob, mac);
    await win.settle();

    // the joiner asked the host only — the non-host keyed member got nothing
    expect(win.client.getSnapshot().keyRequests).toHaveLength(1);
    expect(bob.client.getSnapshot().keyRequests).toEqual([]);
  });

  it("anyone policy: the joiner asks every keyed peer and a non-host can approve", async () => {
    await win.start();
    await bob.start();
    await mac.start();
    announce(win, win.client.selfId, "anyone");
    announce(bob, win.client.selfId, "anyone");
    announce(mac, win.client.selfId, "anyone");

    await connectPair(bob, mac);
    await win.settle();

    // the joiner asked the non-host too, and the non-host sees the gate
    expect(bob.client.getSnapshot().keyRequests).toHaveLength(1);
    expect(bob.client.getSnapshot().keyShare).toBe("anyone");

    // the non-host's approval shares the key just the same
    bob.client.respondKeyRequest(mac.client.selfId, true);
    await bob.settle();
    await mac.settle();
    expect(mac.client.getSnapshot().selfKey).toBe(ROOM_KEY);
  });

  it("a non-host can only dismiss a prompt — no kick ever leaves the building", async () => {
    await win.start();
    await bob.start();
    await mac.start();
    announce(win, win.client.selfId, "anyone");
    announce(bob, win.client.selfId, "anyone");
    announce(mac, win.client.selfId, "anyone");

    await connectPair(bob, mac);
    await win.settle();
    expect(bob.client.getSnapshot().keyRequests).toHaveLength(1);

    bob.client.dismissKeyRequest(mac.client.selfId);
    await bob.settle();
    expect(bob.client.getSnapshot().keyRequests).toEqual([]);
    expect(bob.transport.sent.filter((m) => m.t === "kick")).toHaveLength(0);
  });

  it("a kicked joiner tears the mesh down and surfaces the removal", async () => {
    await win.start();
    await mac.start();
    announce(win, win.client.selfId, "host");
    announce(mac, win.client.selfId, "host");
    await connectPair(win, mac);
    await win.settle();
    expect(win.client.getSnapshot().keyRequests).toHaveLength(1);

    win.client.respondKeyRequest(mac.client.selfId, false);
    await win.settle();
    // the (faked) server enforces the kick and tells the joiner
    mac.transport.deliver({ t: "kicked" });
    await mac.settle();

    expect(mac.client.getSnapshot().kicked).toBe(true);
    expect(mac.client.getSnapshot().peers).toEqual([]);
    expect(mac.client.getSnapshot().keyRequests).toEqual([]);
  });

  it("follows host re-election broadcasts", async () => {
    await win.start();
    win.transport.deliver({ t: "host", peerId: "peer-newhost000" });
    await win.settle();
    expect(win.client.getSnapshot().hostId).toBe("peer-newhost000");
  });
});
