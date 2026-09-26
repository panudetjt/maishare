import { describe, expect, it } from "vite-plus/test";
import { uuid, uuidFromRandomValues } from "./device";

const V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("uuid", () => {
  it("produces valid v4 UUIDs", () => {
    for (let i = 0; i < 100; i++) {
      expect(uuid()).toMatch(V4_RE);
    }
  });

  it("is unique across many draws", () => {
    const seen = new Set(Array.from({ length: 1000 }, () => uuid()));
    expect(seen.size).toBe(1000);
  });

  it("builds valid UUIDs from raw bytes (insecure-context fallback)", () => {
    const bytes = new Uint8Array(16).fill(0xff);
    const id = uuidFromRandomValues(bytes);
    expect(id).toMatch(V4_RE);
    // version and variant bits were carved out of the 0xff bytes
    expect(id).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
    expect(uuidFromRandomValues(new Uint8Array(16).fill(0))).toBe(
      "00000000-0000-4000-8000-000000000000",
    );
  });
});
