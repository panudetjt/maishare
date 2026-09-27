// Ticket 06 / SECURITY-SPEC.md SEC-05 (server half) — the Room DO rejects
// non-probe joins beyond the room-size cap and the per-address membership cap
// before accepting the WebSocket, so each join's roster-broadcast fan-out is
// bounded. Probe joins remain exempt (bounded separately by the client).
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { Room } from "./worker";
import {
  installResponse101,
  installWebSocketPair,
  joinRequest,
  MockDOState,
  MockLobbyStub,
  pid,
  type DOEnv,
} from "./room-do.test-harness";

let state: MockDOState;
let env: DOEnv;
let restores: (() => void)[] = [];

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

async function join(peerId: string, ip: string): Promise<Response> {
  return room().fetch(joinRequest({ peerId, ip }));
}

describe("Room DO join caps (SEC-05)", () => {
  it("refuses joins beyond the room-size cap with 429 before any upgrade", async () => {
    for (let i = 0; i < 16; i++) {
      const res = await join(pid(i), `10.0.0.${i + 1}`);
      expect(res.status).toBe(101);
    }
    expect(state.sockets).toHaveLength(16);

    // the 17th join is refused before a socket exists
    const res = await join(pid(16), "10.0.1.1");
    expect(res.status).toBe(429);
    expect(state.sockets).toHaveLength(16);
    // and no roster broadcast went out for the refused join
    const joins = state.sockets
      .flatMap((s) => s.sent.map((raw) => JSON.parse(raw) as { t?: string; peerId?: string }))
      .filter((m) => m.t === "peer-join");
    expect(joins.some((m) => m.peerId === pid(16))).toBe(false);
  });

  it("refuses joins beyond the per-address membership cap with 429", async () => {
    // 8 members share one address (one NAT edge)
    for (let i = 0; i < 8; i++) {
      const res = await join(pid(i), "203.0.113.10");
      expect(res.status).toBe(101);
    }
    // the 9th from that address is refused
    const res = await join(pid(8), "203.0.113.10");
    expect(res.status).toBe(429);
    // another address still fits under the room cap
    const other = await join(pid(9), "203.0.113.11");
    expect(other.status).toBe(101);
  });

  it("probe joins remain exempt from both caps", async () => {
    for (let i = 0; i < 8; i++) {
      await join(pid(i), "203.0.113.10"); // same address — per-address cap reached
    }
    // a probe from that address is still accepted: the early probe path runs
    // before the caps
    const probe = await room().fetch(
      joinRequest({ peerId: "probe-123456", ip: "203.0.113.10", probe: true }),
    );
    expect(probe.status).toBe(101);
  });

  it("roster broadcasts stay within the cap (welcome never lists more)", async () => {
    for (let i = 0; i < 16; i++) await join(pid(i), `10.0.0.${i + 1}`);
    const last = state.sockets.at(-1)!;
    const welcome = last.lastMessage();
    expect(welcome.t).toBe("welcome");
    expect((welcome.peers as unknown[]).length).toBe(15); // everyone but self
  });
});
