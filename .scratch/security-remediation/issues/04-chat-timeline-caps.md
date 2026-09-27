# 04: Chat timeline caps (SEC-03)

**What to build:** Bound the retained chat timeline from peer input. Inbound chat text is truncated per message to match the composer's outbound limit, and the retained chat list is kept under a rolling cap (oldest dropped). Both bounds apply to plaintext control frames regardless of the room key, so a wrong-key member is equally bounded. After this ticket, a peer streaming maximal chat frames can no longer grow another member's memory and per-render cost without bound, nor outpace the manual Clear action.

**Blocked by:** 01 (RoomClient test harness + candidate-queue cap).

**Status:** done (commit series: SEC-06, SEC-01, SEC-02, SEC-03, SEC-04, SEC-05, SEC-07, SEC-08, SEC-09, SEC-10 — see git log)

- [ ] Oversized inbound chat text is stored truncated to the per-message cap (matching the composer's outbound limit); short messages unchanged
- [ ] Sustained chat frames keep the retained list at or below the rolling cap (oldest entries dropped)
- [ ] Manual Clear still empties the list; refill after Clear is bounded by the same caps
- [ ] Keyed room: plaintext chat frames from a wrong-key peer are truncated and capped identically
- [ ] Sender's own messages are not truncated by the inbound path (outbound behavior unchanged)
- [ ] Fix-safety: normal conversation renders and groups exactly as before
- [ ] Acceptance criteria traceable to SECURITY-SPEC.md item SEC-03
