// Content-type sniffing with Magika (vendored WASM build of katgpt-magika-wasm,
// an independent pure-Rust no_std rewrite of Magika — not Google's official
// ONNX implementation; see vendor/katgpt-magika-wasm/PROVENANCE.md). maishare
// otherwise trusts the browser's extension-derived file.type, which is empty
// or wrong for extension-less drops and for anything a peer mislabels.
//
// The 3.1 MB wasm loads lazily on the first sniff and stays a separate chunk —
// never part of the initial bundle. Every helper degrades to null/no-op so a
// failed or unsupported wasm load falls back to the browser's mime.

/** how much of a file/blob head to read for detection — the model consumes
 * only the first/last 256 meaningful bytes, so this is generous headroom */
const HEAD_BYTES = 64 * 1024;
/** below this the model's answer is treated as a guess, not a fact */
const MIN_SCORE = 0.5;
/** score at which a sniff may override a specific browser-claimed mime */
const OVERRIDE_SCORE = 0.9;

/** mimes that carry no real signal (empty, or extension-agnostic defaults) */
const GENERIC_MIMES = new Set(["", "application/octet-stream", "text/plain"]);

export interface SniffInfo {
  /** canonical label, e.g. "pdf", "png", "python", "unknown" */
  label: string;
  /** official mime type, e.g. "application/pdf" */
  mime: string;
  /** high-level group: image/video/audio/document/archive/code/executable/… */
  group: string;
  /** human-readable description, e.g. "Portable Document Format" */
  description: string;
  /** canonical extensions for the label, e.g. ["jpg", "jpeg"] */
  extensions: string[];
  score: number;
  isText: boolean;
}

type MagikaModule = typeof import("../../vendor/katgpt-magika-wasm/katgpt_magika_wasm.js");

let loading: Promise<MagikaModule | null> | null = null;

function loadMagika(): Promise<MagikaModule | null> {
  loading ??= (async () => {
    try {
      const mod = await import("../../vendor/katgpt-magika-wasm/katgpt_magika_wasm.js");
      const { default: wasmUrl } =
        await import("../../vendor/katgpt-magika-wasm/katgpt_magika_wasm_bg.wasm?url");
      await mod.default(wasmUrl);
      return mod;
    } catch (err) {
      console.warn("magika wasm unavailable — keeping browser-derived mime", err);
      return null;
    }
  })();
  return loading;
}

/** identify a bounded head slice of raw bytes; null when wasm is unavailable */
export async function sniffBytes(bytes: Uint8Array): Promise<SniffInfo | null> {
  if (!bytes.length) return null;
  const mod = await loadMagika();
  if (!mod) return null;
  try {
    const r = mod.identify(bytes);
    const info: SniffInfo = {
      label: r.label,
      mime: r.mime_type,
      group: r.group,
      description: r.description,
      extensions: r.extensions
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      score: r.score,
      isText: r.is_text,
    };
    r.free();
    return info;
  } catch (err) {
    console.warn("magika identify failed", err);
    return null;
  }
}

/** read at most HEAD_BYTES of a blob and identify it */
export async function sniffBlob(blob: Blob): Promise<SniffInfo | null> {
  const head = await blob.slice(0, HEAD_BYTES).arrayBuffer();
  return sniffBytes(new Uint8Array(head));
}

/**
 * The mime to actually use: browser-claimed type refined by content. A
 * confident sniff fills in generic/empty claims; a very confident one
 * overrides a specific claim that contradicts the bytes.
 */
export function resolveMime(browserMime: string, sniff: SniffInfo | null): string {
  const claimed = (browserMime || "").toLowerCase();
  if (!sniff || sniff.label === "unknown") return claimed || "application/octet-stream";
  if (GENERIC_MIMES.has(claimed)) {
    return sniff.score >= MIN_SCORE ? sniff.mime : claimed || "application/octet-stream";
  }
  if (sniff.score >= OVERRIDE_SCORE && sniff.mime !== claimed) return sniff.mime;
  return claimed;
}

function extOf(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null; // no extension, or a dotfile like .gitignore
  const ext = name.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,10}$/.test(ext) ? ext : null;
}

/**
 * Download name fixed up from detected content: appends an extension when the
 * name has none and replaces one the content contradicts (a "notes.txt" that
 * is really a PDF). Text formats are ambiguous (csv/txt/log…), so they never
 * rename — only confident binary detections do.
 */
export function withDetectedExtension(name: string, sniff: SniffInfo | null | undefined): string {
  if (
    !sniff ||
    sniff.score < OVERRIDE_SCORE ||
    sniff.label === "unknown" ||
    !sniff.extensions.length
  )
    return name;
  const current = extOf(name);
  if (current) {
    if (sniff.extensions.includes(current) || sniff.isText) return name;
    return `${name.slice(0, name.length - current.length - 1)}.${sniff.extensions[0]}`;
  }
  return `${name}.${sniff.extensions[0]}`;
}

/**
 * The one mismatch worth interrupting the user for: bytes that behave like a
 * program while the name claims otherwise. Returns a warning message or null.
 */
export function suspiciousMismatch(name: string, sniff: SniffInfo): string | null {
  if (sniff.score < OVERRIDE_SCORE || sniff.group !== "executable") return null;
  const current = extOf(name);
  if (current && sniff.extensions.includes(current)) return null;
  return `⚠︎ "${name}" is actually ${sniff.description || sniff.label} despite its name — be careful before opening it`;
}
