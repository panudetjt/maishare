import { describe, expect, it } from "vite-plus/test";
import { buildTimeline, dayKeyOf, dayLabel, GROUP_GAP_MS } from "./timeline";
import type { ChatMsg, RoomState, TransferView } from "./p2p/room-client";

const SELF = "self-1";

function chat(id: string, at: number, text: string, mine = true, groupId?: string): ChatMsg {
  return { id, peerId: mine ? SELF : "peer-1", name: mine ? "me" : "ana", text, at, mine, groupId };
}

function transfer(id: string, at: number, over: Partial<TransferView> = {}): TransferView {
  return {
    id,
    dir: "out",
    peerId: SELF,
    peerName: "me",
    name: `${id}.txt`,
    size: 100,
    mime: "text/plain",
    status: "done",
    bytes: 100,
    speed: 0,
    at,
    groupId: `g-${id}`,
    ...over,
  };
}

function state(
  chats: ChatMsg[],
  transfers: TransferView[],
): Pick<RoomState, "chats" | "transfers" | "selfId"> {
  return { chats, transfers, selfId: SELF };
}

describe("buildTimeline", () => {
  it("merges chats and transfers chronologically", () => {
    const t = buildTimeline(
      state(
        [chat("c2", 2000, "second"), chat("c1", 1000, "first")],
        [transfer("t1", 1500)], // transfers are stored newest-first
      ),
    );
    expect(t.map((m) => m.id)).toEqual(["c1", "t1", "c2"]);
  });

  it("folds a text and its file batch into ONE message via groupId", () => {
    const t = buildTimeline(
      state(
        [chat("c1", 1000, "caption", true, "g1")],
        [
          transfer("f2", 1000, { groupId: "g1" }),
          transfer("f1", 1000, { groupId: "g1" }), // stored newest-first
        ],
      ),
    );
    expect(t).toHaveLength(1);
    expect(t[0].id).toBe("c1"); // stable identity comes from the text
    expect(t[0].text).toBe("caption");
    expect(t[0].files.map((f) => f.id)).toEqual(["f1", "f2"]); // send order kept
  });

  it("keeps a growing message stable as its files trickle in", () => {
    const withText = buildTimeline(state([chat("c1", 1000, "hi", true, "g1")], []));
    const withOneFile = buildTimeline(
      state([chat("c1", 1000, "hi", true, "g1")], [transfer("f1", 5000, { groupId: "g1" })]),
    );
    expect(withText[0].id).toBe(withOneFile[0].id);
    expect(withOneFile[0].files).toHaveLength(1);
    expect(withOneFile).toHaveLength(1); // no second message appeared
  });

  it("does not merge items from different groups", () => {
    const t = buildTimeline(
      state(
        [chat("c1", 1000, "one", true, "g1"), chat("c2", 1001, "two", true, "g2")],
        [transfer("f1", 1002, { groupId: "g1" })],
      ),
    );
    expect(t.map((m) => m.text ?? m.files[0]?.name)).toEqual(["one", "two"]);
    expect(t[0].files).toHaveLength(1);
    expect(t[1].files).toHaveLength(0);
  });

  it("groups consecutive messages from one author", () => {
    const t = buildTimeline(
      state(
        [chat("a1", 1000, "one", false), chat("a2", 2000, "two", false), chat("m1", 3000, "mine")],
        [],
      ),
    );
    expect(t.map((m) => m.firstOfGroup)).toEqual([true, false, true]);
  });

  it("splits a group after the gap window", () => {
    const t = buildTimeline(
      state(
        [chat("a1", 1000, "one", false), chat("a2", 1000 + GROUP_GAP_MS + 1, "two", false)],
        [],
      ),
    );
    expect(t[1].firstOfGroup).toBe(true);
  });

  it("inserts a day change even for the same author", () => {
    const day1 = new Date(2026, 5, 10, 23, 59).getTime();
    const day2 = new Date(2026, 5, 11, 0, 1).getTime();
    const t = buildTimeline(
      state([chat("a1", day1, "x", false), chat("a2", day2, "y", false)], []),
    );
    expect(t[1].firstOfDay).toBe(true);
    expect(t[1].firstOfGroup).toBe(true);
    expect(t[1].dayKey).not.toBe(t[0].dayKey);
  });

  it("marks mine for incoming transfers", () => {
    const t = buildTimeline(state([], [transfer("t1", 1), transfer("t2", 2, { dir: "in" })]));
    expect(t.map((m) => m.mine)).toEqual([true, false]);
  });
});

describe("dayKeyOf / dayLabel", () => {
  it("keys by local calendar date", () => {
    expect(dayKeyOf(new Date(2026, 5, 10, 23, 59).getTime())).toBe("2026-6-10");
  });

  it("labels today and yesterday", () => {
    const now = new Date(2026, 5, 10, 12, 0).getTime();
    expect(dayLabel(now, now)).toBe("Today");
    expect(dayLabel(now - 86_400_000, now)).toBe("Yesterday");
  });

  it("labels older days with a locale date", () => {
    const now = new Date(2026, 5, 10, 12, 0).getTime();
    expect(dayLabel(now - 8 * 86_400_000, now)).toMatch(/2026/);
  });
});
