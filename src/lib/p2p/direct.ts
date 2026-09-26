import { packShareCode, unpackShareCode } from "./share-code";
import type { ClientMsg, RoomTransport, ServerMsg, SignalStatus } from "./signaling";

/**
 * The remote peer id used for direct (QR-signaled) sessions. It sorts after
 * every UUID hex string, and the RoomClient's `initiator` override fixes the
 * perfect-negotiation roles, so the value itself only needs to be stable and
 * distinct from selfId.
 */
export const DIRECT_PEER = "~direct-peer";

export type DirectRole = "initiator" | "responder";

/**
 * A RoomTransport with no server at all: the offer/answer travels through QR
 * codes (or paste) instead of the signaling WebSocket, and candidates are
 * gathered into the SDP instead of trickled. Everything above the transport —
 * mesh negotiation, transfers, chat — is the ordinary RoomClient.
 *
 * - initiator: `offerCode()` resolves once the client's first offer has been
 *   gathered; `acceptAnswer()` feeds the scanned reply back into the client.
 * - responder: `acceptOffer()` feeds the scanned offer in; resolves with the
 *   gathered reply code to show as a QR.
 */
export class DirectTransport implements RoomTransport {
  readonly role: DirectRole;
  private readonly selfName: string;
  private onMessage: (m: ServerMsg) => void = () => {};
  private onStatus: (s: SignalStatus) => void = () => {};
  private resolveCode: ((code: string) => void) | null = null;
  private codePromise: Promise<string> | null = null;
  private expect: "offer" | "answer" | null = null;

  constructor(opts: { role: DirectRole; name: string }) {
    this.role = opts.role;
    this.selfName = opts.name;
  }

  bind(handlers: { onMessage: (m: ServerMsg) => void; onStatus: (s: SignalStatus) => void }) {
    this.onMessage = handlers.onMessage;
    this.onStatus = handlers.onStatus;
  }

  connect(): void {
    this.onStatus("online");
    this.onMessage({ t: "welcome", you: "", peers: [], addresses: [] });
    // the initiator needs its peer context before any offer can exist; the
    // responder's peer is created by the incoming offer inside onSignal
    if (this.role === "initiator") {
      this.onMessage({ t: "peer-join", peerId: DIRECT_PEER, name: "nearby device" });
    }
  }

  send(m: ClientMsg): void {
    if (m.t !== "signal" || !this.expect) return;
    const desc = m.data as { type?: string; sdp?: string };
    // trickle candidates are pointless here — the gathered SDP carries them
    if (desc?.type !== this.expect || typeof desc.sdp !== "string") return;
    const resolve = this.resolveCode;
    this.resolveCode = null;
    this.expect = null;
    void packShareCode({ type: desc.type, sdp: desc.sdp, name: this.selfName }).then((c) =>
      resolve?.(c),
    );
  }

  /** Initiator: resolves with the share code to show as a QR. */
  offerCode(): Promise<string> {
    this.expect = "offer";
    this.codePromise ??= new Promise<string>((resolve) => {
      this.resolveCode = resolve;
    });
    return this.codePromise;
  }

  /** Initiator: feed the scanned reply code into the client. */
  async acceptAnswer(code: string): Promise<void> {
    const answer = await unpackShareCode(code);
    if (answer.type !== "answer") throw new Error("expected an answer code");
    this.onMessage({
      t: "signal",
      from: DIRECT_PEER,
      data: { type: "answer", sdp: answer.sdp },
    });
  }

  /** Responder: feed the scanned offer in, resolve with the reply share code. */
  async acceptOffer(code: string): Promise<string> {
    const offer = await unpackShareCode(code);
    if (offer.type !== "offer") throw new Error("expected an offer code");
    this.expect = "answer";
    const promise = new Promise<string>((resolve) => {
      this.resolveCode = resolve;
    });
    this.onMessage({
      t: "signal",
      from: DIRECT_PEER,
      data: { type: "offer", sdp: offer.sdp },
    });
    return promise;
  }

  updateName(_name: string): void {
    /* names travel in the hello frame like in rooms */
  }

  close(): void {
    /* nothing to close — there is no socket */
  }
}
