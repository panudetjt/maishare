// Ticket 10 / SECURITY-SPEC.md SEC-10 — fail closed on untrusted network
// identity: only syntactically valid IPs become matchable identities at the
// two consumption points (signaling join and LAN discovery); the headerless
// internal fallback can never be supplied or matched by an external request.
// Plus a config assertion keeping dev/preview bound to localhost by default.
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { isValidIp } from "./lan";
import { Lobby } from "./worker";
import {
  installResponse101,
  installWebSocketPair,
  joinRequest,
  MockDOState,
  MockLobbyStub,
  type DOEnv,
} from "./room-do.test-harness";
import { Room } from "./worker";

let restores: (() => void)[] = [];
let state: MockDOState;
let env: DOEnv;

beforeEach(() => {
  restores = [installWebSocketPair(), installResponse101()];
  state = new MockDOState();
  env = { ROOM: null, LOBBY: new MockLobbyStub(), ASSETS: null };
});

afterEach(() => {
  for (const r of restores) r();
  restores = [];
});

describe("isValidIp (SEC-10)", () => {
  it("accepts valid IPv4 and IPv6", () => {
    expect(isValidIp("192.168.1.10")).toBe(true);
    expect(isValidIp("8.8.8.8")).toBe(true);
    expect(isValidIp("127.0.0.1")).toBe(true);
    expect(isValidIp("2001:db8:1:2::99")).toBe(true);
    expect(isValidIp("::1")).toBe(true);
    expect(isValidIp("::ffff:192.168.1.99")).toBe(true);
  });

  it("rejects arbitrary strings, the dev marker, and garbage", () => {
    expect(isValidIp("local")).toBe(false);
    expect(isValidIp("banana")).toBe(false);
    expect(isValidIp("")).toBe(false);
    expect(isValidIp("300.1.1.1")).toBe(false);
    expect(isValidIp("192.168.1")).toBe(false);
    expect(isValidIp("1:2:3:4:5:6:7:8:9")).toBe(false);
    expect(isValidIp(" drop table;")).toBe(false);
  });
});

describe("join identity fails closed (SEC-10)", () => {
  it("a non-IP forwarded header never becomes a matchable member identity", async () => {
    const room = new Room(state as unknown as DurableObjectState, env as unknown as never);
    // an external request supplying the dev marker (or any garbage) gets no identity
    const res = await room.fetch(joinRequest({ peerId: "peer-aaaaaaaaaaaa", ip: "local" }));
    expect(res.status).toBe(101); // the join itself still works
    // the lobby announcement carries no identity for that member
    const announce = env.LOBBY.announced.at(-1)!;
    expect(announce.ips).toEqual({});

    // garbage collapses the same way
    const res2 = await room.fetch(joinRequest({ peerId: "peer-bbbbbbbbbbbb", ip: "banana" }));
    expect(res2.status).toBe(101);
    expect(env.LOBBY.announced.at(-1)!.ips).toEqual({});
  });

  it("honest valid-IP identities are kept (fix-safety)", async () => {
    const room = new Room(state as unknown as DurableObjectState, env as unknown as never);
    await room.fetch(joinRequest({ peerId: "peer-cccccccccccc", ip: "203.0.113.10" }));
    expect(env.LOBBY.announced.at(-1)!.ips).toEqual({ "203.0.113.10": 1 });
  });

  it("the headerless internal dev flow still matches 'local' (fix-safety)", async () => {
    const room = new Room(state as unknown as DurableObjectState, env as unknown as never);
    // ip: null = header absent (workerd dev)
    await room.fetch(joinRequest({ peerId: "peer-dddddddddddd", ip: null }));
    expect(env.LOBBY.announced.at(-1)!.ips).toEqual({ local: 1 });
  });
});

describe("discovery identity fails closed (SEC-10)", () => {
  async function lobbyWith(ips: Record<string, number>): Promise<Lobby> {
    const lobby = new Lobby();
    await lobby.fetch(
      new Request("https://lobby/announce", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roomId: "devroom", ips, names: ["dev"] }),
      }),
    );
    return lobby;
  }

  async function discover(
    lobby: Lobby,
    header: string | null,
  ): Promise<{ rooms: { roomId: string }[] }> {
    const headers = new Headers();
    if (header !== null) headers.set("x-client-ip", header);
    const res = await lobby.fetch(new Request("https://lobby/discover", { headers }));
    return (await res.json()) as { rooms: { roomId: string }[] };
  }

  it("an external 'local' or arbitrary string matches nothing", async () => {
    // a dev room advertising the internal marker
    const lobby = await lobbyWith({ local: 1 });
    // external callers presenting the marker or garbage collapse to no identity
    expect((await discover(lobby, "local")).rooms).toEqual([]);
    expect((await discover(lobby, "banana")).rooms).toEqual([]);
    // even a room advertising a real IP can't be matched by garbage
    const real = await lobbyWith({ "203.0.113.10": 1 });
    expect((await discover(real, "banana")).rooms).toEqual([]);
  });

  it("honest valid-IP identities match exactly as before (fix-safety)", async () => {
    const lobby = await lobbyWith({ "203.0.113.10": 1 });
    const exact = await discover(lobby, "203.0.113.10");
    expect(exact.rooms).toEqual([{ roomId: "devroom" }]);
  });

  it("the internal headerless call keeps the dev-marker match (fix-safety)", async () => {
    const lobby = await lobbyWith({ local: 1 });
    // header absent = the deployment's own internal call; the local-local
    // relation is provable, so the full response comes back (fix-safety)
    const rooms = (await discover(lobby, null)).rooms;
    expect(rooms).toHaveLength(1);
    expect(rooms[0]).toMatchObject({ roomId: "devroom", names: ["dev"] });
  });
});
