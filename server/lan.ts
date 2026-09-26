// Pre-filter for room discovery: could this caller and this room member
// plausibly be on the same network? A match here is only a *candidate* —
// the client verifies it for real with a host-only WebRTC probe (see
// src/lib/p2p/lan-probe.ts) before the room is ever displayed.
//
// Rules:
// - identical address: always a candidate
// - private IPv4 (RFC1918/loopback/link-local/CGNAT range) inside one /24:
//   candidate — this covers a LAN-hosted server that sees client LAN IPs
// - public IPv4: exact match ONLY. Two homes behind one CGNAT share the same
//   public IP, so /24 or even exact matches prove nothing — that's exactly
//   what the probe is for.
// - IPv6: one /64. A global-unicast /64 is delegated to a single subscriber
//   LAN, so this is topology-true even for public addresses.

function v4ToInt(s: string): number | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

function isPrivateV4(n: number): boolean {
  const a = n >>> 24;
  const b = (n >>> 16) & 255;
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/**
 * Expand an IPv6 string to its 8 16-bit groups, or null if it isn't IPv6.
 * Handles `::` elision and an embedded IPv4 tail (`::ffff:192.168.0.1`).
 */
function v6Groups(s: string): number[] | null {
  if (!s.includes(":")) return null;
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  // an IPv4 tail is only valid at the end (::ffff:a.b.c.d)
  let embedded: string | null = null;
  if (tail.length && tail[tail.length - 1].includes(".")) embedded = tail.pop()!;
  else if (head.some((g) => g.includes("."))) return null;
  const groups = [...head, ...tail].map((g) =>
    /^[0-9a-fA-F]{1,4}$/.test(g) ? parseInt(g, 16) : NaN,
  );
  if (groups.some(Number.isNaN)) return null;
  if (embedded) {
    const n = v4ToInt(embedded);
    if (n == null) return null;
    groups.push((n >>> 16) & 0xffff, n & 0xffff);
  }
  const fill = 8 - groups.length;
  if (fill < 0 || (halves.length === 2 && fill === 0)) return null;
  groups.splice(head.length, 0, ...Array.from({ length: fill }, () => 0));
  return groups;
}

/** IPv4 relation used everywhere: exact, or one /24 when both are private. */
function v4Related(a: number, b: number): boolean {
  if (a === b) return true;
  return isPrivateV4(a) && isPrivateV4(b) && a >>> 8 === b >>> 8;
}

export function sameLan(a: string, b: string): boolean {
  if (!a || !b) return false;
  a = a.trim().toLowerCase();
  b = b.trim().toLowerCase();
  // exact match also covers loopback and non-IP markers like "local"
  if (a === b) return true;
  const a4 = v4ToInt(a);
  const b4 = v4ToInt(b);
  if (a4 != null && b4 != null) return v4Related(a4, b4);
  if (a4 != null || b4 != null) {
    // mixed families: only match if the v6 side is v4-mapped (::ffff:x.y.z.w)
    const g = v6Groups(a4 != null ? b : a);
    const n = a4 ?? b4;
    if (!g || n == null) return false;
    const mapped = g.slice(0, 5).every((v) => v === 0) && g[5] === 0xffff;
    return mapped && v4Related((g[6] << 16) | g[7], n);
  }
  const ga = v6Groups(a);
  const gb = v6Groups(b);
  if (!ga || !gb) return false;
  return ga.slice(0, 4).join(":") === gb.slice(0, 4).join(":");
}
