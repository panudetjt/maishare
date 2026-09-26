import { platformLabel } from "../device";
import {
  concatFrame,
  decoder,
  encoder,
  ENC_OVERHEAD,
  FRAME,
  type Control,
  type ShareKind,
} from "./protocol";
import { RoomCipher } from "./crypto";
import { Signaling, type SignalStatus } from "./signaling";
import { LanProbe } from "./lan-probe";

const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
// Pause sending while the SCTP buffer is above HIGH; the bufferedamountlow
// event (threshold BUFFER_LOW) wakes the pump again.
const BUFFER_HIGH = 8 * 1024 * 1024;
const BUFFER_LOW = 2 * 1024 * 1024;
const PING_EVERY = 4000;

export type PeerStatus = "connecting" | "open" | "closed" | "failed";

export interface PeerView {
  peerId: string;
  name: string;
  platform: string;
  status: PeerStatus;
  rtt: number | null;
}

export interface ChatMsg {
  id: string;
  peerId: string;
  name: string;
  text: string;
  at: number;
  mine: boolean;
}

export type TransferStatus = "queued" | "active" | "done" | "error" | "cancelled";

export interface TransferView {
  id: string;
  dir: "in" | "out";
  peerId: string;
  peerName: string;
  name: string;
  size: number;
  mime: string;
  kind: ShareKind;
  status: TransferStatus;
  bytes: number;
  speed: number;
  at: number;
  blobUrl?: string;
  blob?: Blob;
}

export type ClipItem =
  | { id: string; at: number; peerId: string; peerName: string; kind: "text"; text: string }
  | {
      id: string;
      at: number;
      peerId: string;
      peerName: string;
      kind: "image";
      mime: string;
      size: number;
      blobUrl: string;
      blob: Blob;
    };

export interface Toast {
  id: number;
  msg: string;
  kind: "info" | "error" | "success";
}

export interface RoomState {
  roomId: string;
  selfId: string;
  selfName: string;
  encrypted: boolean;
  signalStatus: SignalStatus;
  addresses: string[];
  peers: PeerView[];
  chats: ChatMsg[];
  transfers: TransferView[];
  clips: ClipItem[];
  toasts: Toast[];
  sentTotal: number;
  recvTotal: number;
}

interface SendJob {
  view: TransferView;
  file: File;
  kind: ShareKind;
  bytesSent: number;
  done: boolean;
  failed: boolean;
}

interface Incoming {
  view: TransferView;
  chunks: Uint8Array<ArrayBuffer>[];
  startedAt: number;
  lastEmitAt: number;
  lastEmitBytes: number;
}

interface PeerCtx {
  peerId: string;
  name: string;
  platform: string;
  polite: boolean;
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  status: PeerStatus;
  makingOffer: boolean;
  ignoreOffer: boolean;
  settingRemoteAnswer: boolean;
  pendingCandidates: RTCIceCandidateInit[];
  pingTimer: ReturnType<typeof setInterval> | null;
  rtt: number | null;
  queue: SendJob[];
  pumping: boolean;
  maxChunk: number;
  incoming: Incoming | null;
  retriedIce: boolean;
}

function rid(): string {
  return crypto.randomUUID();
}

export class RoomClient {
  readonly roomId: string;
  readonly selfId = rid();
  private selfName: string;
  private cipher: RoomCipher | null = null;
  private readonly cipherReady: Promise<void>;
  private readonly sig: Signaling;
  private readonly peers = new Map<string, PeerCtx>();
  /** in-flight discovery verification probes, keyed by the prober's id */
  private readonly probes = new Map<string, LanProbe>();
  private readonly outJobs = new Map<string, Set<SendJob>>();
  private deferred: { view: TransferView; file: File; kind: ShareKind }[] = [];
  private chats: ChatMsg[] = [];
  private transfers: TransferView[] = [];
  private clips: ClipItem[] = [];
  private toasts: Toast[] = [];
  private sentTotal = 0;
  private recvTotal = 0;
  private addresses: string[] = [];
  private signalStatus: SignalStatus = "connecting";
  private hadSession = false;
  private started = false;
  private disposed = false;
  private toastSeq = 1;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<() => void>();
  private state: RoomState;

  constructor(opts: { roomId: string; key?: string; name: string }) {
    this.roomId = opts.roomId;
    this.selfName = opts.name;
    this.cipherReady = opts.key
      ? RoomCipher.fromKey(opts.key).then(
          (c) => {
            this.cipher = c;
          },
          () => {},
        )
      : Promise.resolve();
    this.state = this.snapshot();
    this.sig = new Signaling(
      { roomId: opts.roomId, peerId: this.selfId, name: opts.name },
      {
        onStatus: (s) => this.onSignalStatus(s),
        onMessage: (m) => this.onServerMsg(m),
      },
    );
  }

  async start() {
    if (this.started || this.disposed) return;
    this.started = true;
    await this.cipherReady;
    if (this.disposed) return;
    this.sig.connect();
    this.emitNow();
  }

  // ---- store (useSyncExternalStore) ----

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = (): RoomState => this.state;

  private snapshot(): RoomState {
    return {
      roomId: this.roomId,
      selfId: this.selfId,
      selfName: this.selfName,
      encrypted: this.cipher !== null,
      signalStatus: this.signalStatus,
      addresses: this.addresses,
      peers: [...this.peers.values()].map((p) => ({
        peerId: p.peerId,
        name: p.name,
        platform: p.platform,
        status: p.status,
        rtt: p.rtt,
      })),
      chats: this.chats,
      transfers: this.transfers.map((t) => ({ ...t })),
      clips: this.clips,
      toasts: this.toasts,
      sentTotal: this.sentTotal,
      recvTotal: this.recvTotal,
    };
  }

  private schedule() {
    if (this.emitTimer != null) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.emitNow();
    }, 50);
  }

  private emitNow() {
    this.state = this.snapshot();
    for (const l of this.listeners) l();
  }

  // ---- public actions ----

  setName(name: string) {
    const n = name.trim().slice(0, 32);
    if (!n || n === this.selfName) return;
    this.selfName = n;
    this.sig.updateName(n);
    this.broadcastControl({ t: "hello", name: n, platform: platformLabel() });
    this.schedule();
  }

  sendChat(text: string) {
    const t = text.trim();
    if (!t) return;
    const msg: ChatMsg = {
      id: rid(),
      peerId: this.selfId,
      name: this.selfName,
      text: t,
      at: Date.now(),
      mine: true,
    };
    this.chats = [...this.chats, msg];
    this.schedule();
    this.broadcastControl({ t: "chat", id: msg.id, text: t, at: msg.at });
  }

  sendClipboardText(text: string) {
    const t = text.trim();
    if (!t) return;
    const id = rid();
    const at = Date.now();
    this.clips = [
      ...this.clips,
      { id, at, peerId: this.selfId, peerName: this.selfName, kind: "text", text: t },
    ];
    this.schedule();
    this.broadcastControl({ t: "clip", id, text: t, at });
  }

  sendFiles(files: File[] | FileList, kind: ShareKind = "file") {
    const list = Array.from(files).filter((f) => f && f.size >= 0);
    if (!list.length) return;
    const openPeers = [...this.peers.values()].filter((p) => p.dc?.readyState === "open");
    for (const file of list) {
      const view: TransferView = {
        id: rid(),
        dir: "out",
        peerId: this.selfId,
        peerName: this.selfName,
        name: file.name || "file",
        size: file.size,
        mime: file.type || "application/octet-stream",
        kind,
        status: "queued",
        bytes: 0,
        speed: 0,
        at: Date.now(),
      };
      this.transfers = [view, ...this.transfers];
      if (openPeers.length) {
        for (const ctx of openPeers) this.enqueue(ctx, view, file, kind);
      } else {
        this.deferred.push({ view, file, kind });
      }
    }
    if (!openPeers.length) {
      this.toast("Waiting for a peer — files will send automatically when someone joins", "info");
    }
    this.schedule();
  }

  cancelTransfer(id: string) {
    const t = this.transfers.find((x) => x.id === id);
    if (!t || t.status === "done" || t.status === "cancelled") return;
    if (t.dir === "out") {
      this.deferred = this.deferred.filter((d) => d.view.id !== id);
      for (const jobs of this.outJobs.values()) {
        for (const j of jobs) if (j.view.id === id) j.view.status = "cancelled";
      }
    } else {
      for (const p of this.peers.values()) {
        if (p.incoming?.view.id === id) {
          p.incoming = null;
          void this.sendControl(p, { t: "file-cancel", id });
        }
      }
    }
    t.status = "cancelled";
    this.schedule();
  }

  clearFinishedTransfers() {
    const keep = this.transfers.filter((t) => t.status === "queued" || t.status === "active");
    const clipUrls = new Set(this.clips.map((c) => (c.kind === "image" ? c.blobUrl : "")));
    for (const t of this.transfers) {
      if (t.blobUrl && !keep.includes(t) && !clipUrls.has(t.blobUrl))
        URL.revokeObjectURL(t.blobUrl);
    }
    this.transfers = keep;
    this.schedule();
  }

  clearChat() {
    this.chats = [];
    this.schedule();
  }

  clearClips() {
    const transferUrls = new Set(this.transfers.map((t) => t.blobUrl ?? ""));
    for (const c of this.clips) {
      if (c.kind === "image" && !transferUrls.has(c.blobUrl)) URL.revokeObjectURL(c.blobUrl);
    }
    this.clips = [];
    this.schedule();
  }

  toast(msg: string, kind: Toast["kind"] = "info") {
    const t: Toast = { id: this.toastSeq++, msg, kind };
    this.toasts = [...this.toasts, t];
    this.schedule();
    setTimeout(() => {
      this.toasts = this.toasts.filter((x) => x.id !== t.id);
      this.schedule();
    }, 4000);
  }

  dispose() {
    this.disposed = true;
    this.sig.close();
    for (const p of this.peers.values()) this.teardownPeer(p);
    this.peers.clear();
    for (const probe of this.probes.values()) probe.close();
    this.probes.clear();
    for (const t of this.transfers) if (t.blobUrl) URL.revokeObjectURL(t.blobUrl);
    for (const c of this.clips) if (c.kind === "image") URL.revokeObjectURL(c.blobUrl);
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.listeners.clear();
  }

  // ---- signaling ----

  private onSignalStatus(s: SignalStatus) {
    this.signalStatus = s;
    if (s === "online") {
      if (this.hadSession) {
        // fresh websocket session: rebuild the mesh from the new welcome
        for (const p of this.peers.values()) this.teardownPeer(p);
        this.peers.clear();
      }
      this.hadSession = true;
    }
    this.schedule();
  }

  private onServerMsg(m: ServerMsgType) {
    switch (m.t) {
      case "welcome":
        this.addresses = m.addresses;
        for (const p of m.peers) this.ensurePeer(p.peerId, p.name);
        this.schedule();
        break;
      case "peer-join":
        this.ensurePeer(m.peerId, m.name);
        this.toast(`${m.name} joined`, "success");
        break;
      case "peer-leave": {
        const p = this.peers.get(m.peerId);
        if (p) {
          this.toast(`${p.name} left`, "info");
          this.teardownPeer(p);
          this.peers.delete(m.peerId);
          this.schedule();
        }
        break;
      }
      case "peer-name": {
        const p = this.peers.get(m.peerId);
        if (p) {
          p.name = m.name;
          this.schedule();
        }
        break;
      }
      case "signal": {
        const probe = this.probes.get(m.from);
        if (probe) void probe.onSignal(m.data);
        else void this.onSignal(m.from, m.data);
        break;
      }
      case "probe-request":
        this.startProbe(m.from);
        break;
      case "error":
        this.toast(m.message, "error");
        break;
    }
  }

  // ---- discovery probes ----

  // Host-only verification: a home-page prober proves it shares our LAN.
  // Kept fully separate from PeerCtx so probing never touches the room UI.
  private startProbe(probeId: string) {
    if (this.disposed || this.probes.has(probeId) || this.probes.size >= 3) return;
    const probe = new LanProbe({
      initiator: true,
      onSignal: (data) => this.sig.send({ t: "signal", to: probeId, data }),
      onConnected: () => {
        // linger briefly so the prober sees the open channel, then clean up
        setTimeout(() => this.stopProbe(probeId), 250);
      },
    });
    this.probes.set(probeId, probe);
  }

  private stopProbe(probeId: string) {
    this.probes.get(probeId)?.close();
    this.probes.delete(probeId);
  }

  // ---- perfect negotiation mesh ----

  private ensurePeer(peerId: string, name?: string): PeerCtx {
    if (peerId === this.selfId) throw new Error("self as peer");
    const existing = this.peers.get(peerId);
    if (existing) {
      if (name && existing.name === "peer") {
        existing.name = name;
        this.schedule();
      }
      return existing;
    }
    const polite = this.selfId < peerId;
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS, iceCandidatePoolSize: 2 });
    const ctx: PeerCtx = {
      peerId,
      name: name || "peer",
      platform: "",
      polite,
      pc,
      dc: null,
      status: "connecting",
      makingOffer: false,
      ignoreOffer: false,
      settingRemoteAnswer: false,
      pendingCandidates: [],
      pingTimer: null,
      rtt: null,
      queue: [],
      pumping: false,
      maxChunk: 64 * 1024,
      incoming: null,
      retriedIce: false,
    };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.sig.send({ t: "signal", to: peerId, data: candidate.toJSON() });
    };
    pc.onnegotiationneeded = async () => {
      try {
        ctx.makingOffer = true;
        await pc.setLocalDescription();
        const ld = pc.localDescription;
        if (ld) this.sig.send({ t: "signal", to: peerId, data: { type: ld.type, sdp: ld.sdp } });
      } catch (err) {
        console.warn("negotiation failed", err);
      } finally {
        ctx.makingOffer = false;
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") {
        if (!ctx.retriedIce) {
          ctx.retriedIce = true;
          ctx.status = "connecting";
          try {
            pc.restartIce();
          } catch {}
          this.schedule();
        } else {
          ctx.status = "failed";
          this.schedule();
        }
      }
    };
    pc.ondatachannel = (ev) => this.attachChannel(ctx, ev.channel);
    this.peers.set(peerId, ctx);
    if (!polite) {
      // deterministic initiator creates the data channel
      this.attachChannel(ctx, pc.createDataChannel("maishare", { ordered: true }));
    }
    this.schedule();
    return ctx;
  }

  private async onSignal(peerId: string, data: unknown) {
    let ctx: PeerCtx;
    try {
      ctx = this.ensurePeer(peerId);
    } catch {
      return;
    }
    const desc = data as { type?: RTCSdpType; sdp?: string };
    try {
      if (desc && desc.sdp !== undefined) {
        const readyForOffer =
          !ctx.makingOffer && (ctx.pc.signalingState === "stable" || ctx.settingRemoteAnswer);
        const offerCollision = desc.type === "offer" && !readyForOffer;
        ctx.ignoreOffer = !ctx.polite && offerCollision;
        if (ctx.ignoreOffer) return;
        await ctx.pc.setRemoteDescription(desc as RTCSessionDescriptionInit);
        const pending = ctx.pendingCandidates;
        ctx.pendingCandidates = [];
        for (const cand of pending) {
          try {
            await ctx.pc.addIceCandidate(cand);
          } catch {}
        }
        ctx.settingRemoteAnswer = desc.type === "answer";
        await ctx.pc.setLocalDescription();
        ctx.settingRemoteAnswer = false;
        const ld = ctx.pc.localDescription;
        if (ld) this.sig.send({ t: "signal", to: peerId, data: { type: ld.type, sdp: ld.sdp } });
      } else {
        const cand = data as RTCIceCandidateInit;
        if (!ctx.pc.remoteDescription) {
          ctx.pendingCandidates.push(cand);
        } else {
          try {
            await ctx.pc.addIceCandidate(cand);
          } catch (err) {
            if (!ctx.ignoreOffer) console.warn("addIceCandidate failed", err);
          }
        }
      }
    } catch (err) {
      console.warn("signal error", err);
    }
  }

  private attachChannel(ctx: PeerCtx, dc: RTCDataChannel) {
    ctx.dc = dc;
    dc.binaryType = "arraybuffer";
    dc.bufferedAmountLowThreshold = BUFFER_LOW;
    dc.onopen = () => {
      ctx.status = "open";
      // RTCDataChannel.sctp was dropped from lib.dom; maxMessageSize is still
      // exposed on it at runtime
      const sctp = (dc as unknown as { sctp?: { maxMessageSize?: number } | null }).sctp;
      const mms = sctp?.maxMessageSize;
      ctx.maxChunk = Math.max(16 * 1024, Math.min(mms ?? 65536, 256 * 1024));
      this.startPing(ctx);
      this.flushDeferred(ctx);
      void this.sendControl(ctx, { t: "hello", name: this.selfName, platform: platformLabel() });
      void this.pump(ctx);
      this.schedule();
    };
    dc.onclose = () => {
      if (ctx.status === "open") {
        ctx.status = "closed";
        this.failPeerTransfers(ctx, "connection closed");
        this.schedule();
      }
    };
    dc.onmessage = (ev) => this.onFrame(ctx, ev.data);
  }

  private startPing(ctx: PeerCtx) {
    if (ctx.pingTimer) clearInterval(ctx.pingTimer);
    ctx.pingTimer = setInterval(() => {
      if (ctx.dc?.readyState === "open") void this.sendControl(ctx, { t: "ping", at: Date.now() });
    }, PING_EVERY);
  }

  private flushDeferred(ctx: PeerCtx) {
    if (!this.deferred.length) return;
    const items = this.deferred;
    this.deferred = [];
    for (const d of items) this.enqueue(ctx, d.view, d.file, d.kind);
  }

  private enqueue(ctx: PeerCtx, view: TransferView, file: File, kind: ShareKind) {
    const job: SendJob = { view, file, kind, bytesSent: 0, done: false, failed: false };
    let jobs = this.outJobs.get(view.id);
    if (!jobs) {
      jobs = new Set();
      this.outJobs.set(view.id, jobs);
    }
    jobs.add(job);
    ctx.queue.push(job);
    void this.pump(ctx);
  }

  // ---- frame io ----

  private async sendControl(ctx: PeerCtx, c: Control) {
    const dc = ctx.dc;
    if (!dc || dc.readyState !== "open") return;
    const json = encoder.encode(JSON.stringify(c));
    const frame = this.cipher
      ? await this.cipher.seal(FRAME.CONTROL_ENC, json)
      : concatFrame(FRAME.CONTROL, json);
    if (dc.readyState === "open") {
      try {
        dc.send(frame);
      } catch {}
    }
  }

  private broadcastControl(c: Control) {
    for (const p of this.peers.values()) void this.sendControl(p, c);
  }

  private onFrame(ctx: PeerCtx, data: unknown) {
    if (typeof data === "string") return;
    const u8 = new Uint8Array(data as ArrayBuffer);
    if (!u8.length) return;
    const type = u8[0];
    const body = u8.subarray(1);
    switch (type) {
      case FRAME.CONTROL:
        this.onControl(ctx, JSON.parse(decoder.decode(body)) as Control);
        break;
      case FRAME.CONTROL_ENC:
        if (this.cipher)
          this.cipher
            .open(body)
            .then((pt) => this.onControl(ctx, JSON.parse(decoder.decode(pt)) as Control))
            .catch(() => {});
        break;
      case FRAME.CHUNK:
        this.onChunk(ctx, body);
        break;
      case FRAME.CHUNK_ENC:
        if (this.cipher)
          this.cipher
            .open(body)
            .then((pt) => this.onChunk(ctx, pt))
            .catch(() => {});
        break;
    }
  }

  private onControl(ctx: PeerCtx, c: Control) {
    switch (c.t) {
      case "hello":
        ctx.name = c.name || ctx.name;
        ctx.platform = c.platform;
        this.schedule();
        break;
      case "chat":
        this.chats = [
          ...this.chats,
          { id: c.id, peerId: ctx.peerId, name: ctx.name, text: c.text, at: c.at, mine: false },
        ];
        this.schedule();
        break;
      case "clip":
        this.clips = [
          ...this.clips,
          {
            id: c.id,
            at: c.at,
            peerId: ctx.peerId,
            peerName: ctx.name,
            kind: "text",
            text: c.text,
          },
        ];
        this.schedule();
        break;
      case "file-start": {
        const view: TransferView = {
          id: c.id,
          dir: "in",
          peerId: ctx.peerId,
          peerName: ctx.name,
          name: c.name,
          size: c.size,
          mime: c.mime,
          kind: c.kind,
          status: "active",
          bytes: 0,
          speed: 0,
          at: Date.now(),
        };
        ctx.incoming = {
          view,
          chunks: [],
          startedAt: performance.now(),
          lastEmitAt: performance.now(),
          lastEmitBytes: 0,
        };
        this.transfers = [view, ...this.transfers];
        this.schedule();
        break;
      }
      case "file-end":
        this.finishIncoming(ctx, c.id);
        break;
      case "file-cancel": {
        if (ctx.incoming?.view.id === c.id) ctx.incoming = null;
        const t = this.transfers.find((x) => x.id === c.id);
        if (t && t.status === "active") {
          t.status = "cancelled";
          this.schedule();
        }
        break;
      }
      case "ping":
        void this.sendControl(ctx, { t: "pong", at: c.at });
        break;
      case "pong":
        ctx.rtt = Math.max(0, Date.now() - c.at);
        this.schedule();
        break;
      case "bye":
        this.onServerMsg({ t: "peer-leave", peerId: ctx.peerId });
        break;
    }
  }

  private onChunk(ctx: PeerCtx, body: Uint8Array<ArrayBuffer>) {
    const inc = ctx.incoming;
    if (!inc) return;
    inc.chunks.push(body);
    inc.view.bytes += body.byteLength;
    this.recvTotal += body.byteLength;
    const now = performance.now();
    if (now - inc.lastEmitAt > 120) {
      const dt = (now - inc.lastEmitAt) / 1000;
      if (dt > 0) inc.view.speed = (inc.view.bytes - inc.lastEmitBytes) / dt;
      inc.lastEmitAt = now;
      inc.lastEmitBytes = inc.view.bytes;
      this.schedule();
    }
  }

  private finishIncoming(ctx: PeerCtx, id: string) {
    const inc = ctx.incoming;
    if (!inc || inc.view.id !== id) return;
    ctx.incoming = null;
    const v = inc.view;
    const blob = new Blob(inc.chunks, { type: v.mime });
    v.blob = blob;
    v.blobUrl = URL.createObjectURL(blob);
    v.status = "done";
    const secs = (performance.now() - inc.startedAt) / 1000;
    v.speed = secs > 0 ? v.size / secs : 0;
    v.bytes = v.size;
    if (v.kind === "clip") {
      this.clips = [
        ...this.clips,
        {
          id: v.id,
          at: v.at,
          peerId: v.peerId,
          peerName: v.peerName,
          kind: "image",
          mime: v.mime,
          size: v.size,
          blobUrl: v.blobUrl,
          blob,
        },
      ];
    }
    this.schedule();
  }

  // ---- sending (single active file per connection, chat interleaves) ----

  private async pump(ctx: PeerCtx) {
    if (ctx.pumping) return;
    ctx.pumping = true;
    try {
      while (ctx.queue.length && !this.disposed) {
        const job = ctx.queue.shift()!;
        await this.runJob(ctx, job);
      }
    } finally {
      ctx.pumping = false;
    }
  }

  private async runJob(ctx: PeerCtx, job: SendJob) {
    const { view, file } = job;
    if (view.status === "cancelled") return;
    view.status = "active";
    const chunkSize = Math.max(4096, ctx.maxChunk - (this.cipher ? ENC_OVERHEAD : 1));
    await this.sendControl(ctx, {
      t: "file-start",
      id: view.id,
      name: file.name || "file",
      size: file.size,
      mime: file.type || "application/octet-stream",
      kind: job.kind,
    });
    let offset = 0;
    let lastEmitAt = performance.now();
    let lastEmitBytes = 0;
    while (offset < file.size) {
      const dc = ctx.dc;
      if (!dc || dc.readyState !== "open") {
        job.failed = true;
        this.recomputeOutgoing(view);
        this.schedule();
        return;
      }
      if (this.isCancelled(view)) {
        await this.sendControl(ctx, { t: "file-cancel", id: view.id });
        this.schedule();
        return;
      }
      if (dc.bufferedAmount > BUFFER_HIGH) await this.waitForDrain(ctx);
      const slice = await file.slice(offset, offset + chunkSize).arrayBuffer();
      const u8 = new Uint8Array(slice);
      const frame = this.cipher
        ? await this.cipher.seal(FRAME.CHUNK_ENC, u8)
        : concatFrame(FRAME.CHUNK, u8);
      try {
        dc.send(frame);
      } catch {
        job.failed = true;
        this.recomputeOutgoing(view);
        this.schedule();
        return;
      }
      offset += u8.byteLength;
      job.bytesSent = offset;
      this.sentTotal += u8.byteLength;
      const now = performance.now();
      if (now - lastEmitAt > 150) {
        const dt = (now - lastEmitAt) / 1000;
        if (dt > 0) view.speed = (offset - lastEmitBytes) / dt;
        lastEmitAt = now;
        lastEmitBytes = offset;
        this.recomputeOutgoing(view);
        this.schedule();
      }
    }
    job.done = true;
    this.recomputeOutgoing(view);
    await this.sendControl(ctx, { t: "file-end", id: view.id });
    this.schedule();
  }

  private recomputeOutgoing(view: TransferView) {
    const jobs = this.outJobs.get(view.id);
    if (!jobs || !jobs.size) return;
    let bytes = Infinity;
    let anyActive = false;
    for (const j of jobs) {
      bytes = Math.min(bytes, j.bytesSent);
      if (j.done) continue;
      if (j.failed) continue;
      anyActive = true;
    }
    view.bytes = bytes === Infinity ? view.bytes : bytes;
    if (anyActive) {
      if (view.status !== "cancelled") view.status = "active";
    } else {
      view.status = "done";
      this.outJobs.delete(view.id);
    }
  }

  private isCancelled(view: TransferView): boolean {
    return view.status === "cancelled";
  }

  private waitForDrain(ctx: PeerCtx): Promise<void> {
    return new Promise((resolve) => {
      const dc = ctx.dc;
      if (!dc) return resolve();
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        dc.removeEventListener("bufferedamountlow", onLow);
        clearTimeout(timer);
        resolve();
      };
      const onLow = () => finish();
      const timer = setTimeout(finish, 4000);
      dc.addEventListener("bufferedamountlow", onLow, { once: true });
    });
  }

  // ---- teardown ----

  private failPeerTransfers(ctx: PeerCtx, _reason: string) {
    for (const t of this.transfers) {
      if (t.peerId === ctx.peerId && (t.status === "active" || t.status === "queued")) {
        t.status = "error";
      }
    }
    if (ctx.incoming) ctx.incoming = null;
    const dead = [...this.outJobs.entries()].filter(([, jobs]) =>
      [...jobs].some((j) => jobs.size && j.view.peerId === ctx.peerId),
    );
    for (const [id] of dead) this.outJobs.delete(id);
  }

  private teardownPeer(p: PeerCtx) {
    p.pc.onicecandidate = null;
    p.pc.onnegotiationneeded = null;
    p.pc.onconnectionstatechange = null;
    p.pc.ondatachannel = null;
    if (p.pingTimer) clearInterval(p.pingTimer);
    try {
      p.dc?.close();
    } catch {}
    try {
      p.pc.close();
    } catch {}
    this.failPeerTransfers(p, "peer left");
  }
}

type ServerMsgType = import("./signaling").ServerMsg;
