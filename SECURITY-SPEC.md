# Security Spec — maishare (single source of truth for validation)

Status: ready-for-agent · Scope: remediation of the run-1 security audit (`~/security-audit-skill/maishare/run-1/`, source ref `e54f8e0` + dirty worktree)

This spec is the single source of truth for validating the security remediation work. It covers every confirmed finding of the audit (SEC-01…SEC-10) and every unresolved validation lead (NV-01…NV-06). A remediation is "done" only when every acceptance criterion listed here passes at the seam named here. If this file and any other document disagree, this file wins.

## Problem Statement

A full security audit of maishare confirmed ten vulnerabilities and left six leads blocked on deployment facts. Today there is no single, testable statement of what "fixed" means for any of them: the remediation guidance lives in prose reports outside the repository, some of it advisory, some overlapping. A developer fixing one finding has no authoritative acceptance criteria, and a reviewer validating the fix has to re-derive expected behavior from audit prose.

## Solution

One spec in the repository that states, per finding, the security invariant the code must enforce, the observable acceptance criteria that prove it, and the seam at which it is validated. It also tracks the six needs-validation leads as explicit owner-observed checks so they are neither forgotten nor silently turned into code changes without evidence. Completing this spec means: every SEC item's acceptance criteria pass in the automated suite, and every NV item has a recorded owner observation (or a decision to accept the residual risk).

## User Stories

1. As a room member who created a keyed room, I want every payload frame I send to be sealed unless the receiving peer has proven possession of the room key (or I explicitly consented to unsealed delivery), so that knowing the room id alone never grants readability of my chat and files.
2. As a keyed room member, I want to be warned before — not after — any unsealed delivery to a peer that has not proven key possession, so that the iOS/insecure-context fallback stays usable without a silent downgrade for keyless joiners.
3. As an anonymous visitor who only knows a room id, I want my keyless join to receive no payload content from keyed members, so that I cannot read sealed-room traffic without the invite key. (Adversarial story — must fail after the fix.)
4. As a wrong-key member, I want my sealed-frame failures to stay on the existing undecryptable warning path, so that the fix for SEC-01 does not regress the designed wrong-key behavior.
5. As a receiving member, I want every incoming transfer to be aborted as a protocol violation the moment accumulated bytes exceed the announced size, so that a peer cannot grow my tab's memory without bound by streaming past a 1-byte claim.
6. As a sending member, I want my honest transfers — which stream exactly the announced size before file-end — to complete unchanged, so that the new cross-check breaks no legitimate transfer.
7. As a receiving member, I want inbound file-start claims (size, name, mime) validated and clamped before any state is built from them, so that absurd sizes and huge name/mime strings never reach my UI or buffers.
8. As a receiving member, I want inbound chat text truncated per message and the retained chat timeline kept under a rolling cap, so that a peer cannot grow my memory and per-render cost without bound or outpace my manual Clear.
9. As a receiving member in a keyed room, I want the chat caps to apply to plaintext control frames from wrong-key peers too, so that keying a room does not create an unbounded-input exception.
10. As a receiving member, I want the number of concurrently-active inbound transfers per peer capped with explicit backpressure to the sender, so that bare file-start floods cannot pin my transfer list.
11. As a receiving member, I want a superseded or never-completed inbound transfer to leave the 'active' state (settled as cancelled, or failed after an inactivity timeout), so that the Clear action can always bound the list and no entry is immune to every bulk cleanup.
12. As a receiving member, I want completed transfers' blobs and object URLs released when I clear finished transfers, so that attacker-supplied bytes do not linger after I dismissed them.
13. As a room member, I want the roster-driven mesh to stop allocating new peer connections beyond a small cap, so that anonymous join floods cannot allocate unbounded RTCPeerConnections in my tab.
14. As a room member, I want never-connecting peer contexts to be evicted after a timeout, so that phantom joins do not hold heavyweight allocations indefinitely.
15. As an operator, I want the Room DO to reject joins beyond room-size and per-address membership caps, so that each join's O(room) broadcast fan-out is bounded and roster payloads stay small.
16. As an anonymous joiner, I want my relayed candidate flood to stop at a small pre-description buffer, so that queuing candidates without ever sending SDP no longer grows a victim's memory without bound. (Adversarial story — must fail after the fix.)
17. As a negotiating peer, I want steady-state candidate trickle after the remote description to behave exactly as before, so that the pre-description cap affects no legitimate negotiation.
18. As a caller of LAN discovery, I want roster content (member names, counts) withheld unless the IP relation provably implies a shared network, so that a mere public-IP match behind CGNAT no longer discloses room-global rosters.
19. As a caller of LAN discovery whose relation is provable (private /24, v4-mapped, IPv6 /64), I want to keep receiving the full response including names, so that genuine same-network discovery is unchanged.
20. As a caller of LAN discovery, I want the room id itself still listed for probe-verifiable matches, so that the client-side host-only verification flow keeps working.
21. As a room member, I want my peer identity reclaimable only with an ownership token minted at my first admission, so that a stranger who reads my peer id from the roster cannot evict my socket or send traffic under my identity.
22. As a reconnecting member (network drop, reload), I want my client to re-present the token automatically and reclaim my slot, so that the anti-takeover fix preserves the reconnect experience.
23. As a joiner attempting to take over an in-use peer id without the token, I want to be refused, so that the incumbent's socket stays open and relay attribution stays truthful. (Adversarial story — must fail after the fix.)
24. As a member pasting a share code, I want over-long inputs rejected before decoding and inflation aborted past a byte cap, so that a crafted ~100 KB code cannot allocate hundreds of megabytes in my tab before validation rejects it.
25. As a member scanning a QR share code, I want well-formed real codes (≤ ~16 KB input, ≤ ~512 KB inflated) to keep working, so that the caps never reject a legitimate handoff.
26. As an operator running dev or preview, I want the server to bind localhost by default, so that running `dev`/`preview` on a hostile network does not silently expose the worker (and its forwarded-header identity trust) to the LAN.
27. As the discovery service, I want only syntactically valid IP addresses accepted as network identity, so that arbitrary strings — including the 'local' fallback marker — can never act as a match key for an external request.
28. As a developer, I want each SEC item's acceptance criteria expressed as automated tests at existing seams, so that validation is repeatable without re-running the audit.
29. As a reviewer, I want one file that maps every audit finding to its invariant, criteria, and seam, so that I can verify completeness without reading the audit reports.
30. As an operator, I want each needs-validation lead recorded with its exact owner-observed check, so that deployment-dependent risks are decided by evidence, not assumption.
31. As an operator, I want the vendored-wasm provenance and advisory-scan gaps visible as explicit non-blocking tasks, so that they are tracked without being confused with confirmed findings.

## Implementation Decisions

Confirmed findings and the decided remediations. Severity reflects the audit's demonstrated impact.

### SEC-01 (high) — Unauthenticated hello.e2e downgrades keyed rooms to plaintext

- Root cause: the per-peer sealing decision trusts the peer's self-asserted capability flag; "cannot do WebCrypto" and "does not have the key" are indistinguishable, and the ambiguity resolves toward plaintext delivery.
- Decision: separate capability from proof. A peer context gains a distinct "proven" state that is set only by a key-confirmation exchange (the sender seals a ping carrying a nonce; only a key holder can return a sealed pong echoing it) — or by explicit per-peer user consent, which remains the escape hatch for genuinely WebCrypto-incapable peers (the documented iOS/plain-HTTP case).
- While the local room key exists, payload controls (chat, file-start, and file chunks) are withheld — never downgraded — to peers that are neither proven nor consented. Protocol frames (hello, ping, pong, bye, file-end, file-cancel, undecryptable) stay unsealed so connectivity survives.
- The welcome/transport retry path carries the peer-id ownership token (SEC-08) and the proof nonce flow rides the existing ping/pong controls; no new wire frame types are introduced beyond the nonce field.
- The UI shows one prominent blocking consent prompt per unproven peer, replacing the current post-hoc open-lock icon as the only disclosure. The room-header lock continues to reflect key presence.
- e2e regression: a secure-context joiner without the key must receive no chat/file content; the existing insecure-context (no crypto.subtle) case clicks through the consent gate.

### SEC-02 (medium) — Receiver chunk buffer never cross-checks the announced size

- Invariant: received bytes ≤ claimed size ≤ hard ceiling; the first excess byte is a protocol violation.
- The file-start handler validates claims before building state: size must be a safe non-negative integer under a hard ceiling; name and mime are clamped in length.
- The chunk path aborts on excess: clear the incoming context, mark the transfer errored, send file-cancel back with a size-mismatch reason, and surface one toast. The byte counter must reflect received bytes (never rewritten to the claim at file-end).
- Honest senders stream exactly the announced size before file-end, so this breaks no legitimate transfer (verified against the real send path during the audit).

### SEC-03 (medium) — Chat timeline grows without per-frame or aggregate caps

- Inbound chat text is truncated to match the composer's outbound limit; the retained chat list is kept under a rolling cap (drop oldest). Both apply to plaintext frames regardless of room key, since wrong-key members can send them.

### SEC-04 (medium) — Transfer-list entries survive the receiver's only bulk clear

- Concurrent in-flight inbound transfers per peer are capped; excess file-starts get an explicit file-cancel backpressure response and are not enqueued.
- A superseding file-start settles the previous incoming view to cancelled instead of orphaning it; a late file-end for a settled id is ignored (existing id-guard behavior).
- An inactivity watchdog (riding the existing per-peer ping interval) fails stalled 'active' inbound transfers; the bulk clear also retires stale actives, so the Clear action always bounds the list. Object URLs of dropped entries are revoked.

### SEC-05 (medium) — Uncapped roster-driven RTCPeerConnection fan-out

- Client: the peers map refuses allocation beyond a small cap; roster entries beyond the cap stay inert (no connection, no channel, no offers). 'Connecting' peer contexts are evicted after a timeout with no remote description. A failed connection state also releases the context instead of persisting forever.
- Server: the Room DO rejects non-probe joins beyond a room-size cap and a per-address membership cap before accepting the WebSocket. Probe joins remain exempt (bounded separately by the existing probe cap).

### SEC-06 (medium) — Unbounded pre-description candidate queue

- The candidate buffer is capped at a small fixed count (drops beyond the budget); candidates arriving after the remote description continue to bypass the queue entirely. SDP-content validation is explicitly out of scope here (see NV-06).

### SEC-07 (low) — Discovery discloses rosters on a bare public-IP match

- A new pure predicate distinguishes topology-provable relations (private /24, v4-mapped equality, IPv6 /64, and the loopback dev marker) from bare public-IP equality, which proves nothing behind CGNAT.
- Discovery uses it to gate the disclosure itself: provable matches keep the full response; non-provable matches return the room id only (which the client's host-only probe needs) with roster content withheld. Roster content remains available to actual joiners via the existing welcome message.

### SEC-08 (low) — Self-asserted peer id enables eviction and impersonation

- The Room DO mints a random ownership token at first admission, persists it in DO storage, delivers it in welcome, and stores it in the socket attachment. A same-peer-id join may evict the incumbent only when it presents the matching token; otherwise it is refused ("peer id in use") and the incumbent stays connected.
- The signaling client remembers the token from welcome and re-presents it on every retry/reconnect, preserving the reconnect-reclaim behavior. Tokens are deleted after the room drains (grace period).

### SEC-09 (low) — Share-code paste path is a decompression bomb

- Input length is capped before any decode (comfortably above real QR-bounded codes). Inflation is streamed through a size-counting reader that aborts past a byte ceiling; the uncompressed fallback branch is held under the same caps. The accepted SDP length is capped after parse. Rejection errors are distinct per stage ("too long", "too large", existing corruption/invalid messages).

### SEC-10 (low) — CF-Connecting-IP trusted verbatim as both discovery identities

- Both consumption points (member identity at join, caller identity at discovery) validate the header value as a syntactically valid IP and fail closed otherwise; the headerless fallback stays internal and can never be supplied by an external request. This eliminates the arbitrary-string/'local' match-key collapse on any ingress.
- Dev/preview server binding defaults to localhost; exposing to the LAN stays the explicit `--host` opt-in the README documents. (The repo-maintained modes forward client-supplied header values verbatim — verified end-to-end during the audit — so the config default is the practical exposure control there.)
- Chosen-IP spoofing behind a non-Cloudflare ingress can only be prevented by the ingress itself; the spec records this as an accepted residual for self-hosted deployments (see NV-05 for the related cross-origin check).

### Needs-validation leads — owner-observed checks, no code mandated by this spec

- NV-01 zip-slip: archive entry names are peer-controlled (byte-verified). Blocker: the victim's extractor. Check: dummy two-session save-all + `unzip -l`, extraction with a known non-normalizing extractor in a throwaway directory; owner survey of the recipient extractor landscape. Preventive option if validated: flatten entry names (single pure helper) — decide after the check.
- NV-02 Lobby singleton scan cardinality: linear growth measured, no aggregate caps. Blockers: DO serialization/CPU ceilings, edge WS/WAF limits. Check: extend the harness to ~225k pairs (linearity only); owner watches Lobby DO CPU/p99 and announce queueing with a controlled tenant.
- NV-03 Room key in request lines: transmission verified end-to-end; no in-source reader. Blocker: whether edge/CDN/observability layers record query strings. Check: local miniflare-with-observability navigation test; owner review of zone logging layers and retention. If any layer records query strings, escalate and adopt the fragment-key (`#k=`) design; otherwise fragment-key remains optional defense-in-depth.
- NV-04 Room DO rows persist forever: persistence and absence of any cleanup verified under real workerd. Blocker: account quotas/throttling and shared blast radius. Check: owner staging run of bare Upgrade-only requests against the DO dashboard; then decide a per-address creation cap or a TTL cleanup alarm.
- NV-05 Cross-origin WebSocket poisoning of discovery: application layer fully reproduced; the cross-origin-browser step is the blocker. Check: two-local-origin browser test planting a room and watching discovery; owner holds a cross-origin socket on staging and watches Lobby announce metrics. If validated, an upgrade-time Origin allowlist is the decided countermeasure.
- NV-06 Unvalidated SDP/ICE on all three sinks (browser-mediated LAN probing): byte-identical hostile-SDP delivery verified on every path. Blockers: browser ICE/mDNS behavior and oracle fidelity. Check: two-tab webrtc-internals observation; owner verifies the supported-browser matrix. If validated, decide a candidate-address policy at the signaling sinks.

## Testing Decisions

A good test drives external behavior at a module seam — public API in, wire-visible output out (frames emitted, roster payloads, HTTP/WS responses, list states) — and never inspects private state or implementation details. Adversarial stories are expressed as tests that must now fail to harm (the attack input is accepted, then rejected/bounded after the fix). Fix-safety controls (honest transfer completes, provable-LAN discovery unchanged, reconnect reclaim works, real share codes still unpack) are first-class tests, not afterthoughts.

Seams — existing, in preference order (highest first). All were exercised during the audit and are proven driveable:

1. The end-to-end browser suite (two headless peers) — used only for the SEC-01 regression (no-key secure-context joiner receives nothing; consent-gate flow for the stripped-crypto case) since it is the only seam where the full handshake runs.
2. RoomClient driven through its public API with a stubbed transport and stubbed WebRTC objects (frames fed via the data-channel entry point; captured outbound frames asserted byte- and type-exactly) — SEC-01, 02, 03, 04, 05 (client half), 06. This is the workhorse seam; the audit's harnesses are the prior art for the stubbing pattern.
3. The Durable Object classes (Room, Lobby) driven directly with real Request objects and a mock hibernation state — SEC-05 (server half), 07, 08, 10 (identity validation), plus the worker route behaviors.
4. Pure modules: the LAN predicate (SEC-07's predicate, SEC-10's IP validator) and the share-code pack/unpack boundary (SEC-09) — matching the existing unit suites' style.

One new seam is proposed, at the highest useful point: a pure filename-sanitizer helper (basename flattening, extension handling) extracted from the zip/download naming logic, so NV-01's preventive option — if adopted — is testable without a browser. No other new seams.

| Spec ID  | Invariant (abbreviated)                                                                               | Seam                    | Test style                                                                                                          |
| -------- | ----------------------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------- |
| SEC-01   | Payload frames withheld to unproven/unconsented peers in keyed rooms                                  | e2e + RoomClient        | e2e regression; frame-type assertions (sealed vs withheld vs consented plaintext); wrong-key warning path unchanged |
| SEC-02   | received ≤ claimed ≤ ceiling; abort on first excess byte                                              | RoomClient              | file-start size=1 + chunks → error + file-cancel back; honest transfer completes byte-exact; claim clamps           |
| SEC-03   | chat text truncated; rolling cap on retained chats                                                    | RoomClient              | large/multi frames accepted-but-bounded; Clear + refill; keyed-room plaintext frames bounded                        |
| SEC-04   | concurrent inbound cap + backpressure; supersede settles; stale-active timeout; Clear bounds the list | RoomClient              | file-start floods; complete-cycle Blob/URL release; watchdog via fake timers                                        |
| SEC-05   | client peer cap + connecting timeout; server room/per-address caps                                    | RoomClient + DO         | roster N>cap → capped allocations, inert extras; join beyond caps → 429, probe joins exempt                         |
| SEC-06   | candidate queue capped pre-description; post-description path unchanged                               | RoomClient              | candidate flood bounded at cap; one description drains exactly the queued set                                       |
| SEC-07   | roster content only for provable relations; room id always for matches                                | Lobby/predicate         | CGNAT exact match → names withheld; private /24 and /64 → full response; predicate unit table                       |
| SEC-08   | eviction only with the ownership token; reconnect reclaims                                            | DO                      | token-less same-id join refused, incumbent open; token join replaces; probe join never evicts                       |
| SEC-09   | input cap before decode; counting inflate abort; sdp cap                                              | share-code module       | bomb fixtures rejected at each stage with distinct errors; real codes still unpack                                  |
| SEC-10   | only valid IPs become identity; dev/preview default localhost                                         | DO + predicate + config | headerless/'local'/arbitrary values never match externally; valid-IP paths unchanged; config default assertion      |
| NV-01…06 | owner-observed checks recorded                                                                        | per lead                | scripted two-origin/two-tab procedures from the audit's validation plans; results recorded as evidence notes        |

## Out of Scope

- Production/deployment verification itself (the NV checks are owner tasks; this spec only records them).
- Any code change for a needs-validation lead before its observation is recorded — including the Origin allowlist, candidate-address policy, and zip filename flattening (each has a decided countermeasure waiting on evidence).
- Non-security hardening from the audit's notes: key-derivation stretching and per-direction subkeys, room-code modulo bias, CONTROL_ENC parse guards, CSP/frame-headers, service-worker cache-key refinements, dev-script `/tmp` hygiene, advisory-scan CI, and vendored-wasm provenance recording — tracked separately; none is required to close a SEC item.
- TURN relay (absent by design) and any change to the P2P data-path architecture.

## Further Notes

- Traceability: each SEC/NV id corresponds one-to-one to a record in the audit's findings file (fingerprints embed the module and root cause); the full traces, evidence artifacts, and byte-level reproductions live under the audit run directory referenced at the top. Severity and impact calibration are inherited from the audit; this spec does not re-score.
- Suggested implementation order: SEC-01 first (the only confidentiality break), then the receiver-boundary pair SEC-02+03+04 (same file, same review context), then SEC-05/06, then the server trio SEC-07/08/10, then SEC-09.
- The five fix-safety behaviors (honest transfer, provable-LAN discovery, reconnect reclaim, real share codes, wrong-key warnings) must keep their existing tests green — regressions there block closure of the corresponding SEC item.
- This repository has no issue tracker configured; the spec intentionally lives as this single file per the owner's decision. If a tracker is set up later (see the engineering-skills setup command), publish each SEC/NV id there with the ready-for-agent label and treat this file as the canonical source.
