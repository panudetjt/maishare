# 03: Transfer size cross-check + claim validation (SEC-02)

**What to build:** Make the announced transfer header bound what the receiver accepts. Inbound file-start claims are validated before any state is built from them (safe non-negative integer size under a hard ceiling; name and mime clamped in length), and the chunk path enforces the protocol invariant: the first byte past the announced size is a protocol violation — the transfer aborts (incoming context cleared, transfer marked errored, a file-cancel with size-mismatch reason sent back, one user-visible toast). The visible byte counter reflects bytes actually received and is never rewritten to the claim. A room peer streaming chunks past a 1-byte claim can no longer grow the receiver's memory without bound.

**Blocked by:** 01 (RoomClient test harness + candidate-queue cap).

**Status:** done (commit series: SEC-06, SEC-01, SEC-02, SEC-03, SEC-04, SEC-05, SEC-07, SEC-08, SEC-09, SEC-10 — see git log)

- [ ] file-start with size=1 followed by chunks: the first chunk crossing the claim aborts the transfer — status errored, incoming context cleared, file-cancel (size-mismatch) sent back, toast shown
- [ ] Claim validation: non-safe-integer, negative, over-ceiling sizes and over-length name/mime are rejected at the header (transfer never starts; backpressure to sender)
- [ ] Byte counter shows received bytes; after any file-end it does not get rewritten to the claimed size
- [ ] Fix-safety (regression-critical): an honest transfer — announced size streamed byte-exactly before file-end — completes unchanged, including multi-chunk files
- [ ] Post-end retention behavior of completed transfers unchanged (addressed separately by ticket 05)
- [ ] Works identically for plaintext frames in keyed rooms (wrong-key sender)
- [ ] Acceptance criteria traceable to SECURITY-SPEC.md item SEC-02
