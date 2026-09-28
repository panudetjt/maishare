// Receiver-side spill storage: RAM sinks must reproduce bytes verbatim and
// bound their sniff head; disk sinks must stream the same bytes through the
// OPFS surface, surface write failures instead of dropping them, and clean
// their file up on abort; pickIncomingSink must refuse — not buffer — a
// disk-bound size when OPFS is unavailable.
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  diskSink,
  pickIncomingSink,
  RAM_BUFFER_LIMIT,
  ramSink,
  type DirLike,
  type FileHandleLike,
  type WritableLike,
} from "./spill";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** minimal in-memory OPFS stand-in */
function fakeRoot(): { root: DirLike; files: Map<string, Uint8Array[]>; removed: string[] } {
  const files = new Map<string, Uint8Array[]>();
  const removed: string[] = [];
  const root: DirLike = {
    async getDirectoryHandle(name) {
      expect(name).toBe("incoming");
      return this as DirLike;
    },
    async getFileHandle(name, opts) {
      if (opts?.create) files.set(name, []);
      const parts = files.get(name);
      if (!parts) throw new Error("not found");
      const handle: FileHandleLike = {
        async createWritable(): Promise<WritableLike> {
          let open = true;
          return {
            async write(data) {
              if (!open) throw new Error("closed");
              parts.push(new Uint8Array(data as ArrayBuffer));
            },
            async close() {
              open = false;
            },
            async abort() {
              open = false;
            },
          };
        },
        async getFile() {
          const total = parts.reduce((n, p) => n + p.byteLength, 0);
          const out = new Uint8Array(total);
          let off = 0;
          for (const p of parts) {
            out.set(p, off);
            off += p.byteLength;
          }
          return new File([out], name);
        },
      };
      return handle;
    },
    async removeEntry(name) {
      files.delete(name);
      removed.push(name);
    },
  };
  return { root, files, removed };
}

describe("spill sinks", () => {
  it("ramSink reproduces bytes in order and bounds its head", async () => {
    const sink = ramSink();
    sink.append(new Uint8Array([1, 2, 3]));
    sink.append(new Uint8Array([4, 5]));
    expect(Array.from(sink.head())).toEqual([1, 2, 3, 4, 5]);
    const blob = await sink.finish();
    expect(blob.size).toBe(5);
    expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual([1, 2, 3, 4, 5]);
    sink.abort();
    expect((await ramSink().finish()).size).toBe(0);
  });

  it("diskSink streams the same bytes through OPFS", async () => {
    const { root, files } = fakeRoot();
    const sink = diskSink(() => Promise.resolve(root));
    sink.append(new Uint8Array([10, 20, 30]));
    sink.append(new Uint8Array([40]));
    expect(Array.from(sink.head())).toEqual([10, 20, 30, 40]);
    const blob = await sink.finish();
    expect(blob.size).toBe(4);
    expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual([10, 20, 30, 40]);
    expect(files.size).toBe(1);
  });

  it("diskSink abort removes the partial file", async () => {
    const { root, removed, files } = fakeRoot();
    const sink = diskSink(() => Promise.resolve(root));
    sink.append(new Uint8Array([1]));
    sink.abort();
    await new Promise((r) => setTimeout(r, 0));
    expect(files.size).toBe(0);
    expect(removed).toHaveLength(1);
  });

  it("diskSink surfaces write failures", async () => {
    const broken: DirLike = {
      ...fakeRoot().root,
      async getFileHandle() {
        const handle: FileHandleLike = {
          async createWritable(): Promise<WritableLike> {
            return {
              async write() {
                throw new Error("quota");
              },
              async close() {},
              async abort() {},
            };
          },
          async getFile() {
            throw new Error("no file");
          },
        };
        return handle;
      },
    };
    const sink = diskSink(() => Promise.resolve(broken));
    sink.append(new Uint8Array([1]));
    await expect(sink.finish()).rejects.toThrow(/write-failed|storage/);
  });

  it("pickIncomingSink buffers small sizes, streams big ones, refuses big without OPFS", () => {
    const kind = (n: number) => {
      const s = pickIncomingSink(n);
      return s === "too-large" ? "too-large" : s.kind;
    };
    expect(kind(1024)).toBe("ram");
    expect(kind(RAM_BUFFER_LIMIT)).toBe("ram");
    // node has no navigator.storage → a disk-bound size must be refused
    expect(kind(RAM_BUFFER_LIMIT + 1)).toBe("too-large");
    vi.stubGlobal("navigator", {
      storage: { getDirectory: () => Promise.resolve(fakeRoot().root) },
    });
    expect(kind(RAM_BUFFER_LIMIT + 1)).toBe("disk");
  });
});
