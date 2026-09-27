// Ticket 04 / SECURITY-SPEC.md SEC-03 — inbound chat is bounded: per-message
// text truncated to the composer's outbound limit, retained timeline kept
// under a rolling cap (oldest dropped). Both apply to plaintext control
// frames regardless of the room key, so wrong-key members are equally bounded.
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { concatFrame, encoder, FRAME, type Control } from "./protocol";
import {
  createRoomHarness,
  installRoomClientStubs,
  IMPOLITE_PEER,
  type FakeDataChannel,
  type RoomHarness,
} from "./room-client.test-harness";
import { MAX_CHAT_CHARS, MAX_RETAINED_CHATS } from "./room-client";

let restoreStubs: () => void;
let h: RoomHarness;

beforeEach(() => {
  restoreStubs = installRoomClientStubs();
  h = createRoomHarness();
});

afterEach(() => {
  h.dispose();
  restoreStubs();
});

function chatFrame(id: string, text: string): Uint8Array {
  const c: Control = { t: "chat", id, text, at: Date.now() };
  return concatFrame(FRAME.CONTROL, encoder.encode(JSON.stringify(c)));
}

function deliverChat(ch: FakeDataChannel, id: string, text: string) {
  ch.receive(chatFrame(id, text));
}

function chats(): { id: string; text: string; mine: boolean }[] {
  return h.client.getSnapshot().chats.map((c) => ({ id: c.id, text: c.text, mine: c.mine }));
}

describe("chat timeline caps (SEC-03)", () => {
  it("stores oversized inbound text truncated; short messages unchanged", async () => {
    await h.start();
    const peer = h.addPeer(IMPOLITE_PEER);
    const ch = h.openChannel(peer);
    await h.flush();

    deliverChat(ch, "big", "A".repeat(MAX_CHAT_CHARS + 5000));
    deliverChat(ch, "short", "hello");
    await h.settle();

    const byId = new Map(chats().map((c) => [c.id, c.text]));
    expect(byId.get("big")).toHaveLength(MAX_CHAT_CHARS);
    expect(byId.get("short")).toBe("hello");
  });

  it("keeps the retained list at the rolling cap under sustained frames", async () => {
    await h.start();
    const peer = h.addPeer(IMPOLITE_PEER);
    const ch = h.openChannel(peer);
    await h.flush();

    for (let i = 0; i < MAX_RETAINED_CHATS + 50; i++) deliverChat(ch, `c${i}`, `msg ${i}`);
    await h.settle();

    const list = chats();
    expect(list.length).toBe(MAX_RETAINED_CHATS);
    // the OLDEST entries were dropped — the earliest surviving id is c50
    expect(list[0].id).toBe(`c${50}`);
    expect(list.at(-1)?.id).toBe(`c${MAX_RETAINED_CHATS + 49}`);
  });

  it("manual Clear empties the list and refill stays bounded", async () => {
    await h.start();
    const peer = h.addPeer(IMPOLITE_PEER);
    const ch = h.openChannel(peer);
    await h.flush();

    for (let i = 0; i < 30; i++) deliverChat(ch, `pre${i}`, `before ${i}`);
    await h.settle();
    expect(h.client.getSnapshot().chats.length).toBe(30);

    h.client.clearChat();
    await h.settle();
    expect(h.client.getSnapshot().chats).toEqual([]);

    for (let i = 0; i < MAX_RETAINED_CHATS + 10; i++) deliverChat(ch, `post${i}`, `after ${i}`);
    await h.settle();
    expect(h.client.getSnapshot().chats.length).toBe(MAX_RETAINED_CHATS);
    expect(h.client.getSnapshot().chats[0].id).toBe(`post${10}`);
  });

  it("bounds plaintext chat from a wrong-key peer in a keyed room identically", async () => {
    const restore = installRoomClientStubs();
    try {
      const keyed = createRoomHarness({ key: "another room key" });
      await keyed.start();
      const peer = keyed.addPeer(IMPOLITE_PEER);
      const ch = keyed.openChannel(peer);
      await keyed.flush();

      // a wrong-key member's frames arrive as PLAINTEXT control frames
      deliverChat(ch, "huge", "B".repeat(MAX_CHAT_CHARS * 2));
      await keyed.settle();
      expect(keyed.client.getSnapshot().chats.find((c) => c.id === "huge")?.text).toHaveLength(
        MAX_CHAT_CHARS,
      );

      for (let i = 0; i < MAX_RETAINED_CHATS + 25; i++) deliverChat(ch, `pk${i}`, `p ${i}`);
      await keyed.settle();

      const list = keyed.client.getSnapshot().chats;
      expect(list.length).toBe(MAX_RETAINED_CHATS);
      expect(list[0].id).toBe(`pk${25}`);
      keyed.dispose();
    } finally {
      restore();
    }
  });

  it("never truncates the sender's own outbound messages", async () => {
    await h.start();
    const peer = h.addPeer(IMPOLITE_PEER);
    h.openChannel(peer);
    await h.flush();

    h.client.sendChat("me".repeat(MAX_CHAT_CHARS)); // 2*8000 chars typed... composer clamps at 8000
    await h.settle();

    const mine = chats().find((c) => c.mine);
    expect(mine?.text).toHaveLength(MAX_CHAT_CHARS * 2); // outbound path untouched by the inbound cap
  });
});
