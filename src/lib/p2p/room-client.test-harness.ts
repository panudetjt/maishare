// Test seam for driving the real RoomClient end-to-end without a browser:
// a fake RoomTransport delivers server messages and captures what the client
// sends, and stub WebRTC objects let the mesh code run for real — outbound
// data-channel frames are captured verbatim so tests assert wire bytes, not
// private client state. Install the stubs, create a harness, drive it, and
// dispose in afterEach.
import { RoomClient } from "./room-client";
import type { ClientMsg, RoomTransport, ServerMsg, SignalStatus } from "./signaling";

export const FAKE_SDP = "v=0\r\no=- harness 1 IN IP4 127.0.0.1\r\ns=maishare-test\r\n";

/** sorts after every uuid char → the victim is the polite side (no channel) */
export const POLITE_PEER = "zzzzzzzzzzzz";
/** sorts before every uuid char → the victim is the impolite side (creates the channel) */
export const IMPOLITE_PEER = "------------";

/** minimal data channel: captures what the client sends, lets tests feed
 * frames back in as if they arrived from the peer */
export class FakeDataChannel {
  readonly label: string;
  readyState: RTCDataChannelState = "connecting";
  binaryType: BinaryType = "arraybuffer";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  /** frames the client handed to the wire, in order */
  readonly sent: Uint8Array[] = [];

  constructor(label: string) {
    this.label = label;
  }

  open() {
    if (this.readyState === "open") return;
    this.readyState = "open";
    this.onopen?.();
  }

  close() {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.onclose?.();
  }

  send(frame: Uint8Array) {
    this.sent.push(frame);
  }

  /** deliver a frame as if it arrived from the peer */
  receive(data: Uint8Array | ArrayBuffer) {
    const buffer = data instanceof Uint8Array ? data.slice().buffer : data;
    this.onmessage?.({ data: buffer });
  }

  addEventListener() {}
  removeEventListener() {}
}

/** minimal RTCPeerConnection: records instances/candidates/channels so tests
 * can assert what reached the WebRTC sink without touching client internals */
export class FakeRTCPeerConnection {
  static readonly instances: FakeRTCPeerConnection[] = [];
  readonly channels: FakeDataChannel[] = [];
  readonly candidates: RTCIceCandidateInit[] = [];
  localDescription: { type: RTCSdpType; sdp: string } | null = null;
  remoteDescription: { type: RTCSdpType; sdp: string } | null = null;
  signalingState: RTCSignalingState = "stable";
  connectionState: RTCPeerConnectionState = "new";
  iceGatheringState: RTCIceGatheringState = "complete";
  onicecandidate: ((ev: { candidate: RTCIceCandidate | null }) => void) | null = null;
  onnegotiationneeded: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((ev: { channel: FakeDataChannel }) => void) | null = null;

  constructor() {
    FakeRTCPeerConnection.instances.push(this);
  }

  createDataChannel(label: string): FakeDataChannel {
    const dc = new FakeDataChannel(label);
    this.channels.push(dc);
    // a real browser fires negotiation asynchronously after channel creation
    queueMicrotask(() => this.onnegotiationneeded?.());
    return dc;
  }

  async setLocalDescription() {
    this.localDescription ??= {
      type: this.remoteDescription ? "answer" : "offer",
      sdp: FAKE_SDP,
    };
  }

  async setRemoteDescription(desc: RTCSessionDescriptionInit) {
    this.remoteDescription = { type: desc.type, sdp: desc.sdp ?? FAKE_SDP };
  }

  async addIceCandidate(cand: RTCIceCandidateInit) {
    this.candidates.push(cand);
  }

  restartIce() {}
  close() {
    this.connectionState = "closed";
  }
  addEventListener() {}
  removeEventListener() {}
}

/** fake signaling server: tests deliver messages in, assertions read what the
 * client sent out */
export class FakeTransport implements RoomTransport {
  readonly sent: ClientMsg[] = [];
  readonly statuses: SignalStatus[] = [];
  private handlers: {
    onMessage: (m: ServerMsg) => void;
    onStatus: (s: SignalStatus) => void;
  } = {
    onMessage: () => {},
    onStatus: () => {},
  };

  bind(handlers: { onMessage: (m: ServerMsg) => void; onStatus: (s: SignalStatus) => void }) {
    this.handlers = handlers;
  }

  connect() {
    this.setStatus("connecting");
    this.setStatus("online");
  }

  send(m: ClientMsg) {
    this.sent.push(m);
  }

  updateName(name: string) {
    this.sent.push({ t: "name", name });
  }

  close() {}

  /** test-side: a server message arrives */
  deliver(m: ServerMsg) {
    this.handlers.onMessage(m);
  }

  /** test-side: the websocket went up/down */
  setStatus(s: SignalStatus) {
    this.statuses.push(s);
    this.handlers.onStatus(s);
  }

  signalsTo(peerId: string) {
    return this.sent.filter(
      (m): m is Extract<ClientMsg, { t: "signal" }> => m.t === "signal" && m.to === peerId,
    );
  }
}

export interface HarnessPeer {
  readonly peerId: string;
  readonly pc: FakeRTCPeerConnection;
  channel: FakeDataChannel | null;
}

let objectUrlSeq = 0;
/** object URLs the client handed out / revoked — cleared on every install */
export const createdObjectUrls: string[] = [];
export const revokedObjectUrls: string[] = [];

/** install the browser globals the client needs; returns a restore function */
export function installRoomClientStubs(): () => void {
  const globalWindow = globalThis as { RTCPeerConnection?: unknown };
  const hadPC = "RTCPeerConnection" in globalWindow;
  const prevPC = globalWindow.RTCPeerConnection;
  globalWindow.RTCPeerConnection = FakeRTCPeerConnection as unknown as typeof RTCPeerConnection;
  const URLCtor = globalThis.URL as unknown as {
    createObjectURL?: (o: unknown) => string;
    revokeObjectURL?: (u: string) => void;
  };
  createdObjectUrls.length = 0;
  revokedObjectUrls.length = 0;
  URLCtor.createObjectURL = () => `blob:harness-${++objectUrlSeq}`;
  URLCtor.revokeObjectURL = (u: string) => {
    revokedObjectUrls.push(u);
  };
  return () => {
    if (hadPC) globalWindow.RTCPeerConnection = prevPC;
    else delete globalWindow.RTCPeerConnection;
    delete URLCtor.createObjectURL;
    delete URLCtor.revokeObjectURL;
  };
}

export function decodeFrame(frame: Uint8Array): { type: number; body: string } {
  return { type: frame[0], body: new TextDecoder().decode(frame.subarray(1)) };
}

export function createRoomHarness(opts: { roomId?: string; key?: string; name?: string } = {}) {
  const transport = new FakeTransport();
  const client = new RoomClient({
    roomId: opts.roomId ?? "test-room",
    name: opts.name ?? "victim",
    key: opts.key,
    transport,
  });

  const harness = {
    client,
    transport,

    async start() {
      await client.start();
      await harness.flush();
    },

    /** the mesh reacts synchronously; negotiation flushes on microtasks; the
     * store emits on a 50ms debounce — settle covers all three */
    async settle() {
      await new Promise((r) => setTimeout(r, 60));
    },

    async flush() {
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    },

    /** a peer appears via the roster broadcast; returns its connection stub */
    addPeer(peerId: string, name = "peer"): HarnessPeer {
      const before = FakeRTCPeerConnection.instances.length;
      transport.deliver({ t: "peer-join", peerId, name });
      const pc = FakeRTCPeerConnection.instances[before];
      if (!pc) throw new Error(`peer-join did not create a connection for ${peerId}`);
      return { peerId, pc, channel: pc.channels[0] ?? null };
    },

    removePeer(peerId: string) {
      transport.deliver({ t: "peer-leave", peerId });
    },

    /** an ICE candidate arrives from a peer (before or after SDP) */
    candidate(peerId: string, i: number | string) {
      transport.deliver({
        t: "signal",
        from: peerId,
        data: {
          candidate: `candidate:${i} 1 udp 2130706431 127.0.0.1 10000 typ host`,
          sdpMid: "0",
          sdpMLineIndex: 0,
        },
      });
    },

    /** an offer arrives from a peer */
    offer(peerId: string) {
      transport.deliver({ t: "signal", from: peerId, data: { type: "offer", sdp: FAKE_SDP } });
    },

    /** open the peer's data channel exactly like the browser would (creates
     * it via ondatachannel when the peer is the polite/remote side) */
    openChannel(p: HarnessPeer): FakeDataChannel {
      let ch = p.channel;
      if (!ch) {
        ch = new FakeDataChannel("maishare");
        p.pc.ondatachannel?.({ channel: ch });
        p.channel = ch;
      }
      ch.open();
      return ch;
    },

    peerIds(): string[] {
      return client.getSnapshot().peers.map((p) => p.peerId);
    },

    dispose() {
      client.dispose();
    },
  };

  return harness;
}

export type RoomHarness = ReturnType<typeof createRoomHarness>;
