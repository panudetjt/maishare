import { platformLabel, uuid } from "../device";
import { resolveMime, sniffBlob, sniffBytes, suspiciousMismatch, type SniffInfo } from "../magika";
import { concatFrame, decoder, encoder, ENC_OVERHEAD, FRAME, type Control } from "./protocol";
import { MAX_STREAMABLE_SIZE, pickIncomingSink, type IncomingSink } from "./spill";
import { RoomCipher } from "./crypto";
import { Signaling, type RoomTransport, type SignalStatus } from "./signaling";
import { LanProbe } from "./lan-probe";

const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
// Pause sending while the SCTP buffer is above HIGH; the bufferedamountlow
// event (threshold BUFFER_LOW) wakes the pump again.
const BUFFER_HIGH = 8 * 1024 * 1024;
const BUFFER_LOW = 2 * 1024 * 1024;
/** heartbeat interval; also drives the SEC-04 stale-transfer watchdog */
export const PING_EVERY = 4000;
/** A peer that never sends SDP could otherwise queue candidates forever (a
 * relayed flood costs it nothing); a real negotiation trickles only a handful
 * before the remote description lands, so past this the flood is dropped. */
export const MAX_PENDING_CANDIDATES = 32;

/** file-start string claims are clamped before any state is built from them */
export const MAX_NAME_CHARS = 256;
export const MAX_MIME_CHARS = 128;

/** per-message inbound chat cap (SEC-03) — mirrors the composer's maxLength,
 * so a peer's oversized frame is stored truncated to what we could have sent */
export const MAX_CHAT_CHARS = 8000;
/** retained chat messages (rolling cap, oldest dropped first) — keeps a peer
 * streaming maximal frames from growing memory and per-render cost unbounded */
export const MAX_RETAINED_CHATS = 200;

/** concurrent in-flight inbound transfers per peer (SEC-04). Chunks carry no
 * transfer id, so the protocol is one-at-a-time by construction: a file-start
 * arriving while one is in flight settles the previous as cancelled and is
 * bounced with explicit file-cancel backpressure. */
export const MAX_INCOMING_PER_PEER = 1;
/** how long a bounced peer must wait before its next file-start is accepted —
 * bounds the list a bare file-start flood can grow to (~1 entry/second) */
export const INCOMING_START_COOLDOWN_MS = 1000;
/** an inbound transfer with no chunk progress for this long has stalled and is
 * failed by the watchdog riding the per-peer ping interval (SEC-04) */
export const INCOMING_STALE_MS = 30_000;

/** inbound queue previews (file-queued) retained per peer. Announces are
 * informational only — beyond the cap they are dropped without backpressure,
 * because nothing on the sender waits for announce acceptance: the file-start
 * still creates the view when the transfer actually begins. */
export const MAX_QUEUED_INCOMING_PER_PEER = 128;
/** a queue preview with no file-start while the peer has nothing in flight
 * this long is dead — the sender's pump moves between files in milliseconds,
 * so a minute of total silence means the announced start never came. Retired
 * by the same ping-interval sweep that fails stalled actives. */
export const QUEUED_STALE_MS = 60_000;

/** how long after a *completed* inbound transfer its late tail chunks stay
 * silent — chunks carry no transfer id (SEC-04), so a tail arriving after the
 * file-end can only be wire reorder or a sender flush of a file the receiver
 * already holds whole; telling the user to resend here would be a false alarm */
export const DONE_TAIL_GRACE_MS = 15_000;
/** file-cancel reason sent back when a transfer is retired as stale — one
 * string shared by the watchdog and the bulk Clear */
export const STALE_CANCEL_REASON = "stalled";

/** roster-driven mesh fan-out cap (SEC-05): peer contexts beyond this stay
 * inert — no RTCPeerConnection, no data channel, no offers */
export const MAX_PEERS = 12;
/** a peer still 'connecting' with no remote description this long is a phantom
 * join: its context is evicted instead of holding heavyweight allocations */
export const CONNECT_TIMEOUT_MS = 10_000;
/** cadence of the client-side phantom-peer sweep */
const SWEEP_EVERY = 5_000;

export type PeerStatus = "connecting" | "open" | "closed" | "failed";

/** one blocking consent decision per unproven peer (keyed rooms only) */
export interface ConsentRequest {
  peerId: string;
  name: string;
}

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
  /** set when the text was sent together with file attachments */
  groupId?: string;
  /** arrived sealed with the room key (false = DTLS transport only) */
  sealed?: boolean;
  /** placeholder for a frame that could not be read — never sent anywhere */
  system?: boolean;
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
  status: TransferStatus;
  bytes: number;
  speed: number;
  at: number;
  /** files attached to one message share a group — drives the lightbox gallery */
  groupId: string;
  /** arrived sealed with the room key (false = DTLS transport only) */
  sealed?: boolean;
  blobUrl?: string;
  blob?: Blob;
  /** content-derived type from Magika sniffing — absent until the wasm runs
   * or when it could not be loaded */
  detected?: SniffInfo;
}

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
  toasts: Toast[];
  /** unproven peers awaiting the sender's explicit plaintext-consent decision */
  consents: ConsentRequest[];
  /** keyless peers awaiting the key-share approval decision */
  keyRequests: ConsentRequest[];
  /** the room key this client acquired at runtime via key-offer (null when
   * it joined holding the invite key or the room has none) — lets the page
   * repair its invite URL and recents after a LAN-list join */
  selfKey: string | null;
  /** SEC-11: server-elected room host (null = no server announcement) */
  hostId: string | null;
  /** SEC-11: who may approve key shares — "host" default, "anyone" opt-in */
  keyShare: "host" | "anyone";
  /** the room host removed this client from the room */
  kicked: boolean;
  sentTotal: number;
  recvTotal: number;
}

interface SendJob {
  view: TransferView;
  file: File;
  bytesSent: number;
  done: boolean;
  failed: boolean;
}

interface Incoming {
  view: TransferView;
  /** where received bytes go — RAM for small transfers, OPFS disk beyond
   * RAM_BUFFER_LIMIT, so multi-GB files never have to fit in memory */
  sink: IncomingSink;
  startedAt: number;
  lastEmitAt: number;
  lastEmitBytes: number;
  /** monotonic timestamp of the last accepted chunk — drives the stale sweep */
  lastProgress: number;
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
  /** peer claims WebCrypto capability (crypto.subtle) — proof is still pending */
  e2e: boolean;
  /** peer proved room-key possession by echoing our sealed nonce pong */
  proven: boolean;
  /** user explicitly consented to plaintext delivery to this peer */
  consented: boolean;
  /** user refused consent — never prompt again for this connection */
  consentDenied: boolean;
  /** outstanding key-proof nonce we sealed into a challenge ping */
  proofNonce: string | null;
  /** payload frames held back until the peer proves or is consented */
  withheldChats: Control[];
  withheldFiles: { view: TransferView; file: File }[];
  /** after a bounced file-start, further starts wait out the cooldown */
  startBlockedUntil: number;
  /** when the peer context was allocated (monotonic) — drives the phantom-join sweep */
  createdAt: number;
  /** performance.now() of this connection's last *completed* inbound transfer —
   * gates the orphan-chunk alarm so a finished file's late tail stays silent */
  lastDoneAt: number | null;
  /** one unreadable-frame warning per connection — no toast storms */
  undecryptableWarned: boolean;
  /** we asked this peer to share the room key (once per connection) */
  keyRequested: boolean;
  /** the user answered the key-share prompt for this peer (either way) */
  keyShareDecided: boolean;
}

function rid(): string {
  return uuid();
}

/** hello.e2e declares WebCrypto capability only — crypto.subtle needs a
 * secure context (iOS Safari on plain LAN http has none). Room-key
 * possession is proven separately by the sealed nonce exchange, never by
 * this self-asserted flag. */
function hasCrypto(): boolean {
  return typeof crypto !== "undefined" && crypto.subtle != null;
}

/** how a control frame chooses its sealed form in sendControl */
type SealMode = "auto" | "plain" | "proof";

/** Wait for host-candidate gathering so localDescription is a complete SDP. */
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

export class RoomClient {
  readonly roomId: string;
  readonly selfId = rid();
  private selfName: string;
  private cipher: RoomCipher | null = null;
  /** the raw key bytes behind `cipher` — needed to answer key-offer requests;
   * lives only in this tab's memory (never sent to the server) */
  private roomKey: string | null = null;
  private readonly cipherReady: Promise<void>;
  /** WS signaling by default; Nearby swaps in a DirectTransport */
  private readonly sig: RoomTransport;
  /** gather all candidates into every offer/answer (QR signaling) */
  private readonly gatherSdp: boolean;
  private readonly iceServers: RTCIceServer[];
  /** fixed impolite/impolite role for single-peer transports */
  private readonly initiatorOverride: boolean | undefined;
  private readonly peers = new Map<string, PeerCtx>();
  /** in-flight discovery verification probes, keyed by the prober's id */
  private readonly probes = new Map<string, LanProbe>();
  /** one content-sniff job per outgoing transfer, keyed by transfer id */
  private readonly sniffJobs = new Map<string, Promise<void>>();
  private readonly outJobs = new Map<string, Set<SendJob>>();
  private deferred: { view: TransferView; file: File }[] = [];
  /** chat frames sent while no peer was connected, flushed on the first open */
  private pendingChats: Control[] = [];
  private chats: ChatMsg[] = [];
  private transfers: TransferView[] = [];
  private toasts: Toast[] = [];
  private consents: ConsentRequest[] = [];
  private keyRequests: ConsentRequest[] = [];
  private sentTotal = 0;
  private recvTotal = 0;
  private addresses: string[] = [];
  private signalStatus: SignalStatus = "connecting";
  private hadSession = false;
  /** SEC-11: server-elected room host (null when the server predates it or
   * there is no server — Nearby); null falls back to the any-member policy */
  private hostId: string | null = null;
  /** SEC-11: who may approve key shares — "host" by default, "anyone" when
   * the room was created with the opt-in (or no server announced a policy) */
  private keyShare: "host" | "anyone" = "host";
  /** the host removed us from the room — surfaces in the UI, never reconnects */
  private kicked = false;
  private started = false;
  private disposed = false;
  private toastSeq = 1;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private readonly listeners = new Set<() => void>();
  private state: RoomState;

  constructor(opts: {
    roomId: string;
    key?: string;
    name: string;
    /** omit for the default WebSocket signaling transport */
    transport?: RoomTransport;
    /** gather candidates into SDP instead of trickling (QR signaling) */
    gatherSdp?: boolean;
    /** defaults to STUN for rooms; Nearby passes [] (host-only, no internet) */
    iceServers?: RTCIceServer[];
    /** fixed perfect-negotiation role for single-peer direct sessions */
    initiator?: boolean;
    /** SEC-11: creator opt-in — any member may approve key shares (travels to
     * the DO, which honors it only from the room's first member) */
    keyShare?: "anyone";
  }) {
    this.roomId = opts.roomId;
    this.selfName = opts.name;
    this.gatherSdp = opts.gatherSdp ?? false;
    this.iceServers = opts.iceServers ?? ICE_SERVERS;
    this.initiatorOverride = opts.initiator;
    if (opts.key) this.roomKey = opts.key;
    this.cipherReady = opts.key
      ? RoomCipher.fromKey(opts.key).then(
          (c) => {
            this.cipher = c;
          },
          () => {},
        )
      : Promise.resolve();
    this.state = this.snapshot();
    const signaling = new Signaling({
      roomId: opts.roomId,
      peerId: this.selfId,
      name: opts.name,
      keyShare: opts.keyShare,
    });
    this.sig = opts.transport ?? signaling;
    this.sig.bind({
      onMessage: (m) => this.onServerMsg(m),
      onStatus: (s) => this.onSignalStatus(s),
    });
  }

  async start() {
    if (this.started || this.disposed) return;
    this.started = true;
    await this.cipherReady;
    if (this.disposed) return;
    this.sig.connect();
    // SEC-05: periodic sweep evicts phantom peer contexts that never connect
    if (!this.sweepTimer) {
      this.sweepTimer = setInterval(() => this.sweepPeers(), SWEEP_EVERY);
    }
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
      toasts: this.toasts,
      consents: this.consents,
      keyRequests: this.keyRequests,
      selfKey: this.roomKey,
      hostId: this.hostId,
      keyShare: this.keyShare,
      kicked: this.kicked,
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
    this.broadcastControl({
      t: "hello",
      name: n,
      platform: platformLabel(),
      e2e: hasCrypto(),
      keyed: this.cipher != null,
    });
    this.schedule();
  }

  sendChat(text: string, groupId?: string) {
    const t = text.trim();
    if (!t) return;
    const openPeers = [...this.peers.values()].filter((p) => p.dc?.readyState === "open");
    // truth at send time: sealed only when WE have a key and every connected
    // peer has proven key possession; with nobody connected we don't know yet
    // (undefined, shown neutrally)
    const sealed =
      openPeers.length === 0 ? undefined : this.cipher !== null && openPeers.every((p) => p.proven);
    const msg: ChatMsg = {
      id: rid(),
      peerId: this.selfId,
      name: this.selfName,
      text: t,
      at: Date.now(),
      mine: true,
      groupId,
      sealed,
    };
    this.chats = [...this.chats, msg];
    this.capChats();
    this.schedule();
    const frame: Control = { t: "chat", id: msg.id, text: t, at: msg.at, g: groupId };
    if (openPeers.length) {
      // keyed rooms withhold payloads from peers that neither proved key
      // possession nor drew an explicit consent — never downgrade to plaintext
      for (const ctx of openPeers) {
        if (this.deliverable(ctx)) void this.sendControl(ctx, frame);
        else ctx.withheldChats.push(frame);
      }
    } else {
      this.pendingChats.push(frame);
    }
  }

  /** one message = optional text + optional files, all sharing one group id.
   * Returns the outbound transfer views it created (empty for text-only) so
   * callers — the WebMCP tools in particular — get ids without waiting out
   * the 50 ms snapshot debounce */
  sendMessage(text: string, files: File[] | FileList): TransferView[] {
    const t = text.trim();
    const list = Array.from(files).filter((f) => f && f.size >= 0);
    if (!t && !list.length) return [];
    if (!list.length) {
      this.sendChat(t);
      return [];
    }
    const groupId = rid();
    if (t) this.sendChat(t, groupId);
    return this.sendFiles(list, groupId);
  }

  sendFiles(files: File[] | FileList, groupId: string = rid()): TransferView[] {
    const list = Array.from(files).filter((f) => f && f.size >= 0);
    if (!list.length) return [];
    const openPeers = [...this.peers.values()].filter((p) => p.dc?.readyState === "open");
    const sealed =
      openPeers.length === 0 ? undefined : this.cipher !== null && openPeers.every((p) => p.proven);
    const views: TransferView[] = [];
    for (const file of list) {
      const isImage = (file.type || "").startsWith("image/");
      const view: TransferView = {
        id: rid(),
        dir: "out",
        peerId: this.selfId,
        peerName: this.selfName,
        name: file.name || "file",
        size: file.size,
        mime: file.type || "application/octet-stream",
        status: "queued",
        bytes: 0,
        speed: 0,
        at: Date.now(),
        groupId,
        sealed,
        // keep the source bytes so the message can be resent later; the
        // blobUrl preview is only needed for images
        blob: file,
        ...(isImage ? { blobUrl: URL.createObjectURL(file) } : {}),
      };
      this.transfers = [view, ...this.transfers];
      views.push(view);
      // content-type sniffing kicks off immediately so queued/deferred files
      // already show the right preview and icon
      void this.sniffTransfer(view, file);
      if (openPeers.length) {
        for (const ctx of openPeers) {
          if (this.deliverable(ctx)) this.enqueue(ctx, view, file);
          else ctx.withheldFiles.push({ view, file });
        }
      } else {
        this.deferred.push({ view, file });
      }
    }
    if (!openPeers.length) {
      this.toast("Waiting for a peer — files will send automatically when someone joins", "info");
    }
    this.schedule();
    return views;
  }

  /**
   * Identify the file's real type from its bytes (Magika wasm, lazy-loaded)
   * and patch the view in place: mime, detected info, and a preview URL when
   * it turns out to be an image. One job per transfer id; runJob awaits it so
   * the file-start frame carries the sniffed mime.
   */
  private sniffTransfer(view: TransferView, file: Blob): Promise<void> {
    let job = this.sniffJobs.get(view.id);
    if (job) return job;
    job = (async () => {
      const info = await sniffBlob(file);
      if (this.disposed || !info) return;
      view.detected = info;
      view.mime = resolveMime(view.mime, info);
      if (view.mime.startsWith("image/") && !view.blobUrl) {
        view.blobUrl = URL.createObjectURL(file);
      }
      this.schedule();
    })();
    this.sniffJobs.set(view.id, job);
    return job;
  }

  cancelTransfer(id: string) {
    const t = this.transfers.find((x) => x.id === id);
    if (!t || t.status === "done" || t.status === "cancelled") return;
    if (t.dir === "out") {
      this.deferred = this.deferred.filter((d) => d.view.id !== id);
      for (const p of this.peers.values()) {
        // peers previewing this file from our queue announce must hear the
        // cancel — a job still sitting in their sender's queue never reaches
        // the runJob path that notifies them on its own
        if (p.queue.some((j) => j.view.id === id)) {
          void this.sendControl(p, { t: "file-cancel", id });
        }
      }
      for (const jobs of this.outJobs.values()) {
        for (const j of jobs) if (j.view.id === id) j.view.status = "cancelled";
      }
    } else {
      for (const p of this.peers.values()) {
        if (p.incoming?.view.id === id) {
          p.incoming.sink.abort();
          p.incoming = null;
          void this.sendControl(p, { t: "file-cancel", id });
        }
      }
      // a cancelled queue preview holds no incoming slot — its sender-side job
      // is still queued, so the peer must be told or the file would start
      // arriving anyway
      const peer = this.peers.get(t.peerId);
      if (t.status === "queued" && peer) {
        void this.sendControl(peer, { t: "file-cancel", id });
      }
    }
    t.status = "cancelled";
    this.schedule();
  }

  clearFinishedTransfers() {
    // SEC-04: stale inbound 'active' entries are retired too, so the Clear
    // action always bounds the list; dropped entries release their URLs
    const stale = new Set<string>();
    for (const p of this.peers.values()) {
      const inc = p.incoming;
      if (inc && this.isIncomingStale(inc)) {
        stale.add(inc.view.id);
        inc.sink.abort();
        p.incoming = null;
        void this.sendControl(p, {
          t: "file-cancel",
          id: inc.view.id,
          reason: STALE_CANCEL_REASON,
        });
      }
    }
    const keep = this.transfers.filter(
      (t) => (t.status === "queued" || t.status === "active") && !stale.has(t.id),
    );
    for (const t of this.transfers) {
      if (t.blobUrl && !keep.includes(t)) URL.revokeObjectURL(t.blobUrl);
    }
    this.transfers = keep;
    this.schedule();
  }

  clearChat() {
    this.chats = [];
    this.pendingChats = [];
    this.schedule();
  }

  /** the user's answer to a consent prompt: allow releases the peer's
   * withheld payloads as plaintext, deny keeps withholding (both final) */
  respondConsent(peerId: string, allow: boolean) {
    if (!this.consents.some((q) => q.peerId === peerId)) return;
    this.consents = this.consents.filter((q) => q.peerId !== peerId);
    const ctx = this.peers.get(peerId);
    if (ctx) {
      if (allow) {
        ctx.consented = true;
        this.flushForPeer(ctx);
      } else {
        ctx.consentDenied = true;
      }
    }
    this.schedule();
  }

  /** the user's answer to a key-share request: allow sends the room key over
   * the DTLS-protected data channel so the joiner can prove possession and
   * take part end-to-end; deny ("keep them out") ALSO removes the joiner
   * from the room via a host-authoritative server kick — no key, no seat */
  respondKeyRequest(peerId: string, allow: boolean) {
    if (!this.keyRequests.some((q) => q.peerId === peerId)) return;
    this.keyRequests = this.keyRequests.filter((q) => q.peerId !== peerId);
    const ctx = this.peers.get(peerId);
    if (ctx) {
      ctx.keyShareDecided = true;
      if (allow && this.roomKey) {
        void this.sendControl(ctx, { t: "key-offer", k: this.roomKey }, "plain");
      } else if (!allow) {
        // the server enforces host authority; the client only makes the ask
        this.sig.send({ t: "kick", peerId });
      }
    }
    this.schedule();
  }

  /** hide a key-share prompt without deciding it (a non-host's "not now" —
   * the empowered member still sees and answers the request) */
  dismissKeyRequest(peerId: string) {
    this.keyRequests = this.keyRequests.filter((q) => q.peerId !== peerId);
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
    this.sniffJobs.clear();
    for (const t of this.transfers) if (t.blobUrl) URL.revokeObjectURL(t.blobUrl);
    if (this.emitTimer) clearTimeout(this.emitTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
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
        // prompts for old connections are stale — fresh peers re-request
        this.consents = [];
        this.keyRequests = [];
      }
      this.hadSession = true;
    }
    this.schedule();
  }

  private onServerMsg(m: ServerMsgType) {
    switch (m.t) {
      case "welcome":
        this.addresses = m.addresses;
        // SEC-11: the server elects the host and owns the key-share policy
        this.hostId = m.host ?? this.hostId;
        this.keyShare = m.ks ?? this.keyShare;
        // SEC-08: remember the ownership token and re-present it on every
        // retry/reconnect, so a dropped socket reclaims its own slot
        if (m.token) this.sig.setToken?.(m.token);
        // SEC-05: roster entries beyond the cap stay inert — no allocation
        for (const p of m.peers) this.ensurePeer(p.peerId, p.name);
        this.schedule();
        break;
      case "host":
        // SEC-11: re-election broadcast (the host left; next-oldest takes over)
        this.hostId = m.peerId;
        this.schedule();
        break;
      case "kicked":
        // SEC-11: the host removed us — tear the mesh down and surface it;
        // the signaling socket closes (4403) right after and must not retry
        this.kicked = true;
        for (const p of this.peers.values()) this.teardownPeer(p);
        this.peers.clear();
        this.consents = [];
        this.keyRequests = [];
        this.sig.close();
        this.toast("You were removed from the room by the host", "error");
        this.schedule();
        break;
      case "peer-join": {
        // a join beyond the cap is ignored entirely (no toast, no connection)
        if (this.ensurePeer(m.peerId, m.name)) this.toast(`${m.name} joined`, "success");
        break;
      }
      case "peer-leave": {
        const p = this.peers.get(m.peerId);
        if (p) {
          this.toast(`${p.name} left`, "info");
          this.removePeer(p);
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

  /** returns null when the mesh fan-out cap is reached — the roster entry
   * stays inert: no connection, no data channel, no offers (SEC-05) */
  private ensurePeer(peerId: string, name?: string): PeerCtx | null {
    if (peerId === this.selfId) throw new Error("self as peer");
    const existing = this.peers.get(peerId);
    if (existing) {
      if (name && existing.name === "peer") {
        existing.name = name;
        this.schedule();
      }
      return existing;
    }
    if (this.peers.size >= MAX_PEERS) return null;
    const polite = this.initiatorOverride != null ? !this.initiatorOverride : this.selfId < peerId;
    const pc = new RTCPeerConnection({ iceServers: this.iceServers, iceCandidatePoolSize: 2 });
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
      e2e: false,
      proven: false,
      consented: false,
      consentDenied: false,
      proofNonce: null,
      withheldChats: [],
      withheldFiles: [],
      startBlockedUntil: 0,
      createdAt: performance.now(),
      lastDoneAt: null,
      undecryptableWarned: false,
      keyRequested: false,
      keyShareDecided: false,
    };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.sig.send({ t: "signal", to: peerId, data: candidate.toJSON() });
    };
    pc.onnegotiationneeded = async () => {
      try {
        ctx.makingOffer = true;
        await pc.setLocalDescription();
        if (this.gatherSdp) await gathered(pc);
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
          // SEC-05: a failed connection releases its context instead of
          // persisting forever
          this.removePeer(ctx);
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
    let ctx: PeerCtx | null;
    try {
      ctx = this.ensurePeer(peerId);
    } catch {
      return;
    }
    if (!ctx) return; // inert roster entry beyond the fan-out cap
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
        // only an OFFER gets an answer. Responding to an ANSWER would call
        // setLocalDescription() in stable state — which every browser reads
        // as an implicit NEW offer — looping offer/answer through the relay
        // forever (the dominant measured DO flood, ~22 req/s for one pair).
        if (desc.type === "offer") {
          ctx.settingRemoteAnswer = false;
          await ctx.pc.setLocalDescription();
          if (this.gatherSdp) await gathered(ctx.pc);
          const ld = ctx.pc.localDescription;
          if (ld) this.sig.send({ t: "signal", to: peerId, data: { type: ld.type, sdp: ld.sdp } });
        } else {
          ctx.settingRemoteAnswer = false;
        }
      } else {
        const cand = data as RTCIceCandidateInit;
        if (!ctx.pc.remoteDescription) {
          if (ctx.pendingCandidates.length < MAX_PENDING_CANDIDATES) {
            ctx.pendingCandidates.push(cand);
          }
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
      // hello goes first and carries our crypto capability — queued traffic
      // must wait for the peer's hello when we seal, so nothing gets dropped
      // by a receiver that cannot open sealed frames
      void this.sendControl(ctx, {
        t: "hello",
        name: this.selfName,
        platform: platformLabel(),
        e2e: hasCrypto(),
        keyed: this.cipher != null,
      });
      // keyed rooms release deferred traffic only to deliverable peers; with
      // no key everyone is deliverable
      this.flushForPeer(ctx);
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
      // the per-peer ping interval doubles as the stale-transfer watchdog
      this.sweepIncoming(ctx);
    }, PING_EVERY);
  }

  /** SEC-04 watchdog riding the per-peer ping interval: an inbound transfer
   * with no chunk progress for INCOMING_STALE_MS has stalled — fail it instead
   * of leaving it 'active' forever; with nothing in flight, queue previews
   * whose file-start never came are retired after QUEUED_STALE_MS */
  private sweepIncoming(ctx: PeerCtx) {
    const inc = ctx.incoming;
    if (inc) {
      if (!this.isIncomingStale(inc)) return;
      ctx.incoming = null;
      inc.sink.abort();
      inc.view.status = "error";
      this.toast(`"${inc.view.name}" stalled — no data for a while, transfer failed`, "error");
      // the sender is still pumping into a dead transfer — tell it
      void this.sendControl(ctx, {
        t: "file-cancel",
        id: inc.view.id,
        reason: STALE_CANCEL_REASON,
      });
      this.schedule();
      return;
    }
    const now = Date.now();
    const dead = this.transfers.filter(
      (t) =>
        t.dir === "in" &&
        t.peerId === ctx.peerId &&
        t.status === "queued" &&
        now - t.at > QUEUED_STALE_MS,
    );
    if (!dead.length) return;
    for (const t of dead) t.status = "cancelled";
    this.toast(
      dead.length === 1
        ? `"${dead[0].name}" was announced but never started arriving — removed from the queue`
        : `${dead.length} announced files never started arriving — removed from the queue`,
      "info",
    );
    this.schedule();
  }

  private isIncomingStale(inc: Incoming): boolean {
    return performance.now() - inc.lastProgress > INCOMING_STALE_MS;
  }

  /** this peer's queue preview for id, if one is still waiting to start */
  private queuedPreview(ctx: PeerCtx, id: string): TransferView | undefined {
    return this.transfers.find(
      (t) => t.id === id && t.dir === "in" && t.peerId === ctx.peerId && t.status === "queued",
    );
  }

  private queuedIncomingCount(ctx: PeerCtx): number {
    let n = 0;
    for (const t of this.transfers) {
      if (t.dir === "in" && t.peerId === ctx.peerId && t.status === "queued") n++;
    }
    return n;
  }

  /** retire this peer's preview for id — the announced transfer will not
   * start (refused header), so the row must not linger as 'queued' */
  private settleQueuedPreview(ctx: PeerCtx, id: string) {
    const t = this.queuedPreview(ctx, id);
    if (t) {
      t.status = "cancelled";
      this.schedule();
    }
  }

  /** may payload frames (chat, file-start, chunks) be delivered to this peer?
   * Keyed rooms deliver SEALED frames to every WebCrypto-capable peer — proven
   * or not — so an unreadable message always shows up as an explicit
   * undecryptable bubble on the far side instead of silently vanishing
   * (ciphertext to a non-key-holder leaks nothing). Only peers with no
   * WebCrypto at all stay fully withheld until the user consents. */
  private deliverable(ctx: PeerCtx): boolean {
    return !this.cipher || ctx.consented || ctx.e2e;
  }

  /** SEC-05: evict phantom peer contexts — still 'connecting' past
   * CONNECT_TIMEOUT_MS with no remote description ever arrived — and release
   * their heavyweight allocations instead of holding them indefinitely */
  private sweepPeers() {
    let changed = false;
    for (const [, ctx] of Array.from(this.peers)) {
      if (
        ctx.status === "connecting" &&
        !ctx.pc.remoteDescription &&
        performance.now() - ctx.createdAt > CONNECT_TIMEOUT_MS
      ) {
        this.removePeer(ctx);
        changed = true;
      }
    }
    if (changed) this.schedule();
  }

  /** prove room-key possession: seal a nonce into a ping — only a key holder
   * can return the sealed pong echoing it (SEC-01). Re-invoked on every hello
   * so a peer that just acquired the key (key-offer path) gets a fresh
   * challenge its old sealed self could never answer. */
  private challenge(ctx: PeerCtx) {
    if (!this.cipher) return;
    const nonce = rid();
    ctx.proofNonce = nonce;
    void (async () => {
      const dc = ctx.dc;
      if (!dc || dc.readyState !== "open" || !this.cipher) return;
      try {
        const frame = await this.cipher.seal(
          FRAME.CONTROL_ENC,
          encoder.encode(JSON.stringify({ t: "ping", at: Date.now(), n: nonce })),
        );
        if (dc.readyState === "open") dc.send(frame);
      } catch {}
    })();
  }

  /** one blocking consent prompt per unproven, capability-less peer — the
   * documented escape hatch for WebCrypto-incapable (iOS/plain-http) peers */
  private requestConsent(ctx: PeerCtx) {
    if (ctx.consented || ctx.consentDenied) return;
    if (this.consents.some((q) => q.peerId === ctx.peerId)) return;
    this.consents = [...this.consents, { peerId: ctx.peerId, name: ctx.name }];
    this.schedule();
  }

  /** adopt a room key received via key-offer: rebuild the cipher, clear the
   * transient undecryptable warnings the handshake produced, and re-hello so
   * every member re-challenges us — while challenging them back, since proof
   * is directional and our old keyless self never demanded theirs. From there
   * the normal proof flow unseals the room both ways. */
  private async acquireKey(k: string) {
    this.roomKey = k;
    this.cipher = await RoomCipher.fromKey(k);
    this.chats = this.chats.filter((c) => !c.system);
    this.broadcastControl({
      t: "hello",
      name: this.selfName,
      platform: platformLabel(),
      e2e: hasCrypto(),
      keyed: true,
    });
    for (const p of this.peers.values()) {
      p.undecryptableWarned = false;
      if (p.e2e && p.dc?.readyState === "open") this.challenge(p);
    }
    this.toast("Room key received — this connection is now end-to-end encrypted", "success");
    this.schedule();
  }

  private flushForPeer(ctx: PeerCtx) {
    if (!this.deliverable(ctx)) return;
    // text first so a caption precedes its file-starts on the wire
    if (this.pendingChats.length) {
      const chats = this.pendingChats;
      this.pendingChats = [];
      for (const c of chats) void this.sendControl(ctx, c);
    }
    if (ctx.withheldChats.length) {
      const chats = ctx.withheldChats;
      ctx.withheldChats = [];
      for (const c of chats) void this.sendControl(ctx, c);
    }
    if (this.deferred.length) {
      const items = this.deferred;
      this.deferred = [];
      for (const d of items) this.enqueue(ctx, d.view, d.file);
    }
    if (ctx.withheldFiles.length) {
      const items = ctx.withheldFiles;
      ctx.withheldFiles = [];
      for (const d of items) this.enqueue(ctx, d.view, d.file);
    }
    void this.pump(ctx);
  }

  private enqueue(ctx: PeerCtx, view: TransferView, file: File) {
    // announce the queue position before anything is pumped so the receiver
    // sees every upcoming file of the message up front — the data channel is
    // ordered, so this frame always precedes this transfer's file-start
    void this.sendControl(ctx, {
      t: "file-queued",
      id: view.id,
      name: view.name,
      size: view.size,
      mime: view.mime,
      g: view.groupId,
    });
    const job: SendJob = { view, file, bytesSent: 0, done: false, failed: false };
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

  private static PAYLOAD_CONTROLS = new Set<string>(["chat", "file-start", "file-queued"]);

  /**
   * Send a control frame. `auto` seals only payload frames (chat, file-start,
   * file-queued) and only for peers that proved key possession — protocol
   * frames stay unsealed so connectivity survives. `plain` never seals
   * (back-channels); `proof` always seals (the pong echoing a challenge nonce).
   */
  private async sendControl(ctx: PeerCtx, c: Control, mode: SealMode = "auto") {
    const dc = ctx.dc;
    if (!dc || dc.readyState !== "open") return;
    const json = encoder.encode(JSON.stringify(c));
    // sealed whenever we hold a key and the peer hasn't been explicitly
    // downgraded — including unproven peers, whose unreadable copies surface
    // as undecryptable bubbles on their side (never silence)
    const wantSeal =
      mode === "proof" ||
      (mode === "auto" && RoomClient.PAYLOAD_CONTROLS.has(c.t) && this.cipher && !ctx.consented);
    const frame =
      wantSeal && this.cipher
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

  /** a frame arrived that we cannot read — tell the user on BOTH sides and
   * never stay silent (this is how the iOS receive bug hid for so long).
   * Message frames (chat/file-start) get a bubble EACH — a missing bubble
   * would mean a message silently vanishing — while file-chunks (which fail
   * in floods) and the toast/back-channel stay throttled to once per
   * connection. */
  private notifyUndecryptable(
    ctx: PeerCtx,
    detail: "sealed" | "malformed" | "orphan",
    kind: "frame" | "chunk" = "frame",
  ) {
    const text =
      detail === "sealed"
        ? "⚠︎ Could not decrypt this message — the sender's app may be outdated or the room key differs."
        : detail === "malformed"
          ? "⚠︎ Received a malformed message that could not be read."
          : "⚠︎ Received file data without its transfer header — ask the sender to resend.";
    if (kind === "frame" || !ctx.undecryptableWarned) {
      this.chats = [
        ...this.chats,
        {
          id: rid(),
          peerId: ctx.peerId,
          name: ctx.name,
          text,
          at: Date.now(),
          mine: false,
          system: true,
        },
      ];
      this.capChats();
    }
    if (ctx.undecryptableWarned) {
      this.schedule();
      return;
    }
    ctx.undecryptableWarned = true;
    this.toast("A message could not be decrypted — see the warning in the timeline", "error");
    // back-channel is always plain so the sender can parse it regardless of keys
    const dc = ctx.dc;
    if (dc && dc.readyState === "open") {
      try {
        dc.send(
          concatFrame(
            FRAME.CONTROL,
            encoder.encode(JSON.stringify({ t: "undecryptable", detail })),
          ),
        );
      } catch {}
    }
    this.schedule();
  }

  private onFrame(ctx: PeerCtx, data: unknown) {
    if (typeof data === "string") return;
    const u8 = new Uint8Array(data as ArrayBuffer);
    if (!u8.length) return;
    const type = u8[0];
    const body = u8.subarray(1);
    switch (type) {
      case FRAME.CONTROL: {
        let c: Control;
        try {
          c = JSON.parse(decoder.decode(body)) as Control;
        } catch {
          this.notifyUndecryptable(ctx, "malformed");
          break;
        }
        this.onControl(ctx, c, false);
        break;
      }
      case FRAME.CONTROL_ENC:
        if (this.cipher)
          this.cipher.open(body).then(
            (pt) => this.onControl(ctx, JSON.parse(decoder.decode(pt)) as Control, true),
            () => this.notifyUndecryptable(ctx, "sealed"),
          );
        else this.notifyUndecryptable(ctx, "sealed");
        break;
      case FRAME.CHUNK:
        this.onChunk(ctx, body);
        break;
      case FRAME.CHUNK_ENC:
        if (this.cipher)
          this.cipher.open(body).then(
            (pt) => this.onChunk(ctx, pt),
            () => this.notifyUndecryptable(ctx, "sealed", "chunk"),
          );
        else this.notifyUndecryptable(ctx, "sealed", "chunk");
        break;
    }
  }

  private capChats() {
    if (this.chats.length > MAX_RETAINED_CHATS) {
      this.chats = this.chats.slice(-MAX_RETAINED_CHATS);
    }
  }

  private onControl(ctx: PeerCtx, c: Control, sealed: boolean) {
    switch (c.t) {
      case "hello":
        ctx.name = c.name || ctx.name;
        ctx.platform = c.platform;
        ctx.e2e = c.e2e === true;
        if (this.cipher) {
          if (ctx.e2e) {
            // claims capability — prove it: only a key holder echoes the
            // sealed nonce pong. Until then payloads stay withheld.
            if (!ctx.proven) this.challenge(ctx);
          } else {
            // cannot ever prove (no crypto.subtle) — the consent gate decides
            this.requestConsent(ctx);
          }
        } else if (c.keyed === true && !ctx.keyRequested) {
          // we hold no key but a keyed peer appeared — ask for a share, but
          // only where the room policy allows the ask (SEC-11: the host by
          // default; anyone when the room opted in; no announcement = anyone)
          if (this.keyShare === "anyone" || this.hostId == null || ctx.peerId === this.hostId) {
            ctx.keyRequested = true;
            void this.sendControl(ctx, { t: "key-request" }, "plain");
            this.toast("Asked the room for its key — waiting for approval", "info");
          }
        }
        // release anything that was waiting for exactly this (flushing twice
        // is a no-op; gated to proven/consented peers in keyed rooms)
        this.flushForPeer(ctx);
        this.schedule();
        break;
      case "key-request": {
        // a keyless joiner wants in — one approval gate per connection,
        // only answerable while we actually hold the key
        if (
          this.cipher &&
          !ctx.keyShareDecided &&
          !this.keyRequests.some((q) => q.peerId === ctx.peerId) &&
          // SEC-11: the prompt goes to the room the policy empowers — the
          // host by default, everyone when the room opted in
          (this.keyShare === "anyone" || this.hostId == null || this.selfId === this.hostId)
        ) {
          this.keyRequests = [...this.keyRequests, { peerId: ctx.peerId, name: ctx.name }];
          this.schedule();
        }
        break;
      }
      case "key-offer": {
        // keyless joiner receives the room key over the DTLS channel — build
        // the cipher, re-hello so members re-challenge, then payloads seal
        const k = typeof c.k === "string" ? c.k : "";
        if (this.cipher || k.length < 8 || k.length > 200) break;
        void this.acquireKey(k);
        break;
      }
      case "chat":
        // SEC-03: inbound text is stored truncated to the composer's outbound
        // limit and the retained timeline rolls — a peer streaming maximal
        // frames can neither grow memory unbounded nor outpace manual Clear.
        // Applies to plaintext frames regardless of the room key (wrong-key
        // members are bounded identically).
        this.chats = [
          ...this.chats,
          {
            id: typeof c.id === "string" ? c.id : rid(),
            peerId: ctx.peerId,
            name: ctx.name,
            text: String(c.text ?? "").slice(0, MAX_CHAT_CHARS),
            at: typeof c.at === "number" && Number.isFinite(c.at) ? c.at : Date.now(),
            mine: false,
            groupId: c.g,
            sealed,
          },
        ];
        this.capChats();
        this.schedule();
        break;
      case "undecryptable":
        this.toast(
          c.detail === "orphan"
            ? "The other side got file data without a header — resend the file"
            : "Your message could not be decrypted by the other side",
          "error",
        );
        break;
      case "file-queued": {
        // queue preview only — no sink, no incoming slot, no backpressure.
        // Same claim validation as file-start (SEC-02), but a bad, duplicate,
        // or over-cap announce is simply ignored: the authoritative file-start
        // still draws explicit backpressure when the transfer itself begins.
        const size = c.size;
        if (
          typeof size !== "number" ||
          !Number.isSafeInteger(size) ||
          size < 0 ||
          size > MAX_STREAMABLE_SIZE ||
          typeof c.name !== "string" ||
          typeof c.mime !== "string" ||
          typeof c.id !== "string" ||
          !c.id ||
          // one preview per id — repeats (and post-start repeats) are noise
          this.transfers.some((t) => t.id === c.id) ||
          this.queuedIncomingCount(ctx) >= MAX_QUEUED_INCOMING_PER_PEER
        ) {
          break;
        }
        this.transfers = [
          {
            id: c.id,
            dir: "in",
            peerId: ctx.peerId,
            peerName: ctx.name,
            // clamped in length: over-long strings never reach the UI or buffers
            name: c.name.slice(0, MAX_NAME_CHARS),
            size,
            mime: c.mime.slice(0, MAX_MIME_CHARS),
            status: "queued",
            bytes: 0,
            speed: 0,
            at: Date.now(),
            groupId: c.g,
            sealed,
          },
          ...this.transfers,
        ];
        this.schedule();
        break;
      }
      case "file-start": {
        // SEC-02: validate the claim before any state is built from it — the
        // announced header bounds what the receiver accepts. Bad claims never
        // start a transfer and draw explicit file-cancel backpressure.
        // Sizes beyond RAM buffering stream to OPFS (see spill.ts); the
        // practical ceiling becomes storage quota, not a fixed constant.
        const size = c.size;
        const id = typeof c.id === "string" ? c.id : "";
        const invalid =
          typeof size !== "number" ||
          !Number.isSafeInteger(size) ||
          size < 0 ||
          size > MAX_STREAMABLE_SIZE ||
          typeof c.name !== "string" ||
          typeof c.mime !== "string";
        if (invalid) {
          this.settleQueuedPreview(ctx, id);
          void this.sendControl(ctx, { t: "file-cancel", id, reason: "invalid-header" });
          this.schedule();
          break;
        }
        // SEC-04: chunks carry no transfer id, so one inbound transfer per
        // peer at a time (MAX_INCOMING_PER_PEER). A header arriving while the
        // slot is busy — or during a bounce cooldown — settles any previous
        // transfer as cancelled (never orphaned 'active') and is refused with
        // explicit backpressure instead of creating a list entry.
        if (ctx.incoming || performance.now() < ctx.startBlockedUntil) {
          if (ctx.incoming) {
            const prev = ctx.incoming;
            ctx.incoming = null;
            prev.sink.abort();
            prev.view.status = "cancelled";
            void this.sendControl(ctx, {
              t: "file-cancel",
              id: prev.view.id,
              reason: "superseded",
            });
          }
          ctx.startBlockedUntil = performance.now() + INCOMING_START_COOLDOWN_MS;
          this.settleQueuedPreview(ctx, id);
          void this.sendControl(ctx, { t: "file-cancel", id, reason: "busy" });
          this.schedule();
          break;
        }
        // the queue preview may already know this transfer — promote it in
        // place so the row (and its timeline position) stays stable
        const existing = this.queuedPreview(ctx, id);
        if (existing) {
          // the start frame is authoritative: sniffed mime, clamped strings
          existing.name = c.name.slice(0, MAX_NAME_CHARS);
          existing.size = size;
          existing.mime = c.mime.slice(0, MAX_MIME_CHARS);
          existing.sealed = sealed;
          existing.status = "active";
        }
        const view: TransferView = existing ?? {
          id,
          dir: "in",
          peerId: ctx.peerId,
          peerName: ctx.name,
          name: c.name.slice(0, MAX_NAME_CHARS),
          size,
          mime: c.mime.slice(0, MAX_MIME_CHARS),
          status: "active",
          bytes: 0,
          speed: 0,
          at: Date.now(),
          groupId: c.g,
          sealed,
        };
        const sink = pickIncomingSink(size);
        if (sink === "too-large") {
          // gigabytes announced but this browser has no disk spill — refuse
          // with explicit backpressure instead of buffering into oblivion
          if (existing) existing.status = "cancelled";
          void this.sendControl(ctx, { t: "file-cancel", id, reason: "too-large" });
          this.toast(
            `"${c.name.slice(0, MAX_NAME_CHARS)}" is too large for this browser's storage`,
            "error",
          );
          this.schedule();
          break;
        }
        ctx.incoming = {
          view,
          sink,
          startedAt: performance.now(),
          lastEmitAt: performance.now(),
          lastEmitBytes: 0,
          lastProgress: performance.now(),
        };
        if (!existing) this.transfers = [view, ...this.transfers];
        this.schedule();
        break;
      }
      case "file-end":
        this.finishIncoming(ctx, c.id);
        break;
      case "file-cancel": {
        if (ctx.incoming?.view.id === c.id) {
          ctx.incoming.sink.abort();
          ctx.incoming = null;
        }
        const t = this.transfers.find((x) => x.id === c.id);
        // actives settle as before; queued settles cover the queue previews in
        // both roles — a receiver cancelling a file it was promised, and a
        // sender retracting a file still parked in its own queue. (A peer only
        // ever learns a queued id from our own announce, so echoing one back
        // is exactly the "don't send me this" signal.)
        if (t && (t.status === "active" || t.status === "queued")) {
          t.status = "cancelled";
          this.schedule();
        }
        break;
      }
      case "ping": {
        const at = typeof c.at === "number" && Number.isFinite(c.at) ? c.at : Date.now();
        // a proof-bearing ping must be answered with a SEALED pong echoing the
        // nonce — only a key holder can produce it
        if (typeof c.n === "string" && c.n) {
          void this.sendControl(ctx, { t: "pong", at, n: c.n }, "proof");
        } else {
          void this.sendControl(ctx, { t: "pong", at });
        }
        break;
      }
      case "pong": {
        if (typeof c.at === "number" && Number.isFinite(c.at)) {
          ctx.rtt = Math.max(0, Date.now() - c.at);
          this.schedule();
        }
        // key-proof completion: the sealed pong echoes the nonce we sealed
        if (sealed && typeof c.n === "string" && ctx.proofNonce != null && c.n === ctx.proofNonce) {
          ctx.proofNonce = null;
          ctx.proven = true;
          this.flushForPeer(ctx);
          this.schedule();
        }
        break;
      }
      case "bye":
        this.onServerMsg({ t: "peer-leave", peerId: ctx.peerId });
        break;
    }
  }

  private onChunk(ctx: PeerCtx, body: Uint8Array<ArrayBuffer>) {
    const inc = ctx.incoming;
    if (!inc) {
      // a completed transfer's late tail (wire reorder / sender flush): the
      // file is already whole, so dropping it silently beats a false "resend"
      if (ctx.lastDoneAt !== null && performance.now() - ctx.lastDoneAt <= DONE_TAIL_GRACE_MS) {
        return;
      }
      // data without a header: the file-start was lost (dropped sealed frame,
      // stale sender…) — surface it, never stay silent
      this.notifyUndecryptable(ctx, "orphan");
      return;
    }
    // SEC-02: the first byte past the announced size is a protocol violation —
    // abort instead of buffering what the sender never declared
    if (inc.view.bytes + body.byteLength > inc.view.size) {
      ctx.incoming = null;
      inc.sink.abort();
      inc.view.status = "error";
      this.toast(`"${inc.view.name}" sent more data than announced — transfer aborted`, "error");
      void this.sendControl(ctx, { t: "file-cancel", id: inc.view.id, reason: "size-mismatch" });
      this.schedule();
      return;
    }
    // a failed disk write (quota exhausted, storage evicted) settles the
    // transfer instead of silently dropping gigabytes on the floor
    if (inc.sink.failed) {
      ctx.incoming = null;
      inc.sink.abort();
      inc.view.status = "error";
      this.toast(`"${inc.view.name}" could not be written to storage — transfer failed`, "error");
      void this.sendControl(ctx, { t: "file-cancel", id: inc.view.id, reason: "sink-failed" });
      this.schedule();
      return;
    }
    inc.lastProgress = performance.now();
    inc.sink.append(body);
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
    ctx.lastDoneAt = performance.now();
    const v = inc.view;
    const secs = (performance.now() - inc.startedAt) / 1000;
    v.speed = secs > 0 ? v.bytes / secs : 0;
    // done the moment the wire says so — the sniff and blob assembly below
    // only attach metadata; the counter keeps bytes actually received and
    // is never rewritten to the claim
    v.status = "done";
    void this.verifyIncoming(v, inc.sink);
    this.schedule();
  }

  private async verifyIncoming(v: TransferView, sink: IncomingSink) {
    const info = await sniffBytes(sink.head());
    if (this.disposed || !this.transfers.includes(v)) {
      sink.abort();
      return;
    }
    if (info) {
      v.detected = info;
      v.mime = resolveMime(v.mime, info);
      const warn = suspiciousMismatch(v.name, info);
      if (warn) this.toast(warn, "error");
    }
    try {
      // RAM sink: an in-memory Blob; disk sink: the OPFS-backed File itself,
      // so multi-GB results stream from disk instead of living in heap
      const blob = await sink.finish();
      v.blob = blob;
      v.blobUrl = URL.createObjectURL(blob);
    } catch {
      v.status = "error";
      sink.abort();
      this.toast(`"${v.name}" could not be stored — transfer failed`, "error");
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
    // the header names the transfer for the receiver — make sure the sniffed
    // mime (not the browser's extension guess) is what goes on the wire
    await this.sniffTransfer(view, file);
    view.status = "active";
    // chunks are sealed whenever we hold a key and the peer hasn't been
    // explicitly downgraded (consented peers take plaintext) — unproven
    // capable peers receive sealed chunks they cannot open, keeping the
    // transfer's failure explicit on their side instead of silent
    const seal = this.cipher !== null && !ctx.consented;
    const chunkSize = Math.max(4096, ctx.maxChunk - (seal ? ENC_OVERHEAD : 1));
    await this.sendControl(ctx, {
      t: "file-start",
      id: view.id,
      name: file.name || "file",
      size: file.size,
      mime: view.mime,
      g: view.groupId,
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
      const frame = seal
        ? await this.cipher!.seal(FRAME.CHUNK_ENC, u8)
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
    if (ctx.incoming) {
      ctx.incoming.sink.abort();
      ctx.incoming = null;
    }
    const dead = [...this.outJobs.entries()].filter(([, jobs]) =>
      [...jobs].some((j) => jobs.size && j.view.peerId === ctx.peerId),
    );
    for (const [id] of dead) this.outJobs.delete(id);
  }

  /** drop a peer from the mesh: teardown, map removal, stale consent prompts */
  private removePeer(p: PeerCtx) {
    this.teardownPeer(p);
    this.peers.delete(p.peerId);
    this.consents = this.consents.filter((q) => q.peerId !== p.peerId);
    this.schedule();
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
