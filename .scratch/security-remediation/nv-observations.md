# NV-01…06 owner observations — evidence log

Ticket 11 (needs-validation leads from SECURITY-SPEC.md). This file is the
single place to record each observation. **No code change is in scope for any
lead until its observation exists**; the countermeasure named per lead becomes
a follow-up ticket only if the evidence warrants it.

Automated evidence gathering ran on 2026-09-27 against the isolated staging
worker `maishare-nv-staging` (its own DO namespace/storage — production
`maishare` untouched) plus local tests. Scripts live in `scripts/nv/`;
`node scripts/nv/cleanup-staging.mjs` deletes the staging worker together with
every test room / Lobby entry / DO storage row it created (run before launch).

## NV-01 — zip-slip (gallery/attachment zip entry names)

- [x] Check done: the app's exact archive path reproduced (fflate `zipSync`,
      sender-controlled entry names — `scripts/nv/nv01-zipslip.mjs`).
- Result: **partially validated — extraction risk depends on the victim's
  extractor; fleet survey still pending (owner)**
- Date: 2026-09-27 · Deciding facts:
  - The archive **stores traversal names verbatim** (`../../nv01-escape.txt`,
    `sub/../../../nv01-deep.txt`, `/abs-nv01.txt`) — the attack surface is real.
  - `unzip` (Info-ZIP) **refused the archive** outright; Python `zipfile`
    extracted with sanitization — **no escape** from either.
  - Not yet tested: Windows Explorer, macOS Archive Utility, 7-Zip and other
    GUI extractors — the actual recipient landscape (owner survey).
- Evidence: script output; rerun with `node scripts/nv/nv01-zipslip.mjs`
  (local, no deploy needed). To test extractors this machine doesn't have:
  `node scripts/nv/nv01-zipslip.mjs nv01-probe.zip` writes the probe archive —
  copy it to the Windows/macOS box, extract into an EMPTY folder with the
  target tool (right-click → Extract All on Windows), then check that folder's
  PARENT for `nv01-escape.txt` / `nv01-deep.txt`. Any file landing outside the
  extraction folder = that extractor is vulnerable (validated).
- Countermeasure if warranted: pure filename-flattening helper at the
  zip/download seam (basename + extension handling), testable without a
  browser. Cheap and removes the dependence on victim behavior — recommend
  adopting even without a validated escape.

## NV-02 — Lobby scan cardinality

- [x] Staged smoke done: 200 rooms × 1 real signaling join each, live
      `/api/discover` timings (`scripts/nv/nv02-lobby-load.mjs`).
- Result: **not validated at smoke scale — scan cost not measurable; CPU watch
  at scale still pending (owner)**
- Date: 2026-09-27 · Deciding facts: discover p50 **46 ms / p95 59 ms** with
  200 pairs live vs p50 42–54 ms empty lobby — no measurable per-room scan
  cost client-side; per-join handshake ≈ 0.7 s, 200 joins ≈ 20 s (CONC=8).
- Evidence: script output; scaled rerun: `ROOMS=500 CONC=16 node
scripts/nv/nv02-lobby-load.mjs`. The audit's ~225k-pair linearity harness is
  this script scaled; multi-IP population needs a distributed runner.
- Owner step: watch Lobby DO CPU per discover + announce queueing in the
  dashboard while a scaled population is live. Countermeasure (aggregate caps)
  only if CPU/p99 breaches budget.

## NV-03 — room key in request lines

- [x] Local half done: navigated `/r/<room>?k=<canary>` twice against a local
      workerd (`scripts/nv/nv03-query-log.mjs`), grepped the captured log.
- Result: **local request logs do NOT capture the query-string key; Workers
  Observability now ENABLED on staging — dashboard search pending (owner)**
- Date: 2026-09-27 · Deciding facts: wrangler's request log line renders as
  `GET /healthz 200 OK` — path only, no query — and no log line contained the
  canary key, while the navigations themselves returned 200. Staging
  `maishare-nv-staging` was redeployed with `observability.enabled = true` and
  the canary navigation `/r/nv03canary?k=nvcannotkeepthiskey42` was sent.
- Evidence: script output; rerun locally: `node scripts/nv/nv03-query-log.mjs`.
- Owner step (2 minutes): dashboard → maishare-nv-staging → Workers
  Observability → Events, search **`nvcannotkeepthiskey42`**. If any event's
  request URL carries `?k=…` → a persistent logging layer captures keys →
  escalate to the fragment-key (`#k=`) design; otherwise fragment-key stays
  optional defense-in-depth. (The telemetry query API rejected wrangler's
  OAuth token — auth error 10000 — so the Events search is the owner step.)
  Also review any Logpush / analytics export / fronting proxy on the real zone.

## NV-04 — Room DO persistence

- [x] Staged flood done: 100 rooms joined once, sockets dropped immediately,
      75 s token-grace observed (`scripts/nv/nv04-do-rows.mjs`).
- Result: **persistence confirmed live (matches the audit); decision pending
  (owner): per-address creation cap vs TTL cleanup alarm**
- Date: 2026-09-27 · Deciding facts: 100 DO instances created in ~80 s from one
  address with bare join-and-drop requests; after the 75 s grace the ownership
  token row was wiped by the cleanup alarm and a **fresh claim succeeded**
  (SEC-08 verified live), but the room's DO instance itself persists —
  unbounded row growth under repeated floods remains available to any client.
- Evidence: script output; rerun with `ROOMS=500 node scripts/nv/nv04-do-rows.mjs`.
- Dashboard readout (owner, 2026-09-27): staging Durable Objects —
  **Lobby namespace: Storage used 0 B** (in-memory by design, nothing to
  clean), **Room namespace: Storage used 27.61 MB** across the test rooms
  (~350 rooms from the floods ⇒ roughly 80 KB of SQLite overhead per bare
  join-and-drop room, each holding at most a `roomId` row plus a wiped token
  row). That is the audit's unbounded-growth concern quantified: every flood
  join mints ~80 KB of permanent storage for any client, one IP at a time.
  (The 2k "errors" on Room instances are the flood script's abrupt socket
  drops — expected, not a worker defect.)
- Decision → follow-up ticket: per-address creation cap vs TTL cleanup alarm;
  the 27.61 MB figure is the baseline to argue from.
- Cleanup when done inspecting: `node scripts/nv/cleanup-staging.mjs` deletes
  the worker and all 27.61 MB with it.

## NV-05 — cross-origin WS poisoning of discovery

- [x] Check done: foreign socket (no same-origin guarantee — Node WS sends no
      Origin; strictly stronger than a browser cross-origin socket) joined a
      staging room and the lobby/discovery output was inspected
      (`scripts/nv/nv05-cross-origin.mjs`).
- Result: **validated (app layer)** — the planted room appeared in
  `/api/discover`
- Date: 2026-09-27 · Deciding facts: the socket joined and received a welcome
  with **no origin check anywhere**; the roster change announced to the Lobby
  and discovery listed the planted room — `{"roomId":"nvx05-…"}` (id-only,
  SEC-07 gating visibly working: the caller's public-IP exact match is not
  provable, so no names/counts leaked).
- Evidence: script output; rerun against staging:
  `node scripts/nv/nv05-cross-origin.mjs`.
- Countermeasure (warranted): **upgrade-time Origin allowlist** → written up
  as ticket `issues/12-origin-allowlist.md` (status ready-for-agent). Owner
  confirmation with a true cross-origin _browser_ page folds into that
  ticket's acceptance test.

## NV-06 — SDP/ICE LAN probing

- [x] Check done: real headless Chrome joined a room through the app; a
      signaling attacker delivered a crafted offer whose only host candidate
      was `127.0.0.1:55921` where a UDP listener waited
      (`scripts/nv/nv06-ice-probe.mjs`).
- Result: **validated** — the browser dialed the attacker-supplied internal
  candidate
- Date: 2026-09-27 · Deciding facts: the victim's ICE agent sent **4 UDP
  packets** to the listener within seconds of applying the unvalidated remote
  SDP; nothing validates candidate addresses at the signaling sinks today.
- Evidence: script output; rerun locally (needs `vp build` +
  `/usr/bin/google-chrome`): `node scripts/nv/nv06-ice-probe.mjs`.
- Owner step: repeat on the fleet's browsers (mDNS obfuscation on/off,
  remote-candidate dialing, enterprise policy). Countermeasure (warranted):
  **candidate-address policy at the signaling sinks** → written up as ticket
  `issues/13-candidate-address-policy.md` (status ready-for-agent).
