/**
 * Nearby share-code packing: WebRTC SDP is too large to QR directly, so the
 * offer/answer travels as `ms1z.<base64url(deflate-raw(json))>` (or
 * `ms1.<base64url(json)>` on the rare platform without CompressionStream).
 * A fixed prefix keeps versions distinguishable and garbage rejected.
 */

const PREFIX_COMPRESSED = "ms1z.";
const PREFIX_RAW = "ms1.";

// SEC-09 caps: a crafted ~100 KB paste must not be able to allocate hundreds
// of megabytes before validation rejects it. Real QR-bounded codes stay under
// ~3 KB of input and real gathered SDPs are a few KB, so these leave generous
// headroom (spec numbers: ≤ ~16 KB input, ≤ ~512 KB inflated).
export const MAX_INPUT_CHARS = 16 * 1024;
export const MAX_INFLATED_BYTES = 512 * 1024;
export const MAX_SDP_CHARS = 128 * 1024;

/** sentinel distinguishing a cap abort from other stream failures */
class InflateCapError extends Error {}

/**
 * Stream the inflation through a size-counting reader that aborts as soon as
 * the byte ceiling is exceeded — the expansion is never fully materialized.
 */
async function inflateCapped(bytes: Uint8Array): Promise<Uint8Array> {
  let total = 0;
  const counting = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctrl) {
      total += chunk.byteLength;
      if (total > MAX_INFLATED_BYTES) throw new InflateCapError("inflation exceeds cap");
      ctrl.enqueue(chunk);
    },
  });
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"))
    .pipeThrough(counting);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export interface ShareCode {
  type: "offer" | "answer";
  sdp: string;
  name: string;
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function packShareCode(code: ShareCode): Promise<string> {
  const json = JSON.stringify({ v: 1, ...code });
  if (typeof CompressionStream === "undefined") {
    return PREFIX_RAW + toBase64Url(new TextEncoder().encode(json));
  }
  return PREFIX_COMPRESSED + toBase64Url(await deflate(new TextEncoder().encode(json)));
}

export async function unpackShareCode(raw: string): Promise<ShareCode> {
  const s = raw.trim();
  // stage 1: input cap — rejected before any decode, inflate, or parse
  if (s.length > MAX_INPUT_CHARS) throw new Error("share code is too long");
  let bytes: Uint8Array;
  if (s.startsWith(PREFIX_COMPRESSED)) {
    try {
      bytes = await inflateCapped(fromBase64Url(s.slice(PREFIX_COMPRESSED.length)));
    } catch (err) {
      if (err instanceof InflateCapError) throw new Error("share code is too large");
      throw err;
    }
  } else if (s.startsWith(PREFIX_RAW)) bytes = fromBase64Url(s.slice(PREFIX_RAW.length));
  else throw new Error("not a maishare share code");
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("corrupted share code");
  }
  const obj = parsed as { v?: number; type?: string; sdp?: string; name?: string };
  if (
    obj?.v !== 1 ||
    (obj.type !== "offer" && obj.type !== "answer") ||
    typeof obj.sdp !== "string" ||
    typeof obj.name !== "string" ||
    obj.name.length > 32
  ) {
    throw new Error("invalid share code");
  }
  // stage 3: the accepted SDP is capped after parse (distinct error)
  if (obj.sdp.length > MAX_SDP_CHARS) throw new Error("share code SDP is too large");
  if (!obj.sdp.includes("v=0")) throw new Error("invalid share code");
  return { type: obj.type, sdp: obj.sdp, name: obj.name };
}
