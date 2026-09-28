// SECURITY-SPEC.md SEC-12 — per-connection signaling flood cap. The WS
// upgrade is edge-rate-limited per IP, but messages inside one connection
// used to be unbounded while each one wakes the DO (a billable invocation).
// A token bucket per socket now bounds the relay: legitimate bursts (a
// 16-member join storm) fit the capacity, sustained floods close the socket
// with 4409 before any parsing work is spent on them.
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { Room } from "./worker";
import {
  installResponse101,
  installWebSocketPair,
  joinRequest,
  MockDOState,
  MockLobbyStub,
  type DOEnv,
} from "./room-do.test-harness";

let restores: (() => void)[] = [];
let state: MockDOState;
let env: DOEnv;
const HOST = "peer-aaaaaaaaaa";
const MEMBER = "peer-bbbbbbbbbb";

beforeEach(() => {
  restores = [installWebSocketPair(), installResponse101()];
  state = new MockDOState();
  env = { ROOM: null, LOBBY: new MockLobbyStub(), ASSETS: null };
  doRoom = new Room(state as unknown as DurableObjectState, env as unknown as never);
});

afterEach(() => {
  for (const r of restores) r();
  restores = [];
});

/** ONE Room instance per test — the flood bucket lives in instance memory,
 * exactly like a live DO that handles every message of a connection */
let doRoom: Room;
function room(): Room {
  return doRoom;
}

function socket(i: number) {
  return state.sockets[i];
}

async function send(ws: (typeof state.sockets)[number], msg: unknown) {
  await room().webSocketMessage(ws as unknown as WebSocket, JSON.stringify(msg));
}

describe("signaling flood cap (SEC-12)", () => {
  it("accepts a legitimate join-storm-sized burst without closing", async () => {
    await room().fetch(joinRequest({ peerId: HOST, ip: "203.0.113.10" }));
    await room().fetch(joinRequest({ peerId: MEMBER, ip: "203.0.113.11" }));

    // ~100 messages: the worst realistic mesh burst (16 members × ~6 frames)
    for (let i = 0; i < 100; i++) {
      await send(socket(1), { t: "signal", to: HOST, data: { candidate: `c${i}` } });
    }
    expect(socket(1).closed).toBeNull();
    // and the relay actually worked
    const relayed = socket(0).sent.filter((raw) => raw.includes("candidate"));
    expect(relayed.length).toBe(100);
  });

  it("closes a sustained flood with 4409 once the bucket and violations run out", async () => {
    await room().fetch(joinRequest({ peerId: HOST, ip: "203.0.113.10" }));
    await room().fetch(joinRequest({ peerId: MEMBER, ip: "203.0.113.11" }));

    // capacity 200 + 50 tolerated violations closes the socket after the
    // first ~250 over-budget messages (a little refill sneaks in while the
    // loop runs, so a generous 1000-message cap bounds the test)
    for (let i = 0; i < 1000 && socket(1).closed === null; i++) {
      await send(socket(1), { t: "signal", to: HOST, data: { candidate: `flood-${i}` } });
    }
    expect(socket(1).closed).toMatchObject({ code: 4409, reason: "flood" });
  });

  it("caps each socket independently — the flood does not touch other members", async () => {
    await room().fetch(joinRequest({ peerId: HOST, ip: "203.0.113.10" }));
    await room().fetch(joinRequest({ peerId: MEMBER, ip: "203.0.113.11" }));
    await room().fetch(joinRequest({ peerId: "peer-cccccccccc", ip: "203.0.113.12" }));

    for (let i = 0; i < 1000 && socket(1).closed === null; i++) {
      await send(socket(1), { t: "signal", to: HOST, data: { candidate: `flood-${i}` } });
    }
    expect(socket(1).closed).toMatchObject({ code: 4409 });
    // the host and the third member never sent enough to trip the bucket
    expect(socket(0).closed).toBeNull();
    expect(socket(2).closed).toBeNull();
  });

  it("a full bucket clears past violations — burst, pause pattern stays open", async () => {
    await room().fetch(joinRequest({ peerId: HOST, ip: "203.0.113.10" }));
    await room().fetch(joinRequest({ peerId: MEMBER, ip: "203.0.113.11" }));

    // burn most of the bucket
    for (let i = 0; i < 100; i++) {
      await send(socket(1), { t: "signal", to: HOST, data: { candidate: `c${i}` } });
    }
    expect(socket(1).closed).toBeNull();

    // real time passes between test steps; the refill refills the bucket and
    // a full bucket wipes accumulated violations — the socket stays usable
    await new Promise((r) => setTimeout(r, 60));
    for (let i = 0; i < 100; i++) {
      await send(socket(1), { t: "signal", to: HOST, data: { candidate: `d${i}` } });
    }
    expect(socket(1).closed).toBeNull();
  });
});
