# 01: RoomClient test harness + candidate-queue cap (SEC-06)

**What to build:** The smallest receiver-side security fix, delivered together with the reusable test seam it needs — a harness that drives the real RoomClient through its public API with a stubbed signaling transport and stubbed WebRTC objects (data channels fed frame bytes; outbound frames captured and assertable by type byte and payload). Riding on that harness, the pre-description ICE-candidate buffer stops accepting beyond a small fixed cap (drop the excess), because a legitimate peer trickles only a handful of candidates before the remote description lands. After this ticket, an attacker who joins a room's signaling and streams candidate-shaped messages without ever sending SDP can no longer grow a member's memory without bound — and every later client-side ticket has a proven seam to test at.

**Blocked by:** None (can start immediately).

**Status:** done (commit series: SEC-06, SEC-01, SEC-02, SEC-03, SEC-04, SEC-05, SEC-07, SEC-08, SEC-09, SEC-10 — see git log)

- [x] Harness drives the real RoomClient via its public API with a stubbed transport and stubbed RTCPeerConnection/DataChannel; outbound frames are captured and assertable byte- and type-exactly (no private-state inspection)
- [x] Candidate flood with no SDP ever sent: the pre-description candidate queue holds at most the cap; excess candidates are dropped silently
- [x] One arriving remote description drains exactly the queued set to the WebRTC sink; candidates arriving after the description bypass the queue entirely (steady-state trickle unchanged)
- [x] Queue is still released on peer-leave and on reconnect (existing behavior preserved)
- [x] Fix-safety: a normal negotiation (offer/answer plus a few candidates) completes unchanged
- [x] Acceptance criteria traceable to SECURITY-SPEC.md item SEC-06
