# 13: Candidate-address policy at the signaling relay (NV-06 countermeasure)

**What to build:** Stop remote parties from pointing a member's ICE agent at
internal addresses. The staging/local run validated NV-06: a real browser that
applies an attacker-crafted remote SDP immediately sends connectivity checks
(UDP) to whatever host candidate the SDP names — we watched 4 packets land on
`127.0.0.1` under our control. That is a LAN/internal scanning primitive and
an mDNS-bypass channel. Policy: the Room DO already relays every `signal`
message, so it is the one chokepoint — before relaying SDP text, parse its
`a=candidate:` lines and **drop every candidate whose connection-address is a
private-range IP (RFC1918, loopback, link-local, CGNAT) or IPv6 ULA/link-local
UNLESS the sender and the receiving peer are provably on the same network**,
reusing the existing `provableLan` predicate over the two sockets' member IPs
(same private /24, same /64, or the internal dev marker). Provable-LAN peers
keep exchanging private candidates — that is exactly how the LAN/Nearby use
case connects — while internet-only peers lose nothing (they connect via STUN
server-reflexive candidates). Non-IP candidates (mDNS `.local`) pass through
untouched. Extract the candidate filter as a pure, unit-tested helper
(`sanitizeSdpCandidates(sdp, senderIp, receiverIp)`), the seam the spec's
testing decisions call for.

**Blocked by:** None.

**Status:** ready-for-agent

- [ ] Pure helper unit table: private/loopback/ULA/link-local candidates
      dropped when sender↔receiver relation is not provable; kept when it is
      (private /24, /64, `local` marker); public STUN candidates and mDNS
      `.local` always kept; malformed candidate lines survive untouched
- [ ] Relay-level test: attacker SDP with `127.0.0.1` / RFC1918 candidates
      relayed between two non-LAN-provable sockets arrives with those lines
      removed; the same SDP between `local`-marked dev sockets arrives intact
- [ ] Repro regression: `scripts/nv/nv06-ice-probe.mjs` against a local deploy
      no longer lands any packet on the listener (attack must fail to harm)
- [ ] Fix-safety: full e2e suite — same-machine room transfer (loopback
      candidates, provable via dev marker) and nearby/QR flows stay green
- [ ] Keyed rooms: policy is identical with or without a room key (signaling
      layer, not payload layer)
- [ ] Acceptance criteria traceable to SECURITY-SPEC.md NV-06 (evidence:
      `.scratch/security-remediation/nv-observations.md` — validated
      2026-09-27, browser dialed attacker-supplied internal candidate)
