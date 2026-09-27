# NV-01…06 owner observations — evidence log

Ticket 11 (needs-validation leads from SECURITY-SPEC.md). This file is the
single place to record each observation. **No code change is in scope for any
lead until its observation exists**; the countermeasure named per lead becomes
a follow-up ticket only if the evidence warrants it.

Record per lead: **validated / not validated / accepted residual risk**, the
date, the deciding fact learned, and any artifact (screenshot, log excerpt,
dashboard export) — link or inline it under the lead.

## NV-01 — zip-slip (gallery/attachment zip entry names)

- [ ] Check done: two dummy sessions save-all with a traversal-named file;
      archive listing checked (`unzip -l`); extraction observed with a known
      non-normalizing extractor in a throwaway directory; recipient extractor
      landscape surveyed.
- Result: _validated / not validated / accepted residual risk_
- Date: ______ Deciding fact: ______
- Evidence: ______
- Countermeasure if warranted: pure filename-flattening helper at the
  zip/download seam (basename + extension handling), testable without a
  browser.

## NV-02 — Lobby scan cardinality

- [ ] Check done: harness extended to ~225k pairs confirming linearity only;
      owner watched Lobby DO CPU per discover request, p99 latency, and
      announce queueing with a controlled tenant.
- Result: _validated / not validated / accepted residual risk_
- Date: ______ Deciding fact: ______
- Evidence: ______
- Countermeasure if warranted: aggregate caps on Lobby rooms/ips.

## NV-03 — room key in request lines

- [ ] Check done: local miniflare-with-observability navigation/refresh test
      inspected for query-string capture; zone logging layers (observability
      sampling, log push, analytics, fronting proxies, asset-tier request
      logs — and their retention) reviewed.
- Result: _validated / not validated / accepted residual risk_
- Date: ______ Deciding fact: ______
- Evidence: ______
- Escalation if any layer records query strings: adopt the fragment-key
  (`#k=`) design; otherwise it stays optional defense-in-depth.

## NV-04 — Room DO persistence

- [ ] Check done: staging flood of bare upgrade-only requests observed against
      the DO dashboard (object count, storage bytes) versus platform
      throttling.
- Result: _validated / not validated / accepted residual risk_
- Date: ______ Deciding fact: ______
- Evidence: ______
- Decision to record: per-address creation cap or TTL cleanup alarm (either
  would become a follow-up ticket).

## NV-05 — cross-origin WS poisoning of discovery

- [ ] Check done: cross-origin socket held against staging for two minutes;
      Lobby announce metrics and discovery output checked for the planted
      room; confirms whether any edge rule already blocks it.
- Result: _validated / not validated / accepted residual risk_
- Date: ______ Deciding fact: ______
- Evidence: ______
- Countermeasure if warranted: upgrade-time Origin allowlist.

## NV-06 — SDP/ICE LAN probing

- [ ] Check done: two-tab webrtc-internals observation of connectivity checks
      to a controlled internal-IP candidate plus the hello-oracle;
      supported-browser matrix (mDNS obfuscation, remote-candidate dialing,
      enterprise policy) verified on the owner's fleet.
- Result: _validated / not validated / accepted residual risk_
- Date: ______ Deciding fact: ______
- Evidence: ______
- Countermeasure if warranted: candidate-address policy at the signaling
  sinks.
