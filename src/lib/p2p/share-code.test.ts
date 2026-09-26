import { describe, expect, it } from "vite-plus/test";
import { packShareCode, unpackShareCode, type ShareCode } from "./share-code";

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
