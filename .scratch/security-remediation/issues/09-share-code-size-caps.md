# 09: Share-code size caps (SEC-09)

**What to build:** Make the share-code paste path safe against decompression bombs. Input length is capped before any decoding; inflation runs through a size-counting reader that aborts as soon as the byte ceiling is exceeded; the uncompressed fallback branch is held under the same caps; and the accepted SDP length is capped after parse. Each rejection stage produces its own distinct error message. After this ticket, a crafted ~100 KB pasted code can no longer allocate hundreds of megabytes in the receiver's tab before validation rejects it, while real QR-sized handoffs keep working.

**Blocked by:** None (can start immediately).

**Status:** done (commit series: SEC-06, SEC-01, SEC-02, SEC-03, SEC-04, SEC-05, SEC-07, SEC-08, SEC-09, SEC-10 — see git log)

- [ ] Over-length input (paste far beyond any real code) is rejected before decode with a distinct "too long" error — no decode, no inflate, no parse
- [ ] Sub-cap input whose inflation exceeds the byte ceiling is aborted mid-inflate with a distinct "too large" error — the expansion is never fully materialized
- [ ] Oversized SDP inside an otherwise valid shape is rejected after parse; existing corrupted/invalid error messages preserved
- [ ] Uncompressed fallback branch honors the same input and byte caps
- [ ] Fix-safety: real gathered-SDP codes (offer and answer, compressed and fallback) pack and unpack exactly as before — existing share-code tests stay green
- [ ] Cap constants comfortably exceed real QR-bounded codes and real gathered SDPs (per the spec's numbers)
- [ ] Acceptance criteria traceable to SECURITY-SPEC.md item SEC-09
