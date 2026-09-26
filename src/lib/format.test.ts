import { describe, expect, it } from "vite-plus/test";
import { formatBytes, formatClock, formatSpeed } from "./format";

describe("formatBytes", () => {
  it("formats bytes and kilobytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
  });

  it("formats megabytes and gigabytes", () => {
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(3.5 * 1024 ** 3)).toBe("3.5 GB");
  });

  it("survives garbage input", () => {
    expect(formatBytes(Number.NaN)).toBe("—");
    expect(formatBytes(-1)).toBe("—");
  });
});

describe("formatSpeed", () => {
  it("renders a per-second rate", () => {
    expect(formatSpeed(1024 * 1024)).toBe("1.0 MB/s");
  });

  it("is empty for non-positive rates", () => {
    expect(formatSpeed(0)).toBe("");
  });
});

describe("formatClock", () => {
  it("zero-pads hours and minutes", () => {
    expect(formatClock(new Date(2026, 0, 1, 9, 5).getTime())).toBe("09:05");
  });
});
