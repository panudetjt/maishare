// Long chat text over the file pipeline: text past the chat-frame cap
// (MAX_CHAT_CHARS) travels as an asText .txt transfer — chunked and
// backpressured like any file, since chat frames are single datagrams with
// no chunking of their own — and receivers render it back as a chat bubble
// via the `asText` hint. Drives the real client through the shared test
// harness; assertions read wire frames and the public store snapshot.
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { concatFrame, encoder, FRAME, type Control } from "./protocol";
import {
  createRoomHarness,
  decodeFrame,
  installRoomClientStubs,
  IMPOLITE_PEER,
  type FakeDataChannel,
  type RoomHarness,
} from "./room-client.test-harness";
import { MAX_CHAT_CHARS, MAX_TEXTFILE_BYTES, MESSAGE_FILE_NAME } from "./room-client";

let restoreStubs: () => void;
let h: RoomHarness;

beforeEach(() => {
  restoreStubs = installRoomClientStubs();
  h = createRoomHarness();
});

afterEach(() => {
  h.dispose();
  restoreStubs();
});

function controls(ch: FakeDataChannel): (Control & { asText?: boolean })[] {
  return ch.sent
    .filter((f) => f[0] === FRAME.CONTROL)
    .map((f) => JSON.parse(decodeFrame(f).body) as Control & { asText?: boolean });
}

function wireBytes(ch: FakeDataChannel): number {
  return ch.sent.filter((f) => f[0] === FRAME.CHUNK).reduce((n, f) => n + f.byteLength - 1, 0);
}

function textStart(id: string, size: number, asText: boolean): Uint8Array {
  const c: Control = {
    t: "file-start",
    id,
    name: MESSAGE_FILE_NAME,
    size,
    mime: "text/plain",
    g: "g",
    ...(asText ? { asText: true } : {}),
  };
  return concatFrame(FRAME.CONTROL, encoder.encode(JSON.stringify(c)));
}

function textChunk(bytes: Uint8Array): Uint8Array {
  return concatFrame(FRAME.CHUNK, bytes);
}

function fileEnd(id: string): Uint8Array {
  return concatFrame(FRAME.CONTROL, encoder.encode(JSON.stringify({ t: "file-end", id })));
}

function textQueued(id: string, size: number, asText: boolean): Uint8Array {
  const c: Control = {
    t: "file-queued",
    id,
    name: MESSAGE_FILE_NAME,
    size,
    mime: "text/plain",
    g: "g",
    ...(asText ? { asText: true } : {}),
  };
  return concatFrame(FRAME.CONTROL, encoder.encode(JSON.stringify(c)));
}

/** 8001 Thai chars — every one 3 bytes in UTF-8, so byte vs char bounds differ */
const LONG = "ก".repeat(MAX_CHAT_CHARS + 1);

describe("sender: long text routes through the file pipeline", () => {
  it("sends text past the chat cap as an asText message.txt transfer, no chat frame", async () => {
    await h.start();
    const peer = h.addPeer(IMPOLITE_PEER);
    const ch = h.openChannel(peer);
    await h.flush();

    const views = h.client.sendMessage(LONG, []);
    await h.settle();

    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ asText: true, text: LONG, name: MESSAGE_FILE_NAME });

    const cs = controls(ch);
    expect(cs.some((c) => c.t === "chat")).toBe(false);
    expect(cs.find((c) => c.t === "file-queued")).toMatchObject({
      name: MESSAGE_FILE_NAME,
      mime: "text/plain",
      asText: true,
    });
    expect(cs.find((c) => c.t === "file-start")).toMatchObject({
      name: MESSAGE_FILE_NAME,
      mime: "text/plain",
      // the wire carries UTF-8 bytes, not UTF-16 chars
      size: encoder.encode(LONG).byteLength,
      asText: true,
    });
    expect(wireBytes(ch)).toBe(encoder.encode(LONG).byteLength);
  });

  it("sends text at the chat cap as a plain chat frame, unchanged", async () => {
    await h.start();
    const peer = h.addPeer(IMPOLITE_PEER);
    const ch = h.openChannel(peer);
    await h.flush();

    const exactly = "a".repeat(MAX_CHAT_CHARS);
    h.client.sendMessage(exactly, []);
    await h.settle();

    const cs = controls(ch);
    expect(cs.find((c) => c.t === "chat")).toMatchObject({ text: exactly });
    expect(cs.some((c) => c.t === "file-start")).toBe(false);
  });

  it("keeps caption + long text + attachments in one group", async () => {
    await h.start();
    const peer = h.addPeer(IMPOLITE_PEER);
    const ch = h.openChannel(peer);
    await h.flush();

    const views = h.client.sendMessage(`caption ${LONG}`, [
      new File([new Uint8Array(8).fill(7)], "pic.bin", { type: "application/octet-stream" }),
    ]);
    await h.settle();

    // the caption is part of the long text — one asText transfer carries it
    // whole, and the attachment rides beside it under the same groupId
    expect(views).toHaveLength(2);
    const textView = views.find((v) => v.asText);
    const fileView = views.find((v) => !v.asText);
    expect(textView).toMatchObject({ text: `caption ${LONG}`, name: MESSAGE_FILE_NAME });
    expect(fileView).toMatchObject({ name: "pic.bin" });
    expect(textView?.groupId).toBe(fileView?.groupId);

    const cs = controls(ch);
    expect(cs.some((c) => c.t === "chat")).toBe(false);
    expect(cs.find((c) => c.t === "file-start")).toMatchObject({
      asText: true,
      g: views[0].groupId,
    });
  });

  it("withholds the hint past the inline-render ceiling — the file card is the fallback", async () => {
    await h.start();
    const peer = h.addPeer(IMPOLITE_PEER);
    const ch = h.openChannel(peer);
    await h.flush();

    const huge = "x".repeat(MAX_TEXTFILE_BYTES + 1);
    const views = h.client.sendLongText(huge);
    await h.settle();

    const start = controls(ch).find((c) => c.t === "file-start");
    expect(start).toMatchObject({ name: MESSAGE_FILE_NAME, size: MAX_TEXTFILE_BYTES + 1 });
    expect(start?.asText).toBeUndefined();
    expect(views[0].asText).toBeUndefined();
  });
});

describe("receiver: asText transfers render back as text bubbles", () => {
  it("decodes the finished transfer's text into the view", async () => {
    await h.start();
    const peer = h.addPeer(IMPOLITE_PEER);
    const ch = h.openChannel(peer);
    await h.flush();

    const text = "ข้อความยาวเกินแปดพันตัวอักษร ".repeat(300);
    const bytes = encoder.encode(text);
    ch.receive(textStart("t1", bytes.byteLength, true));
    ch.receive(textChunk(bytes));
    ch.receive(fileEnd("t1"));
    await h.settle();

    const view = h.client.getSnapshot().transfers.find((t) => t.id === "t1");
    expect(view).toMatchObject({ status: "done", asText: true, name: MESSAGE_FILE_NAME });
    expect(view?.text).toBe(text);
  });

  it("honors the hint on the queue preview and keeps it through promotion", async () => {
    await h.start();
    const peer = h.addPeer(IMPOLITE_PEER);
    const ch = h.openChannel(peer);
    await h.flush();

    ch.receive(textQueued("t1", 12, true));
    await h.settle();
    expect(h.client.getSnapshot().transfers.find((t) => t.id === "t1")?.asText).toBe(true);

    ch.receive(textStart("t1", 12, true));
    ch.receive(textChunk(encoder.encode("hello world!")));
    ch.receive(fileEnd("t1"));
    await h.settle();
    const view = h.client.getSnapshot().transfers.find((t) => t.id === "t1");
    expect(view).toMatchObject({ status: "done", asText: true });
    expect(view?.text).toBe("hello world!");
  });

  it("keeps an oversized asText claim an ordinary file card", async () => {
    await h.start();
    const peer = h.addPeer(IMPOLITE_PEER);
    const ch = h.openChannel(peer);
    await h.flush();

    // a hostile hint on a transfer too big to render inline: the flag is
    // dropped at file-start, so the UI falls back to the ordinary card
    ch.receive(textStart("t1", MAX_TEXTFILE_BYTES + 1, true));
    await h.settle();
    expect(h.client.getSnapshot().transfers.find((t) => t.id === "t1")?.asText).toBeUndefined();
  });

  it("round-trips: the sender's own wire frames rebuild the text on the far side", async () => {
    await h.start();
    const peer = h.addPeer(IMPOLITE_PEER);
    const ch = h.openChannel(peer);
    await h.flush();

    const text = "สวัสดีชาวโลก ".repeat(1000);
    h.client.sendLongText(text);
    await h.settle();

    // replay exactly what went out on the wire — file frames only, no hello —
    // back into the channel: the frames alone must reconstruct the message
    const fileFrames = ch.sent.filter((f) => {
      if (f[0] === FRAME.CHUNK) return true;
      if (f[0] !== FRAME.CONTROL) return false;
      const t = (JSON.parse(decodeFrame(f).body) as Control).t;
      return t === "file-queued" || t === "file-start" || t === "file-end";
    });
    for (const frame of fileFrames) ch.receive(frame);
    await h.settle();

    const view = h.client.getSnapshot().transfers.find((t) => t.dir === "in" && t.asText);
    expect(view?.status).toBe("done");
    expect(view?.text).toBe(text);
  });
});
