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

export type ShareKind = "file" | "clip";

export type Control =
  | { t: "hello"; name: string; platform: string }
  | { t: "chat"; id: string; text: string; at: number }
  | { t: "clip"; id: string; text: string; at: number }
  | { t: "file-start"; id: string; name: string; size: number; mime: string; kind: ShareKind }
  | { t: "file-end"; id: string }
  | { t: "file-cancel"; id: string; reason?: string }
  | { t: "ping"; at: number }
  | { t: "pong"; at: number }
  | { t: "bye" };

export function concatFrame(type: number, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(1 + payload.length);
  out[0] = type;
  out.set(payload, 1);
  return out;
}

export const encoder = new TextEncoder();
export const decoder = new TextDecoder();
