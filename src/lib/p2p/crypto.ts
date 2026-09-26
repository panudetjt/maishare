// Optional end-to-end layer on top of WebRTC's DTLS. The room key lives only
// in the invite URL (`?k=`) and is never sent to the signaling server, so the
// server (which relays SDP) cannot read or tamper with payloads undetected.

export class RoomCipher {
  private key: CryptoKey = null as unknown as CryptoKey;
  private ivBase = new Uint8Array(4);
  private counter = 0n;

  static async fromKey(secret: string): Promise<RoomCipher> {
    const cipher = new RoomCipher();
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
    cipher.key = await crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
    cipher.ivBase = crypto.getRandomValues(new Uint8Array(4));
    cipher.counter = crypto.getRandomValues(new BigUint64Array(1))[0];
    return cipher;
  }

  /** Returns [frameType][iv 12][ciphertext+tag] */
  async seal(frameType: number, plain: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
    const iv = this.nextIv();
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv }, this.key, plain),
    );
    const out = new Uint8Array(1 + 12 + ct.length);
    out[0] = frameType;
    out.set(iv, 1);
    out.set(ct, 13);
    return out;
  }

  /** Input: [iv 12][ciphertext+tag] (frame type byte already stripped) */
  async open(body: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
    const iv = body.subarray(0, 12);
    const ct = body.subarray(12);
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, this.key, ct));
  }

  private nextIv(): Uint8Array<ArrayBuffer> {
    this.counter = (this.counter + 1n) & 0xffff_ffff_ffff_ffffn;
    const out = new Uint8Array(12);
    out.set(this.ivBase);
    new DataView(out.buffer).setBigUint64(4, this.counter);
    return out;
  }
}
