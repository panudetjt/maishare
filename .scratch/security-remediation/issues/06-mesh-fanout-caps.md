# 06: Mesh fan-out caps — client peer cap + timeout, server join caps (SEC-05)

**What to build:** Bound roster-driven connection fan-out on both sides of the wire. Client: the peers map refuses to allocate new peer connections beyond a small cap (roster entries beyond the cap stay inert — no connection, no data channel, no offers), never-connecting peer contexts are evicted after a timeout with no remote description, and a failed connection state releases its context instead of persisting forever. Server: the room's Durable Object rejects non-probe joins beyond a room-size cap and a per-address membership cap before accepting the WebSocket, so each join's roster-broadcast fan-out is bounded. After this ticket, an anonymous attacker holding many signaling sockets can no longer drive unbounded heavyweight allocations in every member's tab.

**Blocked by:** 01 (RoomClient test harness + candidate-queue cap).

**Status:** done (commit series: SEC-06, SEC-01, SEC-02, SEC-03, SEC-04, SEC-05, SEC-07, SEC-08, SEC-09, SEC-10 — see git log)

- [ ] Client: a welcome roster larger than the cap allocates exactly the cap; extra entries stay inert (no connection objects created for them); a peer-join beyond the cap is ignored
- [ ] Client: a peer context still 'connecting' after the timeout with no remote description is evicted; a failed connection state also releases the context
- [ ] Server: joins beyond the room-size cap and beyond the per-address cap are refused with an error response before the upgrade completes; roster broadcasts stay within the cap
- [ ] Probe joins remain exempt from both server caps (existing probe-path behavior unchanged)
- [ ] Reconnect rebuild honors the cap (wholesale rebuild never exceeds it)
- [ ] Fix-safety: a normal small-room session (several peers joining, chatting, transferring, leaving) behaves exactly as before
- [ ] Acceptance criteria traceable to SECURITY-SPEC.md item SEC-05
