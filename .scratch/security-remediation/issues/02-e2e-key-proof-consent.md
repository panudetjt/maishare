# 02: Key-proof + consent — keyed rooms withhold payloads from unproven peers (SEC-01)

**What to build:** Close the audit's highest-severity confidentiality break end-to-end. In a room created with a key, payload content (chat text, file-start headers, file chunks) is withheld — never silently downgraded to plaintext — from peers that have not proven possession of the room key, unless the sender explicitly consents per peer. Proof is a key-confirmation exchange riding the existing ping/pong controls: the sender seals a ping carrying a nonce; only a key holder can return a sealed pong echoing it. The self-asserted capability flag alone no longer licenses plaintext delivery. A prominent blocking consent prompt (one per unproven peer) becomes the escape hatch for genuinely WebCrypto-incapable peers, preserving the documented iOS/plain-HTTP fallback. Protocol frames (hello, ping, pong, bye, file-end, file-cancel, undecryptable notices) stay unsealed so connectivity survives.

**Blocked by:** 01 (RoomClient test harness + candidate-queue cap).

**Status:** done (commit series: SEC-06, SEC-01, SEC-02, SEC-03, SEC-04, SEC-05, SEC-07, SEC-08, SEC-09, SEC-10 — see git log)

- [ ] Keyed sender + peer claiming incapability with no proof: chat and file content are withheld (no plaintext payload frames on the wire); protocol frames still flow
- [ ] Key-confirmation: a peer that answers the sealed nonce ping with a sealed echoing pong is marked proven and receives sealed payloads as before
- [ ] Consent gate: explicit per-peer consent releases withheld payloads (plaintext delivery) with the prominent blocking prompt; refusal keeps withholding; the choice is remembered per peer
- [ ] Wrong-key member (asserts capability, fails to unseal): existing undecryptable warning path unchanged
- [ ] Keyless joiner in a keyed room receives no chat/file content (unit-level via harness: no payload frames delivered)
- [ ] End-to-end regression in the browser suite: a secure-context joiner without the key gets nothing; the stripped-crypto insecure-context case clicks through consent and receives content; the room-header lock still reflects key presence
- [ ] Deferred traffic queued before connection is only flushed for proven/consented peers (or when no key exists)
- [ ] Acceptance criteria traceable to SECURITY-SPEC.md item SEC-01
