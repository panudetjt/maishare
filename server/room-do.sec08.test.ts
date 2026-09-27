// Ticket 08 / SECURITY-SPEC.md SEC-08 — a member's peer identity is only
// reclaimable with the ownership token minted at first admission: the DO
// persists it in storage, delivers it in the welcome, stores it in the socket
// attachment; a token-less same-peer-id join is refused ("peer id in use") and
// the incumbent stays connected with truthful relay attribution. The signaling
// client remembers the token and re-presents it on every retry/reconnect.
// Tokens are deleted after the room drains, within the grace period.
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
const PEER = "peer-aaaaaaaaaaaa";

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

describe("peer-id ownership token (SEC-08)", () => {
  it("mints a token at first admission, delivers it in welcome, persists it", async () => {
    const res = await room().fetch(joinRequest({ peerId: PEER, ip: "203.0.113.10" }));
    expect(res.status).toBe(101);
    const ws = state.sockets[0];
    const welcome = ws.lastMessage();
    expect(welcome.t).toBe("welcome");
    expect(typeof welcome.token).toBe("string");
    expect((welcome.token as string).length).toBeGreaterThanOrEqual(21);
    // persisted in DO storage and mirrored in the socket attachment
    expect(await state.storage.get<string>(`token:${PEER}`)).toBe(welcome.token);
    expect((ws.attachment as { token?: string }).token).toBe(welcome.token);
  });

  it("refuses a token-less join on an in-use peer id; incumbent stays open", async () => {
    await room().fetch(joinRequest({ peerId: PEER, ip: "203.0.113.10" }));
    const incumbent = state.sockets[0];

    const res = await room().fetch(joinRequest({ peerId: PEER, ip: "203.0.113.99" }));
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("peer id in use");
    // the incumbent socket is untouched and still owns its identity
    expect(incumbent.closed).toBeNull();
    expect((incumbent.attachment as { ip?: string }).ip).toBe("203.0.113.10");
    // no eviction broadcast reached the room
    const joins = incumbent.sent.map((raw) => JSON.parse(raw) as { t: string });
    expect(joins.filter((m) => m.t === "peer-join")).toHaveLength(0);
  });

  it("refuses a join presenting a wrong token", async () => {
    await room().fetch(joinRequest({ peerId: PEER, ip: "203.0.113.10" }));
    const res = await room().fetch(
      joinRequest({ peerId: PEER, ip: "203.0.113.99", token: "forged-token-xyz" }),
    );
    expect(res.status).toBe(409);
  });

  it("replaces the socket exactly as before on a legitimate reconnect", async () => {
    await room().fetch(joinRequest({ peerId: PEER, ip: "203.0.113.10" }));
    const token = state.sockets[0].lastMessage().token as string;

    const res = await room().fetch(joinRequest({ peerId: PEER, ip: "203.0.113.10", token }));
    expect(res.status).toBe(101);
    // the incumbent was evicted with the documented "replaced" close
    expect(state.sockets[0].closed).toMatchObject({ code: 4000, reason: "replaced" });
    const welcome = state.sockets[1].lastMessage();
    expect(welcome.token).toBe(token); // same identity, same ownership
  });

  it("never lets a probe join evict a member", async () => {
    await room().fetch(joinRequest({ peerId: PEER, ip: "203.0.113.10" }));
    const incumbent = state.sockets[0];

    // a prober presenting a member's peer id (no token) is still just a probe
    const res = await room().fetch(joinRequest({ peerId: PEER, ip: "203.0.113.99", probe: true }));
    expect(res.status).toBe(101);
    expect(incumbent.closed).toBeNull();
    // and the probe got no welcome/eviction powers
    const msgs = state.sockets[1].sent.map((raw) => JSON.parse(raw) as { t: string });
    expect(msgs.some((m) => m.t === "welcome")).toBe(false);
  });

  it("persists tokens across a DO restart", async () => {
    await room().fetch(joinRequest({ peerId: PEER, ip: "203.0.113.10" }));
    const token = state.sockets[0].lastMessage().token as string;

    // a brand-new Room instance over the same storage = restarted DO
    const restarted = new Room(state as unknown as DurableObjectState, env as unknown as never);
    const res = await restarted.fetch(joinRequest({ peerId: PEER, ip: "203.0.113.10", token }));
    expect(res.status).toBe(101);
    const refused = await restarted.fetch(joinRequest({ peerId: PEER, ip: "203.0.113.10" }));
    expect(refused.status).toBe(409);
  });

  it("wipes tokens after the room drains and the grace period passes", async () => {
    await room().fetch(joinRequest({ peerId: PEER, ip: "203.0.113.10" }));
    // workerd closes the socket and drops it from the hibernation pool before
    // delivering webSocketClose — mirror that here
    state.sockets[0].close(1000, "bye");
    await room().webSocketClose(state.sockets[0] as unknown as WebSocket);

    // a cleanup alarm was scheduled for the grace horizon
    expect(state.storage.alarm).not.toBeNull();
    // firing it early (before the drain... roster is empty now) wipes tokens
    await room().alarm();
    expect(await state.storage.get(`token:${PEER}`)).toBeUndefined();

    // a fresh claim works afterwards
    const res = await room().fetch(joinRequest({ peerId: PEER, ip: "203.0.113.10" }));
    expect(res.status).toBe(101);
    const fresh = state.sockets.at(-1)!.lastMessage().token as string;
    const stored = await state.storage.get<string>(`token:${PEER}`);
    expect(stored).toBe(fresh);
  });
});
