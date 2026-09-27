# 11: Record NV-01…06 owner observations (needs-validation leads)

**What to build:** Not a code ticket — an evidence-gathering checklist owned by the deployment owner. Each of the six needs-validation leads from SECURITY-SPEC.md gets its observation recorded (result, date, and the deciding fact learned). No code change for any lead is in scope until its observation exists; each lead below names its decided countermeasure, which becomes a follow-up ticket only if the evidence warrants it. Record outcomes as notes alongside the spec (the evidence log template lives at `../nv-observations.md`).

**Blocked by:** None (can start immediately — owner task, not agent-implementable).

**Status:** awaiting owner observation — evidence log template at ../nv-observations.md

- [ ] NV-01 (zip-slip): two dummy sessions save-all with a traversal-named file; archive listing checked; extraction with a known non-normalizing extractor observed in a throwaway directory; recipient extractor landscape surveyed. Countermeasure if warranted: pure filename-flattening helper at the zip/download seam
- [ ] NV-02 (Lobby scan cardinality): harness extended to ~225k pairs confirming linearity only; owner watches Lobby DO CPU per discover request, p99 latency, and announce queueing with a controlled tenant
- [ ] NV-03 (room key in request lines): local miniflare-with-observability navigation/refresh test inspected for query-string capture; zone logging layers (observability sampling, log push, analytics, fronting proxies, asset-tier request logs — and retention) reviewed. Escalation if any layer records query strings: adopt the fragment-key design
- [ ] NV-04 (Room DO persistence): staging flood of bare upgrade-only requests observed against the DO dashboard (object count, storage bytes) versus platform throttling; decision recorded on a per-address creation cap or TTL cleanup alarm
- [ ] NV-05 (cross-origin WS poisoning): cross-origin socket held against staging for two minutes; Lobby announce metrics and discovery output checked for the planted room; confirms whether any edge rule already blocks it. Countermeasure if warranted: upgrade-time Origin allowlist
- [ ] NV-06 (SDP/ICE LAN probing): two-tab webrtc-internals observation of connectivity checks to a controlled internal-IP candidate plus the hello-oracle; supported-browser matrix (mDNS obfuscation, remote-candidate dialing, enterprise policy) verified on the owner's fleet. Countermeasure if warranted: candidate-address policy at the signaling sinks
- [ ] Each recorded outcome states: validated / not validated / accepted residual risk, with the evidence note linked
