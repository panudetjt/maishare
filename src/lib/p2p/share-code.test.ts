import { describe, expect, it } from "vite-plus/test";
import {
  MAX_INFLATED_BYTES,
  MAX_INPUT_CHARS,
  MAX_SDP_CHARS,
  packShareCode,
  unpackShareCode,
  type ShareCode,
} from "./share-code";

const offer: ShareCode = {
  type: "offer",
  sdp: "v=0\r\no=- 123 456 IN IP4 127.0.0.1\r\na=x-really-long-line:" + "y".repeat(900) + "\r\n",
  name: "swift otter",
};

describe("packShareCode / unpackShareCode", () => {
  it("round-trips an offer through the compressed format", async () => {
    const packed = await packShareCode(offer);
    expect(packed.startsWith("ms1z.")).toBe(true);
    const unpacked = await unpackShareCode(packed);
    expect(unpacked.type).toBe("offer");
    expect(unpacked.sdp).toBe(offer.sdp);
    expect(unpacked.name).toBe("swift otter");
  });

  it("compresses large SDPs well below QR capacity", async () => {
    const packed = await packShareCode(offer);
    // a QR can carry ~2953 bytes at the highest version, low ECC
    expect(packed.length).toBeLessThan(1600);
  });

  it("rejects garbage and foreign strings", async () => {
    await expect(unpackShareCode("hello world")).rejects.toThrow();
    await expect(unpackShareCode("ms1z.####")).rejects.toThrow();
    await expect(unpackShareCode("")).rejects.toThrow();
  });

  it("rejects structurally invalid payloads", async () => {
    const bogus = `ms1.${btoa(JSON.stringify({ v: 9, type: "offer", sdp: "v=0", name: "x" }))}`;
    await expect(unpackShareCode(bogus)).rejects.toThrow("invalid share code");
  });
});

// Ticket 09 / SECURITY-SPEC.md SEC-09 — the paste path is safe against
// decompression bombs: each rejection stage has its own distinct error and
// the caps sit far above real QR-sized codes and gathered SDPs.

describe("share-code caps (SEC-09)", () => {
  it("rejects over-length input before any decode or inflate", async () => {
    await expect(unpackShareCode("ms1z." + "A".repeat(MAX_INPUT_CHARS))).rejects.toThrow(
      "share code is too long",
    );
    // the uncompressed fallback branch honors the same input cap
    await expect(unpackShareCode("ms1." + "A".repeat(MAX_INPUT_CHARS + 1))).rejects.toThrow(
      "share code is too long",
    );
  });

  it("aborts inflation past the byte ceiling before it fully materializes", async () => {
    // ~600 KB of zeros compresses to a few hundred bytes — well under the
    // input cap, far over the inflated ceiling
    const bomb = await packShareCode({
      type: "offer",
      sdp: "v=0\r\n" + "0".repeat(MAX_INFLATED_BYTES + 100 * 1024),
      name: "bomber",
    });
    expect(bomb.length).toBeLessThan(MAX_INPUT_CHARS);
    await expect(unpackShareCode(bomb)).rejects.toThrow("share code is too large");
  });

  it("rejects an oversized SDP after parse with its own error", async () => {
    // compressible SDP that stays under both the input and inflate caps but
    // exceeds the accepted SDP length
    const big = await packShareCode({
      type: "offer",
      sdp: "v=0\r\na=" + "x".repeat(MAX_SDP_CHARS + 1024) + "\r\n",
      name: "swollen",
    });
    expect(big.length).toBeLessThan(MAX_INPUT_CHARS);
    await expect(unpackShareCode(big)).rejects.toThrow("share code SDP is too large");
  });

  it("keeps the existing corrupted/invalid messages intact", async () => {
    const bogus = `ms1.${btoa(JSON.stringify({ v: 9, type: "offer", sdp: "v=0", name: "x" }))}`;
    await expect(unpackShareCode(bogus)).rejects.toThrow("invalid share code");
    await expect(unpackShareCode("ms1.not-base64!!")).rejects.toThrow();
  });

  it("caps comfortably exceed real codes (fix-safety)", async () => {
    // real gathered SDPs and QR-bounded inputs must never trip any stage
    const packed = await packShareCode(offer);
    expect(packed.length).toBeLessThan(MAX_INPUT_CHARS);
    const unpacked = await unpackShareCode(packed);
    expect(unpacked.sdp).toBe(offer.sdp);
  });
});
