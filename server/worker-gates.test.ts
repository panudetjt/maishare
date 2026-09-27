// Tickets 12/13 + NV-04 fix — worker-level security gates driven with real
// Request objects:
// - NV-05: /ws upgrades are same-origin (or ALLOWED_ORIGINS) gated before the
//   DO; foreign/headerless upgrades get 403 and never touch the Room.
// - NV-06: SDP relayed to a peer we can't prove shares our network has its
//   internal-address candidates stripped (see server/sdp.test.ts for the
//   pure-helper table).
// - NV-04: a drained room's storage is fully reclaimed by the cleanup alarm.
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { Room, default as worker } from "./worker";
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
let env: DOEnv & {
  ALLOWED_ORIGINS?: string;
  RATE_LIMITER_WS?: { limit(opts: { key: string }): Promise<{ success: boolean }> };
  RATE_LIMITER_DISCOVER?: { limit(opts: { key: string }): Promise<{ success: boolean }> };
  deny?: boolean;
};
let roomFetches: number[];

beforeEach(() => {
  restores = [installWebSocketPair(), installResponse101()];
  state = new MockDOState();
  roomFetches = [];
  env = {
    // minimal namespace stub: the worker route resolves the DO then fetches it
    ROOM: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: () => (roomFetches.push(1), Promise.resolve(new Response("relayed"))),
      }),
    },
    LOBBY: new MockLobbyStub(),
    ASSETS: null,
  };
});

afterEach(() => {
  for (const r of restores) r();
  restores = [];
});

function upgrade(origin?: string, extra?: { key: string; value: string }[]): Request {
  const headers = new Headers({ Upgrade: "websocket", "CF-Connecting-IP": "203.0.113.10" });
  if (origin) headers.set("Origin", origin);
  for (const { key, value } of extra ?? []) headers.set(key, value);
  return new Request("https://maishare.test/ws?room=gate&peer=peer-gatetest01", {
    headers,
  });
}

describe("origin allowlist at /ws (NV-05 / ticket 12)", () => {
  it("refuses a foreign Origin with 403 before the DO is reached", async () => {
    const res = await worker.fetch(upgrade("https://evil.example"), env as unknown as never);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("origin not allowed");
    expect(roomFetches).toHaveLength(0);
    expect(state.sockets).toHaveLength(0);
  });

  it("refuses a headerless (non-browser) upgrade with 403", async () => {
    const res = await worker.fetch(upgrade(), env as unknown as never);
    expect(res.status).toBe(403);
    expect(roomFetches).toHaveLength(0);
  });

  it("forwards a same-origin upgrade to the Room DO", async () => {
    const res = await worker.fetch(upgrade("https://maishare.test"), env as unknown as never);
    expect(res.status).toBe(200); // the stub's relayed response
    expect(roomFetches).toHaveLength(1);
  });

  it("honors ALLOWED_ORIGINS for alternate hosts", async () => {
    env.ALLOWED_ORIGINS = "https://custom.example ,https://other.example";
    const res = await worker.fetch(upgrade("https://custom.example"), env as unknown as never);
    expect(res.status).toBe(200);
    expect(roomFetches).toHaveLength(1);
    const denied = await worker.fetch(
      upgrade("https://still-evil.example"),
      env as unknown as never,
    );
    expect(denied.status).toBe(403);
  });

  it("non-/ws paths are untouched by the gate", async () => {
    const res = await worker.fetch(
      new Request("https://maishare.test/healthz"),
      env as unknown as never,
    );
    expect(res.status).toBe(200);
  });
});

describe("SDP candidate filter at the relay (NV-06 / ticket 13)", () => {
  const OFFER = {
    type: "offer",
    sdp:
      "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n" +
      "a=candidate:1 1 udp 2130706431 127.0.0.1 55921 typ host\r\n" +
      "a=candidate:2 1 udp 2130706431 192.168.1.7 40000 typ host\r\n" +
      "a=candidate:3 1 udp 2130706431 203.0.113.9 50000 typ srflx\r\n",
  };

  async function relayedData(fromIp: string, toIp: string): Promise<{ data: { sdp: string } }> {
    // fresh DO per scenario: sender joins first, then the receiver
    const st = new MockDOState();
    const env2: DOEnv = { ROOM: null, LOBBY: new MockLobbyStub(), ASSETS: null };
    const room = new Room(st as unknown as DurableObjectState, env2 as unknown as never);
    const first = await room.fetch(
      joinRequest({ roomId: "rel", peerId: "peer-aaaaaaaaaaaa", ip: fromIp }),
    );
    expect(first.status).toBe(101);
    const second = await room.fetch(
      joinRequest({ roomId: "rel", peerId: "peer-bbbbbbbbbbbb", ip: toIp, name: "second" }),
    );
    expect(second.status).toBe(101);
    // the receiver (second socket) gets the sender's relayed signal
    st.sockets[1].sent.length = 0;
    await room.webSocketMessage(
      st.sockets[0] as unknown as WebSocket,
      JSON.stringify({ t: "signal", to: "peer-bbbbbbbbbbbb", data: OFFER }),
    );
    const relayed = JSON.parse(st.sockets[1].sent.at(-1)!) as { data: { sdp: string } };
    expect(relayed.data.sdp).toBeDefined();
    return relayed;
  }

  it("strips internal candidates between non-provable (public) peers", async () => {
    const { data } = await relayedData("203.0.113.7", "198.51.100.5");
    // only candidate LINES are filtered — assert on them, not the whole SDP
    // (the o= line legitimately carries 127.0.0.1)
    const candidates = data.sdp.match(/^a=candidate:.*/gm) ?? [];
    expect(candidates).toEqual(["a=candidate:3 1 udp 2130706431 203.0.113.9 50000 typ srflx"]);
    expect(data.sdp).toContain("v=0"); // structure intact
  });

  it("keeps internal candidates between provable-LAN peers (fix-safety)", async () => {
    const { data } = await relayedData("192.168.1.10", "192.168.1.44");
    expect(data.sdp).toContain("192.168.1.7");
    expect(data.sdp).toContain("127.0.0.1");
  });

  it("keeps internal candidates for the internal dev-marker peers (fix-safety)", async () => {
    const { data } = await relayedData("local", "local");
    expect(data.sdp).toContain("127.0.0.1");
  });
});

describe("rate limiting on floodable endpoints", () => {
  let calls: { key: string; requests?: number; period?: number }[];
  beforeEach(() => {
    calls = [];
    const limiter = {
      limit: async (opts: { key: string }) => {
        calls.push(opts);
        return { success: env.deny !== true };
      },
    };
    env.RATE_LIMITER_WS = limiter;
    env.RATE_LIMITER_DISCOVER = limiter;
  });

  it("checks /ws upgrades per client IP", async () => {
    const res = await worker.fetch(upgrade("https://maishare.test"), env as unknown as never);
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ key: "ws:203.0.113.10" }]);
  });

  it("returns 429 for /ws when the limiter denies", async () => {
    env.deny = true;
    const res = await worker.fetch(upgrade("https://maishare.test"), env as unknown as never);
    expect(res.status).toBe(429);
    expect(roomFetches).toHaveLength(0);
  });

  it("returns 429 for /api/discover when the limiter denies", async () => {
    env.deny = true;
    const res = await worker.fetch(
      new Request("https://maishare.test/api/discover", {
        headers: { "CF-Connecting-IP": "203.0.113.10" },
      }),
      env as unknown as never,
    );
    expect(res.status).toBe(429);
    expect(calls[0].key).toBe("discover:203.0.113.10");
  });

  it("fails open when the binding is missing or throws", async () => {
    delete env.RATE_LIMITER_WS;
    delete env.RATE_LIMITER_DISCOVER;
    env.RATE_LIMITER_WS = {
      limit: async () => {
        throw new Error("binding unavailable");
      },
    };
    const res = await worker.fetch(upgrade("https://maishare.test"), env as unknown as never);
    expect(res.status).toBe(200);
    const res2 = await worker.fetch(upgrade("https://maishare.test"), env as unknown as never);
    expect(res2.status).toBe(200); // fail open on a throwing binding
  });

  it("joinRequest default IP is used as the rate key", async () => {
    await worker.fetch(
      new Request("https://maishare.test/api/discover", {
        headers: { "CF-Connecting-IP": "203.0.113.10" },
      }),
      env as unknown as never,
    );
    expect(calls[0].key).toBe("discover:203.0.113.10");
  });
});

describe("drain cleanup reclaims all storage (NV-04)", () => {
  it("a drained room's storage is emptied by the grace alarm", async () => {
    restores.push(installWebSocketPair(), installResponse101());
    const room = new Room(state as unknown as DurableObjectState, env as unknown as never);
    const res = await room.fetch(joinRequest({ peerId: "peer-draincheck1", ip: "203.0.113.10" }));
    expect(res.status).toBe(101);
    expect(await state.storage.get("roomId")).toBe("test-room");

    state.sockets[0].close(1000, "bye"); // workerd drops closed sockets pre-close-event
    await room.webSocketClose(state.sockets[0] as unknown as WebSocket);
    expect(state.storage.alarm).not.toBeNull();

    await room.alarm(); // grace alarm fires
    expect((await state.storage.list()).size).toBe(0); // roomId + tokens gone

    // a fresh claim re-seeds storage and works
    const again = await room.fetch(joinRequest({ peerId: "peer-draincheck1", ip: "203.0.113.10" }));
    expect(again.status).toBe(101);
    expect(await state.storage.get("roomId")).toBe("test-room");
    expect(await state.storage.get("token:peer-draincheck1")).toBeTruthy();
  });
});
