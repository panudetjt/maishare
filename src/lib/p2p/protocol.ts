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
  // seal frames for peers that answered hello with e2e: true. `keyed` says
  // the sender holds the room key, so a keyless joiner knows it can ask for
  // a share (the LAN-list join path lands with no key at all).
  | { t: "hello"; name: string; platform: string; e2e: boolean; keyed?: boolean }
  // `g` ties a chat text to the file-start frames sent in the same message,
  // so both sides render text + attachments as one bubble
  | { t: "chat"; id: string; text: string; at: number; g?: string }
  // `g` groups files attached to the same message — the PhotoSwipe gallery
  // (swipe between them) is built from it on both sides
  | { t: "file-start"; id: string; name: string; size: number; mime: string; g: string }
  // sent for every file of a message as soon as it is queued on the sender —
  // before any byte moves — so the receiver renders the whole queue up front
  // and never mistakes the first finished file for the end of the transfer.
  // Purely informational: the transfer itself still begins with file-start,
  // which promotes the previewed entry in place (an older receiver ignores
  // this frame and behaves exactly as before).
  | { t: "file-queued"; id: string; name: string; size: number; mime: string; g: string }
  | { t: "file-end"; id: string }
  | { t: "file-cancel"; id: string; reason?: string }
  // key-proof exchange (SEC-01): the challenger seals a ping carrying a nonce
  // `n`; only a key holder can answer with a sealed pong echoing it. Ordinary
  // heartbeat ping/pong frames carry no nonce and stay unsealed.
  | { t: "ping"; at: number; n?: string }
  | { t: "pong"; at: number; n?: string }
  | { t: "bye" }
  // key share for keyless joiners (LAN-list joins land without #k=): the
  // joiner asks once per connection and the member's approval gate decides.
  // Both frames are PLAIN on the wire — the joiner cannot open sealed frames
  // yet; the DTLS-encrypted data channel is the transport protection, and a
  // human explicitly approves the share (same posture as consent downgrade).
  | { t: "key-request" }
  | { t: "key-offer"; k: string }
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
