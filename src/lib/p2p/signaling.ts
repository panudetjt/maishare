export type SignalStatus = "connecting" | "online" | "offline";

export type ServerMsg =
  | {
      t: "welcome";
      you: string;
      /** SEC-08 peer-id ownership token — remember it, re-present it on every
       * retry/reconnect so a dropped socket can reclaim its slot */
      token?: string;
      peers: { peerId: string; name: string }[];
      addresses: string[];
    }
  | { t: "peer-join"; peerId: string; name: string }
  | { t: "peer-leave"; peerId: string }
  | { t: "peer-name"; peerId: string; name: string }
  | { t: "signal"; from: string; data: unknown }
  // discovery: the DO asks a member to verify a prober over a host-only
  // connection (`from` is the prober's peer id); probers in empty rooms get
  // an immediate dead end
  | { t: "probe-request"; from: string }
  | { t: "probe-empty" }
  | { t: "error"; message: string };

export type ClientMsg = { t: "signal"; to: string; data: unknown } | { t: "name"; name: string };

/**
 * How a RoomClient talks to the outside world to set up its mesh. The default
 * implementation is the WebSocket signaling server; Nearby mode plugs in a
 * DirectTransport that carries the SDP through QR codes instead — everything
 * above this interface (mesh, transfers, chat) is shared.
 */
export interface RoomTransport {
  /** wire the client's message/status handlers before connect() */
  bind(handlers: { onMessage: (m: ServerMsg) => void; onStatus: (s: SignalStatus) => void }): void;
  connect(): void;
  send(m: ClientMsg): void;
  updateName(name: string): void;
  close(): void;
  /** SEC-08: remember the peer-id ownership token delivered in the welcome and
   * re-present it on every retry/reconnect (transports without a server token
   * flow ignore this) */
  setToken?(token: string): void;
}

function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}

export class Signaling implements RoomTransport {
  private ws: WebSocket | null = null;
  private closedByUs = false;
  private attempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private info: { roomId: string; peerId: string; name: string; probe?: boolean; token?: string };
  private handlers: { onMessage: (m: ServerMsg) => void; onStatus: (s: SignalStatus) => void } = {
    onMessage: () => {},
    onStatus: () => {},
  };

  constructor(info: { roomId: string; peerId: string; name: string; probe?: boolean }) {
    this.info = info;
  }

  bind(handlers: { onMessage: (m: ServerMsg) => void; onStatus: (s: SignalStatus) => void }) {
    this.handlers = handlers;
  }

  /** the welcome's ownership token — travels in every future handshake */
  setToken(token: string) {
    if (this.info.token === token) return;
    this.info = { ...this.info, token };
  }

  connect() {
    this.closedByUs = false;
    this.open();
  }

  private open() {
    this.handlers.onStatus("connecting");
    let ws: WebSocket;
    try {
      // identity travels in the handshake URL — both the node server and the
      // Cloudflare worker read room/peer/name from query params on upgrade
      const params = new URLSearchParams({
        room: this.info.roomId,
        peer: this.info.peerId,
        name: this.info.name,
      });
      if (this.info.probe) params.set("probe", "1");
      // the ownership token rides the handshake URL like the room/peer identity
      // it protects — the WebSocket API offers no header channel on browsers.
      // Exposure is bounded: it authorizes only this peer id in this room, and
      // the same access logs would already carry the room id and peer id.
      if (this.info.token) params.set("token", this.info.token);
      ws = new WebSocket(`${wsUrl()}?${params}`);
    } catch {
      this.retry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.attempts = 0;
      this.handlers.onStatus("online");
    };
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(String(ev.data)) as ServerMsg;
        this.handlers.onMessage(m);
      } catch {
        // ignore malformed frames
      }
    };
    ws.onclose = () => {
      this.ws = null;
      if (!this.closedByUs) {
        this.handlers.onStatus("offline");
        this.retry();
      }
    };
    ws.onerror = () => {};
  }

  private retry() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const delay = Math.min(15_000, 500 * 2 ** this.attempts++);
    this.retryTimer = setTimeout(() => this.open(), delay);
  }

  send(m: ClientMsg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(m));
    }
  }

  updateName(name: string) {
    this.info = { ...this.info, name };
    this.send({ t: "name", name });
  }

  close() {
    this.closedByUs = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    try {
      this.ws?.close();
    } catch {}
  }
}
