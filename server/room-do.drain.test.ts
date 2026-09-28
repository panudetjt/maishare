// Storage drain for probed empty rooms — the "smoke" instance question. Any
// room id can spawn a DO via a probe request (probes skip the token flow and
// the per-address cap), and the probe's admission writes the roomId row. If
// the prober's close did not arm the drain alarm, that row — and the DO
// instance — would linger forever, growing storage one instance at a time.
// Now: a probe leaving an EMPTY room arms the drain; a probe leaving a LIVE
// room must not (the members own that lifecycle).
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
const MEMBER = "peer-aaaaaaaaaa";
const PROBER = "probe-bbbbbbbbbb";

beforeEach(() => {
  restores = [installWebSocketPair(), installResponse101()];
  state = new MockDOState();
  env = { ROOM: null, LOBBY: new MockLobbyStub(), ASSETS: null };
});

afterEach(() => {
  for (const r of restores) r();
  restores = [];
});

function room(): Room {
  return new Room(state as unknown as DurableObjectState, env as unknown as never);
}

describe("drain after probed empty rooms", () => {
  it("a probe into an empty room arms the drain and the room fully self-cleans", async () => {
    const res = await room().fetch(
      joinRequest({ peerId: PROBER, ip: "203.0.113.10", probe: true }),
    );
    expect(res.status).toBe(101);
    const probe = state.sockets[0];
    expect(probe.lastMessage().t).toBe("probe-empty"); // nothing to verify against
    expect(await state.storage.get("roomId")).toBe("test-room"); // admission row exists

    // the prober closes — workerd drops the socket before the close event
    probe.close(1000, "bye");
    await room().webSocketClose(probe as unknown as WebSocket);

    // the drain alarm is armed at the grace horizon (60s — not the 30s heartbeat)
    expect(state.storage.alarm).not.toBeNull();
    expect(state.storage.alarm!).toBeGreaterThan(Date.now() + 45_000);

    // firing it reclaims everything — the leaked row is gone
    await room().alarm();
    expect(await state.storage.get("roomId")).toBeUndefined();
  });

  it("a probe leaving a LIVE room leaves the lifecycle to the members", async () => {
    await room().fetch(joinRequest({ peerId: MEMBER, ip: "203.0.113.10" }));
    await room().fetch(joinRequest({ peerId: PROBER, ip: "203.0.113.11", probe: true }));

    const probe = state.sockets[1];
    probe.close(1000, "bye");
    await room().webSocketClose(probe as unknown as WebSocket);

    // members present — no drain horizon was armed (only the member's own
    // 30s lobby heartbeat alarm exists)
    expect(state.storage.alarm).not.toBeNull();
    expect(state.storage.alarm!).toBeLessThan(Date.now() + 45_000);
    expect(await state.storage.get("roomId")).toBe("test-room");
  });
});
