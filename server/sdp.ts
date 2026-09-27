// NV-06 countermeasure: SDP relayed between signaling peers is filtered so
// that ICE candidates pointing at internal addresses only ever flow between
// peers whose IPs PROVE a shared network (see lan.ts). A remote attacker's
// crafted SDP therefore cannot aim a victim's browser at LAN/loopback
// targets, while LAN peers — the whole point of the app — keep exchanging
// the private candidates they legitimately need. Public STUN (server-
// reflexive) candidates and mDNS `.local` names pass through untouched.
// Kept free of Workers runtime imports so it unit-tests under plain vitest.
import { isPrivateAddress, provableLan } from "./lan";

/**
 * Return `sdp` with internal-address `a=candidate:` lines removed unless the
 * sender and receiver are provably LAN peers. Non-candidate lines (including
 * malformed candidates) are preserved byte-for-byte.
 */
export function sanitizeSdpCandidates(sdp: string, senderIp: string, receiverIp: string): string {
  const lanPeers = provableLan(senderIp, receiverIp);
  // split on every EOL variant — a lone-\n SDP must not slip past the filter
  return sdp
    .split(/\r\n|\n|\r/)
    .filter((line) => {
      if (lanPeers || !/^a=candidate:/i.test(line)) return true;
      // RFC 5245 candidate-attribute: foundation component transport priority
      // address port typ ... — the connection-address is field 4
      const parts = line
        .replace(/^a=candidate:/i, "")
        .trim()
        .split(/\s+/);
      const addr = parts[4];
      if (!addr) return true;
      if (addr.toLowerCase().endsWith(".local")) return true; // mDNS: no address leak
      return !isPrivateAddress(addr);
    })
    .join("\r\n");
}
