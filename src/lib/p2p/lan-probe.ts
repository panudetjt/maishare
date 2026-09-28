/**
 * A short-lived WebRTC connection that never gathers anything but host
 * candidates (no STUN, no TURN), so it can only open between devices that
 * actually share a local network. This is the primitive that makes LAN room
 * discovery trustworthy: a public-IP match is just a hint (two homes behind
 * one CGNAT share it), but a host-to-host data channel is proof.
 */

export interface LanProbeOpts {
  /** the initiator creates the data channel and fires the first offer */
  initiator: boolean;
  /** outgoing signaling payloads (offers/answers/ICE candidates) */
  onSignal: (data: unknown) => void;
  /** called once when the data channel opens */
  onConnected: () => void;
  /** give up if the channel hasn't opened by then */
  timeoutMs?: number;
}

export class LanProbe {
  private readonly pc: RTCPeerConnection;
  private dc: RTCDataChannel | null = null;
  private readonly polite: boolean;
  private readonly emit: (data: unknown) => void;
  private readonly onConnected: () => void;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly pendingCandidates: RTCIceCandidateInit[] = [];
  private makingOffer = false;
  private ignoreOffer = false;
  private settingRemoteAnswer = false;
  private done = false;

  constructor(opts: LanProbeOpts, timeoutMs = 8000) {
    // empty iceServers = host candidates only = unreachable across NATs
    this.pc = new RTCPeerConnection({ iceServers: [] });
    this.polite = !opts.initiator;
    this.emit = opts.onSignal;
    this.onConnected = opts.onConnected;

    if (opts.initiator) {
      this.dc = this.pc.createDataChannel("maishare-probe", { ordered: true });
      this.dc.onopen = () => this.succeed();
    } else {
      this.pc.ondatachannel = ({ channel }) => {
        this.dc = channel;
        channel.onopen = () => this.succeed();
      };
    }
    this.pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await this.pc.setLocalDescription();
        const ld = this.pc.localDescription;
        if (ld) this.emit({ type: ld.type, sdp: ld.sdp });
      } catch {
        /* the timeout tears the probe down */
      } finally {
        this.makingOffer = false;
      }
    };
    this.pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.emit(candidate.toJSON());
    };
    this.timer = setTimeout(() => this.close(), timeoutMs);
  }

  /** Feed a signaling payload from the other side (offer, answer or candidate). */
  async onSignal(data: unknown) {
    if (this.done) return;
    const desc = data as { type?: RTCSdpType; sdp?: string };
    try {
      if (desc && desc.sdp !== undefined) {
        const readyForOffer =
          !this.makingOffer && (this.pc.signalingState === "stable" || this.settingRemoteAnswer);
        const offerCollision = desc.type === "offer" && !readyForOffer;
        this.ignoreOffer = !this.polite && offerCollision;
        if (this.ignoreOffer) return;
        await this.pc.setRemoteDescription(desc as RTCSessionDescriptionInit);
        const pending = this.pendingCandidates.splice(0);
        for (const cand of pending) {
          try {
            await this.pc.addIceCandidate(cand);
          } catch {}
        }
        // answer offers only — a no-arg setLocalDescription() after an ANSWER
        // is an implicit re-offer and would loop the probe through the relay
        // until the timeout (same flood shape as the room client had)
        if (desc.type === "offer") {
          this.settingRemoteAnswer = false;
          await this.pc.setLocalDescription();
          const ld = this.pc.localDescription;
          if (ld) this.emit({ type: ld.type, sdp: ld.sdp });
        } else {
          this.settingRemoteAnswer = false;
        }
      } else {
        const cand = data as RTCIceCandidateInit;
        if (!this.pc.remoteDescription) {
          this.pendingCandidates.push(cand);
        } else {
          try {
            await this.pc.addIceCandidate(cand);
          } catch {
            /* stale candidate — harmless for a probe */
          }
        }
      }
    } catch {
      /* negotiation hiccups just run into the timeout */
    }
  }

  /** Stop the probe; safe to call more than once. */
  close() {
    this.done = true;
    clearTimeout(this.timer);
    try {
      this.dc?.close();
    } catch {}
    try {
      this.pc.close();
    } catch {}
  }

  private succeed() {
    if (this.done) return;
    this.done = true;
    clearTimeout(this.timer);
    this.onConnected();
  }
}
