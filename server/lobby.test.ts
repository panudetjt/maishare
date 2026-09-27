// Ticket 07 / SECURITY-SPEC.md SEC-07 — discovery discloses roster content
// (names, counts, creation time) only for topology-provable relations. A
// non-provable match (bare public-IP equality behind CGNAT) still lists the
// room id — the client's host-only probe needs it — with names/counts/since
// withheld. Roster content remains available to actual joiners via welcome.
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { Lobby } from "./worker";
import { installResponse101 } from "./room-do.test-harness";

let restores: (() => void)[] = [];

beforeEach(() => {
  restores = [installResponse101()];
});

afterEach(() => {
  for (const r of restores) r();
  restores = [];
});

const DISCOVER = "https://lobby/discover";

async function announce(roomId: string, ips: Record<string, number>, names: string[]) {
  const lobby = new Lobby();
  const res = await lobby.fetch(
    new Request("https://lobby/announce", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId, ips, names }),
    }),
  );
  expect(res.status).toBe(200);
  return lobby;
}

async function discover(
  lobby: Lobby,
  callerIp: string | null,
): Promise<{ rooms: Record<string, unknown>[] }> {
  // callerIp null = the deployment's own headerless internal call
  const headers: Record<string, string> = {};
  if (callerIp != null) headers["x-client-ip"] = callerIp;
  const res = await lobby.fetch(new Request(DISCOVER, { headers }));
  expect(res.status).toBe(200);
  return (await res.json()) as { rooms: Record<string, unknown>[] };
}

describe("discovery disclosure gating (SEC-07)", () => {
  it("gives a CGNAT public-IP match the room id only — roster content withheld", async () => {
    const lobby = await announce("cgroom", { "203.0.113.7": 2 }, ["alice", "bob"]);
    const data = await discover(lobby, "203.0.113.7");
    expect(data.rooms).toHaveLength(1);
    // the id survives (the host-only probe verifies it), nothing else
    expect(data.rooms[0]).toEqual({ roomId: "cgroom" });
  });

  it("keeps the full response for a provable private /24 match", async () => {
    const lobby = await announce("lanroom", { "192.168.1.10": 2 }, ["alice", "bob"]);
    const data = await discover(lobby, "192.168.1.44");
    expect(data.rooms).toHaveLength(1);
    expect(data.rooms[0]).toMatchObject({ roomId: "lanroom", people: 2, names: ["alice", "bob"] });
    expect(typeof data.rooms[0].since).toBe("number");
  });

  it("keeps the full response for a provable IPv6 /64 match", async () => {
    const lobby = await announce("v6room", { "2001:db8:1:2::15": 3 }, ["carol"]);
    const data = await discover(lobby, "2001:db8:1:2::99");
    expect(data.rooms[0]).toMatchObject({ roomId: "v6room", people: 3, names: ["carol"] });
  });

  it("keeps the full response for the internal dev-marker match", async () => {
    const lobby = await announce("devroom", { local: 1 }, ["dev"]);
    // the internal flow arrives headerless — a supplied 'local' string is an
    // external value and fails closed instead (covered by identity tests)
    const data = await discover(lobby, null);
    expect(data.rooms[0]).toMatchObject({ roomId: "devroom", names: ["dev"] });
  });

  it("returns nothing when no relation matches at all", async () => {
    const lobby = await announce("lanroom", { "192.168.1.10": 2 }, ["alice"]);
    const data = await discover(lobby, "203.0.113.7");
    expect(data.rooms).toEqual([]);
  });

  it("prefers disclosure when any member relation is provable", async () => {
    // mixed roster: one member shares the caller's LAN, another is a public relay
    const lobby = await announce("mixed", { "192.168.1.10": 1, "203.0.113.7": 1 }, ["alice"]);
    const data = await discover(lobby, "192.168.1.77");
    expect(data.rooms[0]).toMatchObject({ roomId: "mixed", names: ["alice"] });
  });
});
