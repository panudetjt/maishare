import { describe, expect, it } from "vite-plus/test";
import { concatFrame, decoder, ENC_OVERHEAD, FRAME } from "./protocol";

describe("concatFrame", () => {
  it("prefixes the payload with the frame type byte", () => {
    const payload = new TextEncoder().encode('{"t":"ping"}');
    const frame = concatFrame(FRAME.CONTROL, payload);
    expect(frame[0]).toBe(FRAME.CONTROL);
    expect(frame.length).toBe(payload.length + 1);
    expect(decoder.decode(frame.subarray(1))).toBe('{"t":"ping"}');
  });

  it("keeps an empty payload frame valid", () => {
    const frame = concatFrame(FRAME.CHUNK, new Uint8Array());
    expect(frame.length).toBe(1);
    expect(frame[0]).toBe(FRAME.CHUNK);
  });
});

describe("encryption overhead", () => {
  it("matches the aes-gcm framing (type byte + 12-byte iv + 16-byte tag)", () => {
    expect(ENC_OVERHEAD).toBe(29);
  });
});
