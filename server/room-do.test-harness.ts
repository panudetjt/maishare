// Test seam for the Room Durable Object: a mock hibernation state with
// in-memory storage and fake sockets lets tests drive the DO directly with
// real Request objects — upgrade responses, roster broadcasts, storage keys
// and relay attribution are all observable without workerd.

/** the Room DO constructs `new WebSocketPair()` — provide a node-side stub */
export function installWebSocketPair(): () => void {
  const g = globalThis as { WebSocketPair?: unknown };
  const had = "WebSocketPair" in g;
  const prev = g.WebSocketPair;
  class Pair {
    0: MockSocket;
    1: MockSocket;
    constructor() {
      this[0] = new MockSocket();
      this[1] = new MockSocket();
    }
  }
  g.WebSocketPair = Pair;
  return () => {
    if (had) g.WebSocketPair = prev;
    else delete g.WebSocketPair;
  };
}

/**
 * workerd's Response accepts the WebSocket-upgrade 101 status; node's undici
 * refuses it. Patch in a Response subclass that tolerates 101 while keeping
 * the real status observable through `.status`.
 */
export function installResponse101(): () => void {
  const g = globalThis as { Response?: unknown };
  const prev = g.Response as typeof Response;
  class TestResponse extends Response {
    constructor(body?: BodyInit | null, init?: ResponseInit) {
      const real = init?.status ?? 200;
      super(body, real === 101 ? { ...init, status: 200 } : init);
      Object.defineProperty(this, "status", { value: real, configurable: true });
    }
  }
  g.Response = TestResponse;
  return () => {
    g.Response = prev;
  };
}

/** a fake hibernating WebSocket with attachment + sent-message recording */
export class MockSocket {
  sent: string[] = [];
  closed: { code: number; reason: string } | null = null;
  attachment: unknown = null;

  serializeAttachment(meta: unknown) {
    this.attachment = meta;
  }
  deserializeAttachment(): unknown {
    return this.attachment;
  }
  send(raw: string) {
    this.sent.push(raw);
  }
  close(code?: number, reason?: string) {
    this.closed = { code: code ?? 1005, reason: reason ?? "" };
  }
  lastMessage(): Record<string, unknown> {
    return JSON.parse(this.sent.at(-1) ?? "{}") as Record<string, unknown>;
  }
}

export class MockStorage {
  private map = new Map<string, unknown>();
  alarm: number | null = null;

  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.map.get(key) as T | undefined);
  }
  put(key: string, value: unknown): Promise<void> {
    this.map.set(key, value);
    return Promise.resolve();
  }
  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.map.delete(key));
  }
  list(opts?: { prefix?: string }): Map<string, unknown> {
    if (!opts?.prefix) return new Map(this.map);
    return new Map([...this.map].filter(([k]) => k.startsWith(opts.prefix!)));
  }
  setAlarm(at: number): Promise<void> {
    this.alarm = at;
    return Promise.resolve();
  }
  getAlarm(): Promise<number | null> {
    return Promise.resolve(this.alarm);
  }
}

export class MockDOState {
  readonly storage = new MockStorage();
  readonly sockets: MockSocket[] = [];

  acceptWebSocket(ws: MockSocket) {
    this.sockets.push(ws);
  }
  /** live sockets only — workerd drops closed hibernating sockets from the pool */
  getWebSockets(): MockSocket[] {
    return this.sockets.filter((s) => s.closed === null);
  }
}

/** records what the Room announces to the discovery lobby */
export class MockLobbyStub {
  announced: { roomId: string; ips: Record<string, number>; names: string[] }[] = [];
  async fetch(_url: string, init?: { body?: string }): Promise<Response> {
    this.announced.push(JSON.parse(init?.body ?? "{}"));
    return new Response('{"ok":true}');
  }
  idFromName(name: string): string {
    return name;
  }
  get(_id: string): MockLobbyStub {
    return this;
  }
}

export interface DOEnv {
  ROOM: unknown;
  LOBBY: MockLobbyStub;
  ASSETS: unknown;
}

/** upgrade request for a room slot */
export function joinRequest(opts: {
  roomId?: string;
  peerId: string;
  name?: string;
  ip?: string | null;
  probe?: boolean;
  token?: string;
}): Request {
  const params = new URLSearchParams({ room: opts.roomId ?? "test-room", peer: opts.peerId });
  if (opts.name) params.set("name", opts.name);
  if (opts.probe) params.set("probe", "1");
  if (opts.token) params.set("token", opts.token);
  const headers = new Headers({ Upgrade: "websocket" });
  if (opts.ip !== null) headers.set("CF-Connecting-IP", opts.ip ?? "203.0.113.10");
  return new Request(`https://room.local/ws?${params.toString()}`, { headers });
}

/** unique-enough peer ids that sort stably */
export function pid(i: number): string {
  return `peer-${String(i).padStart(10, "0")}`;
}
