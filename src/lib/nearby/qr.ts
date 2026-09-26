/**
 * Nearby share-code packing: WebRTC SDP is too large to QR directly, so the
 * offer/answer travels as `ms1z.<base64url(deflate-raw(json))>` (or
 * `ms1.<base64url(json)>` on the rare platform without CompressionStream).
 * A fixed prefix keeps versions distinguishable and garbage rejected.
 */

const PREFIX_COMPRESSED = "ms1z.";
const PREFIX_RAW = "ms1.";

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

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
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
  let bytes: Uint8Array;
  if (s.startsWith(PREFIX_COMPRESSED))
    bytes = await inflate(fromBase64Url(s.slice(PREFIX_COMPRESSED.length)));
  else if (s.startsWith(PREFIX_RAW)) bytes = fromBase64Url(s.slice(PREFIX_RAW.length));
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
    !obj.sdp.includes("v=0") ||
    typeof obj.name !== "string" ||
    obj.name.length > 32
  ) {
    throw new Error("invalid share code");
  }
  return { type: obj.type, sdp: obj.sdp, name: obj.name };
}
