// SECURITY-SPEC.md SEC-11 — room host election and authority. The host is the
// longest-tenured member (server-side admission seq, kept across reconnects);
// the designation is server-elected and broadcast, never self-asserted. Only
// the host's kick removes a member ("keep them out"), the removed session's
// socket closes with 4403 and its ownership token blocks a same-id rejoin.
// The key-share policy ("host" | "anyone") is set once by the room creator.
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { Room } from "./worker";
import {
  installResponse101,
  installWebSocketPair,
  joinRequest,
  MockDOState,
  MockLobbyStub,
  MockSocket,
  type DOEnv,
} from "./room-do.test-harness";

let restores: (() => void)[] = [];
let state: MockDOState;
let env: DOEnv;
const HOST = "peer-aaaaaaaaaa";
const MEMBER = "peer-bbbbbbbbbb";
const LATE = "peer-cccccccccc";

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

function join(peerId: string, opts: { ks?: "anyone"; token?: string } = {}) {
  return room().fetch(joinRequest({ peerId, ip: "203.0.113.10", ...opts }));
}

function socket(i: number): MockSocket {
  return state.sockets[i];
}

function msgs(ws: MockSocket): { t: string; peerId?: string; host?: string; ks?: string }[] {
  return ws.sent.map((raw) => JSON.parse(raw));
}

/** the welcome this socket received (the last message is often a host broadcast) */
function welcome(ws: MockSocket): Record<string, unknown> {
  const w = msgs(ws).find((m) => m.t === "welcome");
  if (!w) throw new Error("no welcome delivered");
  return w;
}

async function send(ws: MockSocket, msg: unknown) {
  await room().webSocketMessage(ws as unknown as WebSocket, JSON.stringify(msg));
}

describe("host election (SEC-11)", () => {
  it("elects the first member and tells later joiners in the welcome", async () => {
    await join(HOST);
    await join(MEMBER);

    expect(welcome(socket(0)).host).toBe(HOST);
    expect(welcome(socket(1)).host).toBe(HOST);
  });

  it("re-elects the next-oldest member when the host leaves", async () => {
    await join(HOST);
    await join(MEMBER);
    await join(LATE);

    // the host drops
    socket(0).close(1000, "bye");
    await room().webSocketClose(socket(0) as unknown as WebSocket);

    const hostMsgs = msgs(socket(1)).filter((m) => m.t === "host");
    expect(hostMsgs.at(-1)).toMatchObject({ peerId: MEMBER });
    expect(await state.storage.get<string>("host")).toBe(MEMBER);

    // a fresh join learns the new host directly
    const id = state.sockets.length;
    await join("peer-dddddddddd");
    expect(welcome(socket(id)).host).toBe(MEMBER);
  });

  it("keeps the host designation across a reconnect (seq inheritance)", async () => {
    await join(HOST);
    await join(MEMBER);
    const token = welcome(socket(0)).token as string;

    // the host's socket drops and it rejoins with its token
    socket(0).close(1000, "bye");
    await room().webSocketClose(socket(0) as unknown as WebSocket);
    // member briefly becomes host
    expect(
      msgs(socket(1))
        .filter((m) => m.t === "host")
        .at(-1),
    ).toMatchObject({ peerId: MEMBER });

    await join(HOST, { token });
    // the rejoining host learns its designation from the welcome; the member
    // that briefly held the gavel is told of the change
    expect(welcome(socket(2)).host).toBe(HOST);
    expect(
      msgs(socket(1))
        .filter((m) => m.t === "host")
        .at(-1),
    ).toMatchObject({ peerId: HOST });
    expect(await state.storage.get<string>("host")).toBe(HOST);
  });
});

describe("host-only kick (SEC-11)", () => {
  it("lets the host remove a member: kicked notice, 4403 close, peer-leave", async () => {
    await join(HOST);
    await join(MEMBER);
    await join(LATE);

    await send(socket(0), { t: "kick", peerId: MEMBER });

    expect(socket(1).closed).toMatchObject({ code: 4403, reason: "kicked" });
    expect(msgs(socket(1)).some((m) => m.t === "kicked")).toBe(true);
    // workerd drops the socket before delivering the close — mirror it
    await room().webSocketClose(socket(1) as unknown as WebSocket);
    // the remaining members saw the removal as a normal leave; the host
    // designation itself did not change (no host broadcast expected)
    expect(msgs(socket(2)).some((m) => m.t === "peer-leave" && m.peerId === MEMBER)).toBe(true);
  });

  it("ignores a kick from anyone but the host", async () => {
    await join(HOST);
    await join(MEMBER);
    await join(LATE);

    await send(socket(1), { t: "kick", peerId: LATE }); // MEMBER is not the host
    expect(socket(2).closed).toBeNull();
    expect(msgs(socket(2)).some((m) => m.t === "kicked")).toBe(false);

    await send(socket(0), { t: "kick", peerId: HOST }); // self-kick is a no-op
    expect(socket(0).closed).toBeNull();
  });

  it("blocks a removed session from reclaiming its peer id", async () => {
    await join(HOST);
    await join(MEMBER);
    const memberToken = welcome(socket(1)).token as string;

    await send(socket(0), { t: "kick", peerId: MEMBER });
    expect(socket(1).closed).toMatchObject({ code: 4403 });

    // the kicked session retries with its still-valid token — refused by the
    // removal tombstone
    const res = await join(MEMBER, { token: memberToken });
    expect(res.status).toBe(410);
    await expect(res.text()).resolves.toContain("removed from this room");
  });
});

describe("key-share policy (SEC-11)", () => {
  it("defaults to host-only and ignores the opt-in from later joiners", async () => {
    await join(HOST);
    await join(MEMBER, { ks: "anyone" }); // not the creator — ignored

    expect(welcome(socket(0)).ks).toBe("host");
    expect(welcome(socket(1)).ks).toBe("host");
  });

  it("lets the room creator opt into any-member key shares", async () => {
    await join(HOST, { ks: "anyone" });
    await join(MEMBER);

    expect(welcome(socket(0)).ks).toBe("anyone");
    expect(welcome(socket(1)).ks).toBe("anyone"); // everyone learns the policy
  });

  it("keeps the policy across a reconnect and resets with the drained room", async () => {
    await join(HOST, { ks: "anyone" });
    const token = welcome(socket(0)).token as string;
    socket(0).close(1000, "bye");
    await room().webSocketClose(socket(0) as unknown as WebSocket);
    await join(HOST, { token, ks: undefined });
    expect(welcome(socket(1)).ks).toBe("anyone");

    // full drain wipes storage (existing alarm path) — a fresh room is host-only
    socket(1).close(1000, "bye");
    await room().webSocketClose(socket(1) as unknown as WebSocket);
    await room().alarm();
    await join("peer-dddddddddd", { ks: undefined });
    expect(welcome(socket(2)).ks).toBe("host");
  });
});
