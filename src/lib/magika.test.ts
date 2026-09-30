// Unit tests for the pure mime/extension logic plus a parity check that runs
// the real vendored Magika wasm (sync-initialized straight from the file) on
// real files — the model is content-driven, so signature-only stubs classify
// as "unknown".
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import {
  resolveMime,
  sniffBytes,
  sniffText,
  suspiciousMismatch,
  withDetectedExtension,
  type SniffInfo,
} from "./magika";
import { identify, initSync } from "../../vendor/katgpt-magika-wasm/katgpt_magika_wasm.js";

initSync({
  module: new Uint8Array(
    readFileSync(
      new URL("../../vendor/katgpt-magika-wasm/katgpt_magika_wasm_bg.wasm", import.meta.url),
    ),
  ),
});

function info(partial: Partial<SniffInfo>): SniffInfo {
  return {
    label: "txt",
    mime: "text/plain",
    group: "text",
    description: "Text",
    extensions: ["txt"],
    score: 1,
    isText: true,
    ...partial,
  };
}

describe("resolveMime", () => {
  it("keeps the claimed mime when nothing contradicts it", () => {
    const png = info({ label: "png", mime: "image/png", group: "image", isText: false });
    expect(resolveMime("image/png", png)).toBe("image/png");
  });

  it("fills in empty and generic claims from a confident sniff", () => {
    const png = info({ label: "png", mime: "image/png", group: "image", isText: false });
    expect(resolveMime("", png)).toBe("image/png");
    expect(resolveMime("application/octet-stream", png)).toBe("image/png");
    expect(resolveMime("text/plain", info({ label: "csv", mime: "text/csv" }))).toBe("text/csv");
  });

  it("falls back to the claimed mime on a low-confidence sniff", () => {
    const weak = info({ label: "png", mime: "image/png", score: 0.3, isText: false });
    expect(resolveMime("application/octet-stream", weak)).toBe("application/octet-stream");
    expect(resolveMime("", weak)).toBe("application/octet-stream");
  });

  it("overrides a specific claim only on a very confident contradiction", () => {
    const pdf = info({
      label: "pdf",
      mime: "application/pdf",
      group: "document",
      score: 0.99,
      isText: false,
    });
    expect(resolveMime("application/zip", pdf)).toBe("application/pdf");
    expect(resolveMime("application/zip", { ...pdf, score: 0.7 })).toBe("application/zip");
  });

  it("keeps the claimed mime when the sniff says unknown", () => {
    const unknown = info({ label: "unknown", mime: "", group: "unknown" });
    expect(resolveMime("image/png", unknown)).toBe("image/png");
    expect(resolveMime("", unknown)).toBe("application/octet-stream");
  });
});

describe("withDetectedExtension", () => {
  it("appends an extension when the name has none", () => {
    const pdf = info({
      label: "pdf",
      mime: "application/pdf",
      group: "document",
      description: "PDF",
      extensions: ["pdf"],
      isText: false,
    });
    expect(withDetectedExtension("invoice", pdf)).toBe("invoice.pdf");
  });

  it("replaces an extension the content contradicts", () => {
    const pdf = info({
      label: "pdf",
      mime: "application/pdf",
      group: "document",
      extensions: ["pdf"],
      isText: false,
    });
    expect(withDetectedExtension("notes.txt", pdf)).toBe("notes.pdf");
  });

  it("keeps names that already carry a canonical extension", () => {
    const jpg = info({
      label: "jpeg",
      mime: "image/jpeg",
      group: "image",
      extensions: ["jpg", "jpeg"],
      isText: false,
    });
    expect(withDetectedExtension("photo.jpeg", jpg)).toBe("photo.jpeg");
    expect(withDetectedExtension("photo.jpg", jpg)).toBe("photo.jpg");
  });

  it("never renames text formats — they are too ambiguous", () => {
    const py = info({
      label: "python",
      mime: "text/x-python",
      group: "code",
      extensions: ["py", "pyx"],
      isText: true,
    });
    expect(withDetectedExtension("script.txt", py)).toBe("script.txt");
  });

  it("passes through on weak sniffs, unknown labels, or no known extension", () => {
    const weak = info({ score: 0.4, extensions: ["pdf"], isText: false });
    const unknown = info({ label: "unknown", mime: "", extensions: [] });
    expect(withDetectedExtension("a.txt", weak)).toBe("a.txt");
    expect(withDetectedExtension("a.txt", unknown)).toBe("a.txt");
    expect(withDetectedExtension("a.txt", null)).toBe("a.txt");
  });
});

describe("suspiciousMismatch", () => {
  const exe = info({
    label: "pebin",
    mime: "application/vnd.microsoft.portable-executable",
    group: "executable",
    description: "Windows executable",
    extensions: ["exe", "dll"],
    isText: false,
  });

  it("warns when an executable hides behind an innocent name", () => {
    expect(suspiciousMismatch("holiday-photos.pdf", exe)).toContain("Windows executable");
  });

  it("stays quiet when the name is honest", () => {
    expect(suspiciousMismatch("setup.exe", exe)).toBeNull();
    expect(suspiciousMismatch("driver.dll", exe)).toBeNull();
  });

  it("stays quiet for weak sniffs and non-executable groups", () => {
    expect(suspiciousMismatch("a.pdf", { ...exe, score: 0.5 })).toBeNull();
    expect(suspiciousMismatch("a.pdf", { ...exe, group: "document" })).toBeNull();
  });
});

describe("magika wasm parity", () => {
  // real files, base64: a 1x1 PNG, a minimal PDF, a one-entry zip
  const b64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
  const PNG = b64(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGP4DwABAQEAsTj2FAAAAABJRU5ErkJggg==",
  );
  const PDF = b64(
    "JVBERi0xLjQKMSAwIG9iajw8L1R5cGUvQ2F0YWxvZy9QYWdlcyAyIDAgUj4+ZW5kb2JqCjIgMCBvYmo8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PmVuZG9iagozIDAgb2JqPDwvVHlwZS9QYWdlL1BhcmVudCAyIDAgUi9NZWRpYUJveFswIDAgNjEyIDc5Ml0+PmVuZG9iagp4cmVmCjAgNAp0cmFpbGVyPDwvU2l6ZSA0L1Jvb3QgMSAwIFI+PgolJUVPRg==",
  );
  const ZIP = b64(
    "UEsDBBQAAAAAAAmwOl2GphA2BQAAAAUAAAAFAAAAYS50eHRoZWxsb1BLAQIUAxQAAAAAAAmwOl2GphA2BQAAAAUAAAAFAAAAAAAAAAAAAACAAQAAAABhLnR4dFBLBQYAAAAAAQABADMAAAAoAAAAAAA=",
  );

  it("detects real files from raw bytes", async () => {
    const cases: [Uint8Array, string][] = [
      [PNG, "png"],
      [PDF, "pdf"],
      [ZIP, "zip"],
    ];
    for (const [bytes, label] of cases) {
      expect(identify(bytes).label).toBe(label);
      const sniffed = await sniffBytes(bytes);
      expect(sniffed?.label).toBe(label);
      expect(sniffed?.mime.endsWith(label)).toBe(true);
      expect(sniffed?.score).toBeGreaterThan(0.5);
    }
  });

  it("reports text files with isText and the text group", async () => {
    const sniffed = await sniffBytes(new TextEncoder().encode("just some plain words\n"));
    expect(sniffed?.label).toBe("txt");
    expect(sniffed?.isText).toBe(true);
    expect(sniffed?.group).toBe("text");
  });

  it("returns null for empty input instead of calling the model", async () => {
    expect(await sniffBytes(new Uint8Array(0))).toBeNull();
  });
});

describe("sniffText", () => {
  it("identifies pasted code through the async loader", async () => {
    const py = "def greet(name):\n    print(f\"hello {name}\")\n    return None\n\n\ngreet('x')\n";
    const sniffed = await sniffText(py);
    expect(sniffed?.label).toBe("python");
    expect(sniffed?.group).toBe("code");
  });

  it("skips the sniff for short or single-line chat", async () => {
    expect(await sniffText("x = 1")).toBeNull();
    expect(await sniffText("let x = 1; doSomethingWith(x); finishEverything();")).toBeNull();
    expect(await sniffText("tiny\nmsg")).toBeNull();
  });

  it("still classifies multi-line prose (as plain text, not code)", async () => {
    const chat = "เดี๋ยววันนี้เราคุยกันเรื่อง\nการ deploy ระบบใหม่ก่อนนะครับ\nแล้วค่อยไปดูบั๊กต่อ";
    const sniffed = await sniffText(chat);
    expect(sniffed?.group).not.toBe("code");
  });
});
