// Ticket 08 / SECURITY-SPEC.md SEC-08 (client half) — the signaling client
// remembers the peer-id ownership token delivered in the welcome and
// re-presents it on every retry/reconnect, so a dropped socket reclaims its
// own slot while a stranger presenting the same peer id is refused.
import { describe, expect, it } from "vite-plus/test";
import { Signaling } from "./signaling";

const PEER = "peer-aaaaaaaaaaaa";

describe("signaling token re-presentation (SEC-08)", () => {
  it("sends the token in every handshake once the welcome delivered it", () => {
    // wsUrl() reads location — node needs a stand-in
    const g = globalThis as {
      location?: { protocol: string; host: string };
      WebSocket?: unknown;
    };
    const prevLocation = g.location;
    const prevWS = g.WebSocket;
    g.location = { protocol: "https:", host: "test.local" };

    const sentUrls: string[] = [];
    class FakeWS {
      static OPEN = 1;
      readyState = 1;
      onopen: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: ((ev: unknown) => void) | null = null;
      constructor(url: string) {
        sentUrls.push(url);
      }
      send() {}
      close() {
        this.onclose?.();
      }
    }
    g.WebSocket = FakeWS;

    try {
      const sig = new Signaling({ roomId: "r", peerId: PEER, name: "n" });
      sig.bind({ onMessage: () => {}, onStatus: () => {} });
      sig.connect();
      // the first join presents no token — none was issued yet
      expect(sentUrls[0]).not.toContain("token=");

      // the welcome arrived carrying the ownership token; a network drop
      // retriggers the handshake, which must re-present it
      sig.setToken("tok-123");
      sig.connect();
      expect(sentUrls[1]).toContain("token=tok-123");

      // reconnects keep presenting the SAME token (slot reclaim, not re-mint)
      sig.connect();
      expect(sentUrls[2]).toContain("token=tok-123");
    } finally {
      g.location = prevLocation;
      g.WebSocket = prevWS;
    }
  });
});
