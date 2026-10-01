import { describe, expect, it } from "vite-plus/test";
import { keyFromHash, roomInvitePath } from "./invite";

describe("roomInvitePath", () => {
  it("rides the key in the #k= fragment", () => {
    expect(roomInvitePath("abc123", "key")).toBe("/r/abc123#k=key");
    expect(roomInvitePath("abc123", "a+b/c=d")).toBe("/r/abc123#k=a%2Bb%2Fc%3Dd");
  });

  it("links the bare room URL when keyless (SEC-11 LAN join)", () => {
    expect(roomInvitePath("abc123")).toBe("/r/abc123");
    expect(roomInvitePath("abc123", undefined)).toBe("/r/abc123");
  });
});

describe("keyFromHash", () => {
  it("reads a normal #k= fragment", () => {
    expect(keyFromHash("#k=abc123")).toBe("abc123");
  });

  it("heals the double-# corruption of the old recents navigation", () => {
    expect(keyFromHash("##k=abc123")).toBe("abc123");
  });

  it("round-trips keys built by roomInvitePath", () => {
    const key = "a+b/c=d";
    const raw = roomInvitePath("abc123", key).split("#")[1];
    expect(keyFromHash(raw)).toBe(key);
  });

  it("returns undefined without a k param", () => {
    expect(keyFromHash("")).toBeUndefined();
    expect(keyFromHash(undefined)).toBeUndefined();
    expect(keyFromHash("#")).toBeUndefined();
    expect(keyFromHash("#name=x")).toBeUndefined();
    expect(keyFromHash("#k=")).toBeUndefined();
  });
});
