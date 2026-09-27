// WebMCP (draft W3C Web Machine Learning CG — document.modelContext) lets
// this page act as an MCP server for in-browser agents: instead of scraping
// the DOM or reimplementing the wire protocol, an agent calls the room's
// real pipeline through stable tools. Tools execute inside the page that
// already holds the room key, so end-to-end encryption, consent gating and
// queue-until-peer-joins all apply exactly as they do for the human user —
// the agent never sees the key or the protocol.
import { MAX_TRANSFER_SIZE, type RoomClient } from "./room-client";

/** the draft's imperative surface, kept local so the spec can move without
 * dragging a dependency behind it; Chrome ships it behind an origin trial */
export interface WebMcpTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    /** status tools only observe — they never touch the pipeline */
    readOnlyHint?: boolean;
    /** send tools move data to peers under the user's room identity */
    consequentialHint?: boolean;
  };
  execute: (input: Record<string, unknown>) => unknown;
}

export interface ModelContextLike {
  registerTool(tool: WebMcpTool, options?: { signal?: AbortSignal }): Promise<void> | void;
}

/** one file being assembled from tool calls — chunked because draft tool
 * inputs are JSON and the spec advises input-length limits */
interface FileUpload {
  name: string;
  mime: string;
  size: number;
  nextSeq: number;
  /** ArrayBuffer-backed so the assembled File accepts them as BlobParts */
  parts: Uint8Array<ArrayBuffer>[];
  received: number;
}

/** raw bytes per send_file call advertised to agents — small enough for any
 * JSON argument budget, large enough that a 15 MB video is ~30 calls */
export const WEBMCP_CHUNK_GUIDE_BYTES = 512 * 1024;

function decodeBase64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const u8 = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

/**
 * Register the room toolset on `modelContext` (defaults to
 * document.modelContext when the page runs in a browser that has it).
 * Returns a dispose function, or undefined when the API is absent — callers
 * treat that as a silent no-op so the feature costs nothing elsewhere.
 */
export function registerRoomTools(
  client: RoomClient,
  modelContext?: ModelContextLike,
): (() => void) | undefined {
  const mc =
    modelContext ??
    (typeof document === "undefined"
      ? undefined
      : (document as Document & { modelContext?: ModelContextLike }).modelContext);
  if (!mc?.registerTool) return undefined;

  const uploads = new Map<string, FileUpload>();
  const unregister = new AbortController();

  const openPeerCount = () => client.getSnapshot().peers.filter((p) => p.status === "open").length;

  void mc.registerTool(
    {
      name: "maishare_room_status",
      title: "Room status",
      description:
        "Read-only snapshot of this maishare room: connection state, whether chats are end-to-end encrypted, and the peers currently connected.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      execute: () => {
        const s = client.getSnapshot();
        return {
          roomId: s.roomId,
          selfName: s.selfName,
          encrypted: s.encrypted,
          signalStatus: s.signalStatus,
          openPeerCount: openPeerCount(),
          peers: s.peers.map((p) => ({ name: p.name, status: p.status, rttMs: p.rtt })),
        };
      },
    },
    { signal: unregister.signal },
  );

  void mc.registerTool(
    {
      name: "maishare_send_message",
      title: "Send chat message",
      description:
        "Send a chat message to the room under the user's identity. With no peer connected yet the message is queued and delivers automatically when someone joins.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string", description: "message body" } },
        required: ["text"],
        additionalProperties: false,
      },
      annotations: { consequentialHint: true },
      execute: (input) => {
        const text = typeof input.text === "string" ? input.text.trim() : "";
        if (!text) throw new Error("send_message: text is required");
        client.sendMessage(text, []);
        return { sent: true, openPeerCount: openPeerCount() };
      },
    },
    { signal: unregister.signal },
  );

  void mc.registerTool(
    {
      name: "maishare_send_file",
      title: "Send file (chunked)",
      description:
        "Send a file to the room by uploading it in ordered chunks. Call with seq=0 first; keep calling with incrementing seq; set final=true on the last chunk to flush it through the room's normal transfer pipeline. Send at most " +
        WEBMCP_CHUNK_GUIDE_BYTES +
        " raw bytes per call as base64. With no peer connected the file queues until someone joins.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "file name shown to peers" },
          size: { type: "number", description: "total file size in bytes" },
          mime: { type: "string", description: "optional mime type" },
          seq: { type: "number", description: "0-based chunk sequence number" },
          dataBase64: { type: "string", description: "this chunk's bytes, base64" },
          final: { type: "boolean", description: "true on the last chunk" },
        },
        required: ["name", "size", "seq", "dataBase64"],
        additionalProperties: false,
      },
      annotations: { consequentialHint: true },
      execute: (input) => {
        const name = typeof input.name === "string" ? input.name.trim().slice(0, 255) : "";
        const size = typeof input.size === "number" ? input.size : NaN;
        const mime =
          typeof input.mime === "string" && input.mime.trim()
            ? input.mime.trim().slice(0, 128)
            : "application/octet-stream";
        const seq = typeof input.seq === "number" ? input.seq : -1;
        const data = typeof input.dataBase64 === "string" ? input.dataBase64 : "";
        if (!name) throw new Error("send_file: name is required");
        if (!Number.isSafeInteger(size) || size < 0 || size > MAX_TRANSFER_SIZE) {
          throw new Error(`send_file: size must be a safe integer in 0..${MAX_TRANSFER_SIZE}`);
        }
        const key = `${name}:${size}`;
        let up = uploads.get(key);
        if (!up) {
          if (seq !== 0) throw new Error("send_file: first chunk must have seq 0");
          up = { name, mime, size, nextSeq: 0, parts: [], received: 0 };
          uploads.set(key, up);
        }
        if (seq !== up.nextSeq) {
          throw new Error(`send_file: expected seq ${up.nextSeq}, got ${seq}`);
        }
        const part = decodeBase64(data);
        if (up.received + part.byteLength > size) {
          uploads.delete(key);
          throw new Error("send_file: chunk data exceeds the announced size");
        }
        up.parts.push(part);
        up.received += part.byteLength;
        up.nextSeq++;
        if (input.final !== true) {
          return { complete: false, receivedBytes: up.received, totalBytes: size };
        }
        uploads.delete(key);
        if (up.received !== size) {
          throw new Error(`send_file: announced ${size} bytes but received ${up.received}`);
        }
        const file = new File(up.parts, name, { type: mime });
        // sendFiles returns the created views directly — no 50 ms snapshot
        // debounce wait for a freshly-queued transfer
        const [view] = client.sendMessage("", [file]);
        return {
          complete: true,
          queuedBytes: size,
          openPeerCount: openPeerCount(),
          // hand the agent a poll handle: the transfer id it can watch with
          // maishare_transfers_status (wire ids stay internal otherwise)
          transfer: view ? { id: view.id, status: view.status } : null,
        };
      },
    },
    { signal: unregister.signal },
  );

  void mc.registerTool(
    {
      name: "maishare_transfers_status",
      title: "Transfer status",
      description:
        "Read-only list of file transfers in this room session: direction, bytes progress, speed and state (queued | active | done | error | cancelled). Poll this after maishare_send_file to learn when the peers have the file.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      execute: () =>
        client.getSnapshot().transfers.map((t) => ({
          id: t.id,
          name: t.name,
          dir: t.dir,
          peerName: t.peerName,
          status: t.status,
          bytes: t.bytes,
          size: t.size,
          speedBps: t.speed,
          mime: t.mime,
        })),
    },
    { signal: unregister.signal },
  );

  return () => unregister.abort();
}
