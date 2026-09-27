# 05: Transfer-list caps, supersede settle, stale sweep (SEC-04)

**What to build:** Make the receiver's transfer list always boundable. Concurrent in-flight inbound transfers per peer are capped, with excess file-starts answered by explicit file-cancel backpressure instead of being enqueued. A superseding file-start settles the previous incoming transfer (cancelled) rather than orphaning it as permanently 'active', and a late file-end for a settled id stays ignored. An inactivity watchdog riding the existing per-peer ping interval fails stalled 'active' inbound transfers. The bulk Clear action also retires stale actives, so it always bounds the list, and object URLs of dropped entries are revoked. After this ticket, a bare-file-start flood can no longer pin unremovable UI state, and completed transfers' blobs do not linger past dismissal.

**Blocked by:** 03 (Transfer size cross-check + claim validation — same file-start handler; builds on its claim clamps).

**Status:** done (commit series: SEC-06, SEC-01, SEC-02, SEC-03, SEC-04, SEC-05, SEC-07, SEC-08, SEC-09, SEC-10 — see git log)

- [ ] Bare file-start flood: concurrent 'active' inbound transfers per peer never exceed the cap; excess headers receive file-cancel backpressure and create no list entry
- [ ] Supersede: a second file-start settles the previous incoming transfer as cancelled (not orphaned 'active'); a late file-end for the settled id changes nothing
- [ ] Stale sweep: an 'active' inbound transfer with no progress fails after the inactivity timeout (watchdog on the existing ping interval); the user's Clear action retires stale actives too
- [ ] Completed transfers: Clear revokes object URLs and releases blobs of dropped entries; the Clear action always leaves a bounded list
- [ ] Fix-safety: a normal single and a normal sequential multi-file transfer behave exactly as before (no spurious cancels/timeouts under active progress)
- [ ] Keyed room: plaintext file-start floods bounded identically
- [ ] Acceptance criteria traceable to SECURITY-SPEC.md item SEC-04
