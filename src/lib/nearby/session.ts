import { platformLabel } from "../device";
import { concatFrame, decoder, encoder, FRAME, type Control } from "../p2p/protocol";

// Direct device-to-device file sharing with no server and no internet: two
// browsers on the same LAN exchange a full SDP offer/answer via QR codes (or
// paste), then transfer on a host-only WebRTC data channel using the same
// wire protocol as room transfers (maishare framing, DTLS underneath).

const BUFFER_HIGH = 4 * 1024 * 1024;
const BUFFER_LOW = 1 * 1024 * 1024;
const CHUNK = 64 * 1024;

export type NearbyPhase =
  | "idle"
  | "offer-ready"
  | "answer-ready"
  | "connecting"
  | "open"
  | "closed"
  | "failed";

export type TransferStatus = "queued" | "active" | "done" | "error" | "cancelled";

export interface NearbyTransfer {
  id: string;
  dir: "in" | "out";
  name: string;
  size: number;
  mime: string;
  status: TransferStatus;
  bytes: number;
  speed: number;
  blobUrl?: string;
}

export interface NearbyState {
  phase: NearbyPhase;
  selfName: string;
  peerName: string;
  transfers: NearbyTransfer[];
  failedCode?: string;
}

interface Incoming {
  view: NearbyTransfer;
  chunks: Uint8Array<ArrayBuffer>[];
  lastEmitAt: number;
  lastEmitBytes: number;
}

interface OutJob {
  view: NearbyTransfer;
  file: File;
  cancelled: boolean;
}

function rid(): string {
  return crypto.randomUUID();
}

/** Wait for host-candidate gathering so the SDP is complete for one-shot QR. */
function gathered(pc: RTCPeerConnection, timeoutMs = 1500): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener("icegatheringstatechange", onChange);
      clearTimeout(timer);
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === "complete") done();
    };
    const timer = setTimeout(done, timeoutMs);
    pc.addEventListener("icegatheringstatechange", onChange);
  });
}

export class NearbySession {
  readonly selfName: string;
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private role: "initiator" | "responder" | null = null;
  private phase: NearbyPhase = "idle";
  private peerName = "nearby device";
  private failedCode: string | undefined;
  private transfers: NearbyTransfer[] = [];
  private incoming: Incoming | null = null;
  private outQueue: OutJob[] = [];
  private pumping = false;
  private readonly listeners = new Set<() => void>();
  private state: NearbyState;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(selfName: string) {
    this.selfName = selfName.trim().slice(0, 32) || "device";
    this.state = this.snapshot();
  }

  // ---- store (useSyncExternalStore) ----

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = (): NearbyState => this.state;

  private snapshot(): NearbyState {
    return {
      phase: this.phase,
      selfName: this.selfName,
      peerName: this.peerName,
      transfers: this.transfers.map((t) => ({ ...t })),
      failedCode: this.failedCode,
    };
  }

  private emit() {
    if (this.emitTimer != null || this.disposed) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      if (this.disposed) return;
      this.state = this.snapshot();
      for (const l of this.listeners) l();
    }, 50);
  }

  private setPhase(phase: NearbyPhase) {
    this.phase = phase;
    this.emit();
  }

  // ---- QR handshake ----

  /** Initiator: build the complete host-only offer and return the share code. */
  async createOffer(): Promise<string> {
    this.teardown();
    this.role = "initiator";
    this.setPhase("offer-ready");
    const pc = new RTCPeerConnection({ iceServers: [] });
    this.pc = pc;
    const dc = pc.createDataChannel("maishare-nearby", { ordered: true });
    this.attachChannel(dc);
    await pc.setLocalDescription();
    await gathered(pc);
    const { packShareCode } = await import("./qr");
    return packShareCode({ type: "offer", sdp: pc.localDescription!.sdp, name: this.selfName });
  }

  /** Responder: consume the scanned offer, return the answer share code. */
  async acceptOffer(code: string): Promise<string> {
    this.teardown();
    const { unpackShareCode, packShareCode } = await import("./qr");
    const offer = await unpackShareCode(code);
    if (offer.type !== "offer") throw new Error("expected an offer code");
    this.role = "responder";
    const pc = new RTCPeerConnection({ iceServers: [] });
    this.pc = pc;
    pc.ondatachannel = (ev) => this.attachChannel(ev.channel);
    await pc.setRemoteDescription({ type: "offer", sdp: offer.sdp });
    this.peerName = offer.name || this.peerName;
    this.setPhase("answer-ready");
    await pc.setLocalDescription();
    await gathered(pc);
    return packShareCode({ type: "answer", sdp: pc.localDescription!.sdp, name: this.selfName });
  }

  /** Initiator: consume the scanned answer and connect. */
  async acceptAnswer(code: string): Promise<void> {
    if (this.role !== "initiator" || !this.pc) throw new Error("not waiting for an answer");
    const { unpackShareCode } = await import("./qr");
    const answer = await unpackShareCode(code);
    if (answer.type !== "answer") throw new Error("expected an answer code");
    await this.pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
    this.peerName = answer.name || this.peerName;
    this.setPhase("connecting");
  }

  // ---- wire ----

  private attachChannel(dc: RTCDataChannel) {
    this.dc = dc;
    dc.binaryType = "arraybuffer";
    dc.bufferedAmountLowThreshold = BUFFER_LOW;
    dc.onopen = () => {
      this.setPhase("open");
      void this.sendControl({ t: "hello", name: this.selfName, platform: platformLabel() });
      void this.pump();
    };
    dc.onclose = () => {
      if (!this.disposed && this.phase !== "failed") this.setPhase("closed");
    };
    dc.onmessage = (ev) => this.onFrame(ev.data);
  }

  private async sendControl(c: Control) {
    const dc = this.dc;
    if (!dc || dc.readyState !== "open") return;
    try {
      dc.send(concatFrame(FRAME.CONTROL, encoder.encode(JSON.stringify(c))));
    } catch {}
  }

  private onFrame(data: unknown) {
    if (typeof data === "string" || this.disposed) return;
    const u8 = new Uint8Array(data as ArrayBuffer);
    if (!u8.length) return;
    if (u8[0] !== FRAME.CONTROL && u8[0] !== FRAME.CHUNK) return;
    const body = u8.subarray(1);
    if (u8[0] === FRAME.CONTROL) {
      let c: Control;
      try {
        c = JSON.parse(decoder.decode(body)) as Control;
      } catch {
        return;
      }
      this.onControl(c);
    } else {
      this.onChunk(body);
    }
  }

  private onControl(c: Control) {
    switch (c.t) {
      case "hello":
        this.peerName = c.name || this.peerName;
        this.emit();
        break;
      case "file-start": {
        const view: NearbyTransfer = {
          id: c.id,
          dir: "in",
          name: c.name,
          size: c.size,
          mime: c.mime,
          status: "active",
          bytes: 0,
          speed: 0,
        };
        this.incoming = { view, chunks: [], lastEmitAt: performance.now(), lastEmitBytes: 0 };
        this.transfers = [view, ...this.transfers];
        this.emit();
        break;
      }
      case "file-end":
        this.finishIncoming(c.id);
        break;
      case "file-cancel": {
        if (this.incoming?.view.id === c.id) this.incoming = null;
        const t = this.transfers.find((x) => x.id === c.id);
        if (t && t.status === "active") {
          t.status = "cancelled";
          this.emit();
        }
        break;
      }
      default:
        break;
    }
  }

  private onChunk(body: Uint8Array<ArrayBuffer>) {
    const inc = this.incoming;
    if (!inc) return;
    inc.chunks.push(body);
    inc.view.bytes += body.byteLength;
    const now = performance.now();
    if (now - inc.lastEmitAt > 120) {
      const dt = (now - inc.lastEmitAt) / 1000;
      if (dt > 0) inc.view.speed = (inc.view.bytes - inc.lastEmitBytes) / dt;
      inc.lastEmitAt = now;
      inc.lastEmitBytes = inc.view.bytes;
      this.emit();
    }
  }

  private finishIncoming(id: string) {
    const inc = this.incoming;
    if (!inc || inc.view.id !== id) return;
    this.incoming = null;
    const v = inc.view;
    const blob = new Blob(inc.chunks, { type: v.mime });
    v.blobUrl = URL.createObjectURL(blob);
    v.status = "done";
    v.bytes = v.size;
    this.emit();
  }

  // ---- sending ----

  sendFiles(files: FileList | File[]) {
    const dc = this.dc;
    if (!dc || dc.readyState !== "open" || this.disposed) return;
    for (const file of Array.from(files)) {
      const view: NearbyTransfer = {
        id: rid(),
        dir: "out",
        name: file.name || "file",
        size: file.size,
        mime: file.type || "application/octet-stream",
        status: "queued",
        bytes: 0,
        speed: 0,
      };
      this.transfers = [view, ...this.transfers];
      this.outQueue.push({ view, file, cancelled: false });
    }
    this.emit();
    void this.pump();
  }

  private async pump() {
    if (this.pumping || !this.dc || this.dc.readyState !== "open") return;
    this.pumping = true;
    try {
      while (this.outQueue.length && !this.disposed) {
        const job = this.outQueue.shift()!;
        await this.runJob(job);
      }
    } finally {
      this.pumping = false;
    }
  }

  private async runJob(job: OutJob) {
    const { view, file } = job;
    if (job.cancelled || view.status === "cancelled") return;
    view.status = "active";
    this.emit();
    await this.sendControl({
      t: "file-start",
      id: view.id,
      name: file.name || "file",
      size: file.size,
      mime: file.type || "application/octet-stream",
      kind: "file",
    });
    let offset = 0;
    let lastEmitAt = performance.now();
    let lastEmitBytes = 0;
    while (offset < file.size) {
      if (!this.dc || this.dc.readyState !== "open" || job.cancelled) {
        view.status = job.cancelled ? "cancelled" : "error";
        this.emit();
        return;
      }
      if (this.dc.bufferedAmount > BUFFER_HIGH) {
        await new Promise<void>((resolve) => {
          const d = this.dc!;
          const done = () => {
            d.removeEventListener("bufferedamountlow", done);
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(done, 4000);
          d.addEventListener("bufferedamountlow", done, { once: true });
        });
      }
      const slice = await file.slice(offset, offset + CHUNK).arrayBuffer();
      const u8 = new Uint8Array(slice);
      try {
        this.dc.send(concatFrame(FRAME.CHUNK, u8));
      } catch {
        view.status = "error";
        this.emit();
        return;
      }
      offset += u8.byteLength;
      view.bytes = offset;
      const now = performance.now();
      if (now - lastEmitAt > 150) {
        const dt = (now - lastEmitAt) / 1000;
        if (dt > 0) view.speed = (offset - lastEmitBytes) / dt;
        lastEmitAt = now;
        lastEmitBytes = offset;
        this.emit();
      }
    }
    view.status = "done";
    await this.sendControl({ t: "file-end", id: view.id });
    this.emit();
  }

  cancelTransfer(id: string) {
    const t = this.transfers.find((x) => x.id === id);
    if (!t || t.status === "done" || t.status === "cancelled") return;
    if (t.dir === "out") {
      const job = this.outQueue.find((j) => j.view.id === id);
      if (job) job.cancelled = true;
      if (t.status === "queued") t.status = "cancelled";
      void this.sendControl({ t: "file-cancel", id });
    } else {
      this.incoming = null;
      t.status = "cancelled";
      void this.sendControl({ t: "file-cancel", id });
    }
    this.emit();
  }

  // ---- lifecycle ----

  /** Reset an abandoned handshake (stayed in offer/answer too long, etc.). */
  private teardown() {
    if (this.dc) {
      this.dc.onclose = null;
      try {
        this.dc.close();
      } catch {}
      this.dc = null;
    }
    if (this.pc) {
      try {
        this.pc.close();
      } catch {}
      this.pc = null;
    }
    this.role = null;
  }

  dispose() {
    this.disposed = true;
    this.teardown();
    for (const t of this.transfers) if (t.blobUrl) URL.revokeObjectURL(t.blobUrl);
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.listeners.clear();
  }
}
