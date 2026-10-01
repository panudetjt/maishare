import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { addRecent, clearRecents, loadRecents, type Recent } from "./recents";

/** recents only uses getItem/setItem/removeItem — a Map shim is enough under
 * the node test environment */
function useMemoryStorage() {
  const map = new Map<string, string>();
  const shim = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
  globalThis.localStorage = shim as Storage;
}

beforeEach(useMemoryStorage);
afterEach(clearRecents);

describe("addRecent", () => {
  it("stores the room with its key at the front", () => {
    addRecent({ roomId: "aaa111", k: "k1", at: 1 });
    addRecent({ roomId: "bbb222", k: "k2", at: 2 });
    expect(loadRecents().map((r) => r.roomId)).toEqual(["bbb222", "aaa111"]);
    expect(loadRecents()[0].k).toBe("k2");
  });

  it("keeps the stored key when a revisit lands keyless (bare LAN link)", () => {
    addRecent({ roomId: "aaa111", k: "k1", at: 1 });
    addRecent({ roomId: "aaa111", at: 2 } as Recent);
    const [entry] = loadRecents();
    expect(entry.roomId).toBe("aaa111");
    expect(entry.k).toBe("k1");
  });

  it("lets a fresh invite replace the key", () => {
    addRecent({ roomId: "aaa111", k: "k1", at: 1 });
    addRecent({ roomId: "aaa111", k: "k2", at: 2 });
    expect(loadRecents()[0].k).toBe("k2");
  });

  it("does not invent a key for rooms this device never held one for", () => {
    addRecent({ roomId: "aaa111", at: 1 } as Recent);
    expect(loadRecents()[0].k).toBeUndefined();
  });

  it("keeps only the newest MAX entries", () => {
    for (let i = 0; i < 10; i++) {
      addRecent({ roomId: `room${i}`, at: i });
    }
    expect(loadRecents().map((r) => r.roomId)).toEqual([
      "room9",
      "room8",
      "room7",
      "room6",
      "room5",
      "room4",
      "room3",
      "room2",
    ]);
  });
});

describe("clearRecents", () => {
  it("removes every entry", () => {
    addRecent({ roomId: "aaa111", k: "k1", at: 1 });
    clearRecents();
    expect(loadRecents()).toEqual([]);
  });
});
