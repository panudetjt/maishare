// Ticket 13 / NV-06 — the pure SDP candidate filter. Internal-address
// candidates only survive when sender and receiver provably share a network;
// public STUN candidates and mDNS names always pass; structure is preserved.
import { describe, expect, it } from "vite-plus/test";
import { sanitizeSdpCandidates } from "./sdp";

const HEAD = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\n";
const line = (addr: string, port = 40000, typ = "host") =>
  `a=candidate:1 1 udp 2130706431 ${addr} ${port} typ ${typ}\r\n`;

function relay(sdp: string, from: string, to: string): string {
  return sanitizeSdpCandidates(sdp, from, to);
}

describe("sanitizeSdpCandidates (NV-06)", () => {
  it("drops internal candidates between non-provable peers", () => {
    const out = relay(
      HEAD + line("127.0.0.1") + line("192.168.1.7") + line("10.0.0.5") + line("172.16.3.4"),
      "203.0.113.7",
      "198.51.100.5",
    );
    expect(out).toBe(HEAD);
  });

  it("drops IPv6 ULA, link-local and v4-mapped internals cross-network", () => {
    const out = relay(
      HEAD + line("fd12:3456:789a::1") + line("fe80::1") + line("::ffff:192.168.1.7") + line("::1"),
      "203.0.113.7",
      "198.51.100.5",
    );
    expect(out).toBe(HEAD);
  });

  it("keeps ALL candidates between provable-LAN peers (no filtering at all)", () => {
    // a real LAN peer may legitimately advertise several interfaces
    const out = relay(
      HEAD + line("192.168.1.7") + line("10.0.0.5"),
      "192.168.1.10",
      "192.168.1.44",
    );
    expect(out).toContain("192.168.1.7");
    expect(out).toContain("10.0.0.5");
  });

  it("keeps internal candidates across a provable /64 (fix-safety)", () => {
    const out = relay(HEAD + line("2001:db8:1:2::15"), "2001:db8:1:2::7", "2001:db8:1:2::99");
    expect(out).toContain("2001:db8:1:2::15");
  });

  it("keeps internal candidates for the internal dev marker (fix-safety)", () => {
    const out = relay(HEAD + line("127.0.0.1"), "local", "local");
    expect(out).toContain("127.0.0.1");
  });

  it("keeps public STUN candidates cross-network", () => {
    const out = relay(HEAD + line("203.0.113.9", 50000, "srflx"), "203.0.113.7", "198.51.100.5");
    expect(out).toContain("203.0.113.9");
  });

  it("keeps mDNS .local candidates cross-network (no address leak)", () => {
    const out = relay(HEAD + line("abcd-efgh-ijkl.local", 40000), "203.0.113.7", "198.51.100.5");
    expect(out).toContain("abcd-efgh-ijkl.local");
  });

  it("preserves malformed candidate lines and non-candidate lines", () => {
    const sdp = HEAD + "a=candidate:broken-line\r\n" + "a=mid:0\r\n" + "a=setup:actpass\r\n";
    const out = relay(sdp, "203.0.113.7", "198.51.100.5");
    expect(out).toBe(sdp);
  });

  it("handles SDP with only \\n terminators (normalized to \\r\\n)", () => {
    const out = relay(
      "v=0\na=candidate:1 1 udp 1 192.168.1.7 1 typ host\n",
      "203.0.113.7",
      "198.51.100.5",
    );
    expect(out).toBe("v=0\r\n");
  });
});
