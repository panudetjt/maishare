// Wire format for the RTCDataChannel. Every message is a single datagram:
//   [1 byte frame type][payload]
// Control frames are JSON. File chunks are raw bytes of the single active
// incoming/outgoing transfer on that connection (ordering is guaranteed by
// the reliable/ordered data channel). When a room key exists, payloads are
// AES-GCM sealed: [type][12-byte iv][ciphertext+16-byte tag].

export const FRAME = {
  CONTROL: 1,
  CONTROL_ENC: 2,
  CHUNK: 3,
  CHUNK_ENC: 4,
} as const;

/** type byte + 12-byte iv + 16-byte gcm tag */
export const ENC_OVERHEAD = 29;

export type Control =
  // `e2e` declares the sender's crypto capability (crypto.subtle needs a
  // secure context — iOS Safari joining over plain LAN http has none).
  // Receivers drop sealed frames they cannot open, so a sender must only
  // seal frames for peers that answered hello with e2e: true.
  | { t: "hello"; name: string; platform: string; e2e: boolean }
  // `g` ties a chat text to the file-start frames sent in the same message,
  // so both sides render text + attachments as one bubble
  | { t: "chat"; id: string; text: string; at: number; g?: string }
  // `g` groups files attached to the same message — the PhotoSwipe gallery
  // (swipe between them) is built from it on both sides
  | { t: "file-start"; id: string; name: string; size: number; mime: string; g: string }
  | { t: "file-end"; id: string }
  | { t: "file-cancel"; id: string; reason?: string }
  | { t: "ping"; at: number }
  | { t: "pong"; at: number }
  | { t: "bye" }
  /** receiver -> sender: a frame arrived that could not be read. Always sent
   * as a PLAIN control frame so the sender can parse it regardless of keys. */
  | { t: "undecryptable"; detail: "sealed" | "malformed" | "orphan" };

export function concatFrame(type: number, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(1 + payload.length);
  out[0] = type;
  out.set(payload, 1);
  return out;
}

export const encoder = new TextEncoder();
export const decoder = new TextDecoder();
