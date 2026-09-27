# 14: Fragment-key — move the room key out of the query string (NV-03 countermeasure)

**What to build:** Stop putting the room key where every server-side logging
layer can see it. NV-03 validated (staging invocation-log record, 2026-09-27)
that Workers Observability stores the full request URL AND the parsed query
(`event.search`) — so every invite navigation `/r/<room>?k=<key>` writes the
room key into account-readable logs for the whole retention window. The fix:
serve the key from the URL **fragment** — `/r/<room>#k=<key>` — which browsers
never transmit to the server. Concretely: when generating invite URLs (room
creation, copy-invite, QR, recents) place the key in the fragment; the room
route reads the key from `location.hash` on load (client-side only), keeps the
existing in-page key handling (recents, re-share) working from the fragment,
and the `k` search param is dropped from the route schema. A legacy
`?k=` link should still work (read it, then replace the URL state with the
fragment form and drop the query) so old shared links don't break overnight.
The worker's share-preview rewrite needs no change (room name only, key never
in markup). Server-side rate limiting / origin gate / proof exchange are
unaffected — the key never travels in the request line again.

**Blocked by:** None.

**Status:** ready-for-agent

- [ ] Invite generation puts the key in the fragment everywhere it is produced
      (create-room navigate, copyInvite, QrInvite URL, share-preview URL)
- [ ] Room route reads `k` from `location.hash` client-side; `?k=` search
      schema entry removed; a `?k=` legacy link is consumed and rewritten to
      the fragment form (URL state replaced, key no longer in the query)
- [ ] Recents keep working across the migration (save from fragment, open via
      fragment link)
- [ ] e2e: invite flow (create → copy → second peer joins via fragment link →
      key-proven sealed chat) green; the invite URL as seen by the server
      contains no `k` parameter (worker/DO test asserts `search.k` absent)
- [ ] Observability check: navigating an invite on staging produces NO log
      record containing the key (the NV-03 canary procedure re-run, expected
      clean)
- [ ] Acceptance criteria traceable to SECURITY-SPEC.md NV-03 (evidence:
      `.scratch/security-remediation/nv-observations.md` — validated
      2026-09-27 via a real invocation-log record)
