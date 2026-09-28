// Receiver-side spill storage for inbound transfers.
//
// Small transfers buffer in RAM exactly as they always did. Large ones
// stream straight to the Origin Private File System (OPFS) — per-origin
// disk storage with no permission prompt — so a multi-gigabyte file never
// has to fit in memory: chunks are appended as they arrive and the final
// Blob is the disk-backed File itself (URL.createObjectURL streams it).
// The physical bound becomes browser storage quota, and exhausting it
// fails one transfer gracefully instead of OOM-ing the tab.
import { uuid } from "../device";

/** leading bytes kept for content sniffing regardless of sink kind */
const HEAD_MAX = 64 * 1024;

/** at or below this size the transfer buffers in RAM (fast, zero setup) */
export const RAM_BUFFER_LIMIT = 64 * 1024 * 1024;
/** sanity ceiling on announced sizes — anything higher is a bogus claim.
 * Safe-integer bound well past any real quota; the quota itself enforces
 * the practical limit by failing writes */
export const MAX_STREAMABLE_SIZE = 2 ** 45; // 32 TiB

/** the OPFS surface we use, declared locally so this compiles regardless of
 * how complete the ambient lib.dom FileSystem types are */
export interface WritableLike {
  write(data: BufferSource): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}
export interface FileHandleLike {
  createWritable(opts?: { keepExistingData?: boolean }): Promise<WritableLike>;
  getFile(): Promise<File>;
}
export interface DirLike {
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileHandleLike>;
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<DirLike>;
  removeEntry(name: string): Promise<void>;
}

export interface IncomingSink {
  /** "ram" buffers in memory, "disk" streams to OPFS */
  readonly kind: "ram" | "disk";
  /** failure reason once a write has failed; null while healthy */
  failed: string | null;
  /** queue one chunk — fire-and-forget, serialized internally */
  append(chunk: Uint8Array<ArrayBuffer>): void;
  /** first ≤64 KiB received, for content sniffing */
  head(): Uint8Array;
  /** the assembled blob — RAM blob, or the disk-backed File */
  finish(): Promise<Blob>;
  /** discard everything and clean up */
  abort(): void;
}

export function ramSink(): IncomingSink {
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  let headLen = 0;
  let failed: string | null = null;
  return {
    kind: "ram",
    get failed() {
      return failed;
    },
    append(chunk) {
      parts.push(chunk);
      total += chunk.byteLength;
      headLen = Math.min(HEAD_MAX, headLen + chunk.byteLength);
    },
    head() {
      const out = new Uint8Array(headLen);
      let off = 0;
      for (const p of parts) {
        if (off >= headLen) break;
        const take = Math.min(p.byteLength, headLen - off);
        out.set(p.subarray(0, take), off);
        off += take;
      }
      return out;
    },
    async finish() {
      if (failed) throw new Error(failed);
      return new Blob(parts, { type: "application/octet-stream" });
    },
    abort() {
      parts.length = 0;
    },
  };
}

type RootGetter = () => Promise<DirLike>;

function defaultRoot(): Promise<DirLike> {
  const storage = (navigator as Navigator & { storage?: { getDirectory?(): Promise<DirLike> } })
    .storage;
  if (!storage?.getDirectory) throw new Error("no-opfs");
  return storage.getDirectory();
}

/** stream chunks into `<opfs>/incoming/<uuid>` until finish() */
export function diskSink(root: RootGetter = defaultRoot): IncomingSink {
  const fileName = `t-${uuid()}`;
  let dir: DirLike | null = null;
  let fileHandle: FileHandleLike | null = null;
  let writable: WritableLike | null = null;
  let closed = false;
  let head = new Uint8Array(0);
  let failed: string | null = null;
  let chain: Promise<void> = (async () => {
    try {
      dir = await (await root()).getDirectoryHandle("incoming", { create: true });
      fileHandle = await dir.getFileHandle(fileName, { create: true });
      writable = await fileHandle.createWritable();
    } catch {
      failed = "storage-unavailable";
    }
  })();
  const serialize = (step: () => Promise<void>) => {
    chain = chain.then(step).catch(() => {});
  };
  return {
    kind: "disk",
    get failed() {
      return failed;
    },
    append(chunk) {
      if (failed || closed) return;
      if (head.length < HEAD_MAX) {
        const merged = new Uint8Array(Math.min(HEAD_MAX, head.length + chunk.byteLength));
        merged.set(head);
        merged.set(chunk.subarray(0, merged.length - head.length), head.length);
        head = merged;
      }
      serialize(async () => {
        if (failed || !writable) return;
        try {
          await writable.write(chunk);
        } catch {
          failed = "write-failed";
          try {
            await writable.abort?.();
          } catch {}
          writable = null;
        }
      });
    },
    head() {
      return head;
    },
    finish() {
      return (async () => {
        await chain;
        if (failed) throw new Error(failed);
        if (!writable || !fileHandle) throw new Error("sink-not-initialized");
        await writable.close();
        closed = true;
        return await fileHandle.getFile();
      })();
    },
    abort() {
      if (closed) return;
      serialize(async () => {
        try {
          await writable?.abort?.();
        } catch {}
        writable = null;
        try {
          await dir?.removeEntry(fileName);
        } catch {}
      });
    },
  };
}

export function opfsAvailable(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!(navigator as Navigator & { storage?: { getDirectory?(): unknown } }).storage?.getDirectory
  );
}

/**
 * Pick the sink for an announced inbound size: RAM up to RAM_BUFFER_LIMIT,
 * OPFS beyond it. Returns "too-large" when the size needs disk but the
 * browser has no OPFS — callers refuse the header with backpressure rather
 * than buffering gigabytes in a tab.
 */
export function pickIncomingSink(size: number): IncomingSink | "too-large" {
  if (size <= RAM_BUFFER_LIMIT) return ramSink();
  if (opfsAvailable()) return diskSink();
  return "too-large";
}
