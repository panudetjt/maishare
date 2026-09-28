// Negotiation-loop regression (SEC-12, the biggest measured flood source):
// onSignal used to call setLocalDescription() after applying an ANSWER too —
// and a no-arg setLocalDescription() in stable state is an IMPLICIT NEW OFFER
// in every real browser, so two clients ping-ponged offer/answer through the
// signaling DO forever (observed: sustained ~22 req/s with a single pair).
// The harness's fake pc now models implicit re-offers, and this test bridges
// the two clients' signaling for real: the exchange must stay bounded and
// STOP — never a loop.
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  createRoomHarness,
  installRoomClientStubs,
  type RoomHarness,
} from "./room-client.test-harness";

let restoreStubs: () => void;
let win: RoomHarness;
let mac: RoomHarness;

beforeEach(() => {
  restoreStubs = installRoomClientStubs();
  win = createRoomHarness({ key: "k-pr6mB46ESQ18o4g", name: "windows" });
  mac = createRoomHarness({ key: "k-pr6mB46ESQ18o4g", name: "mac" });
});

afterEach(() => {
  win.dispose();
  mac.dispose();
  restoreStubs();
});

/** forward signaling both ways like the real relay would, with a safety cap
 * so a live offer/answer loop cannot spin the test to death */
function bridgeSignals(a: RoomHarness, b: RoomHarness, cap = 30): () => number {
  let forwarded = 0;
  const wire = (from: RoomHarness, to: RoomHarness) => {
    const orig = from.transport.send.bind(from.transport);
    from.transport.send = (m) => {
      orig(m);
      if (m.t === "signal" && forwarded < cap) {
        forwarded += 1;
        to.transport.deliver({ t: "signal", from: from.client.selfId, data: m.data });
      }
    };
  };
  wire(a, b);
  wire(b, a);
  return () => forwarded;
}

function signalCount(): number {
  return [...win.transport.sent, ...mac.transport.sent].filter((m) => m.t === "signal").length;
}

describe("signaling negotiation terminates (no relay loop)", () => {
  it("exchanges a bounded offer/answer and then goes quiet", async () => {
    await win.start();
    await mac.start();
    win.addPeer(mac.client.selfId, "mac");
    mac.addPeer(win.client.selfId, "windows");
    bridgeSignals(win, mac);
    await win.settle();

    // offer + answer (+ a handful of candidates at most) — never a loop
    expect(signalCount()).toBeLessThanOrEqual(6);

    // and it STOPPED: a second settle adds nothing
    const before = signalCount();
    await win.settle();
    await mac.settle();
    expect(signalCount()).toBe(before);
  });
});
