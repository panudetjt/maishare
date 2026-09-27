# 08: Peer-id ownership token (SEC-08)

**What to build:** Make a member's peer identity unforgeable. The room's Durable Object mints a random ownership token at first admission, persists it in storage, delivers it in the welcome message, and stores it in the socket attachment. A later join presenting the same peer id may evict the incumbent only when it presents the matching token; without it the join is refused ("peer id in use") and the incumbent stays connected with truthful relay attribution. The signaling client remembers the token from welcome and re-presents it on every retry/reconnect, so the reconnect-reclaim experience is preserved. Tokens are cleaned up after the room drains (with a grace period).

**Blocked by:** None (can start immediately).

**Status:** done (commit series: SEC-06, SEC-01, SEC-02, SEC-03, SEC-04, SEC-05, SEC-07, SEC-08, SEC-09, SEC-10 — see git log)

- [ ] Token-less join presenting a member's in-use peer id: refused, incumbent socket stays open, no eviction broadcast, relay attribution unchanged
- [ ] Legitimate reconnect with the token: replaces the old socket exactly as today (reclaim preserved)
- [ ] Welcome carries the token; the signaling client stores it and re-presents it on retry/reconnect (drop-and-reload flow reclaims the slot)
- [ ] Probe joins still never evict (existing early-return preserved)
- [ ] Token lifecycle: persisted across DO hibernation/restart; deleted after room drain within the grace period; a fresh claim after cleanup works
- [ ] Fix-safety: normal multi-member sessions (join, drop, reconnect, leave) behave exactly as before
- [ ] Acceptance criteria traceable to SECURITY-SPEC.md item SEC-08
