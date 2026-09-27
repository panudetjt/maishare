# 12: Upgrade-time Origin allowlist (NV-05 countermeasure)

**What to build:** Close the cross-origin WebSocket poisoning lead the staging
run validated (NV-05, `nv-observations.md`). Today the worker upgrades ANY
WebSocket on `/ws` with no look at the `Origin` header, so a page on any
website (or any script at all) can hold member sockets, receive rosters, and —
worst — plant rooms into the discovery Lobby that innocent visitors on the
attacker's network will see. Gate the upgrade in the worker route BEFORE the
DO is reached: compute the request's own origin (`url.origin` of the deployed
worker) plus an explicit allowlist (env var `ALLOWED_ORIGINS`, comma-separated,
for custom domains; `http://localhost:*` and `https://localhost:*` always
allowed for dev). An upgrade whose `Origin` header is missing or not on the
list gets `403` before any socket is accepted — no join, no welcome, no
announce, no roster read. Everything the app itself does (room join, discovery
prober, share previews) is a same-origin browser fetch and must keep working
unchanged; `curl`-style headerless clients are denied with the same 403.

**Blocked by:** None.

**Status:** done (see fix commit)

- [ ] Upgrade with a foreign `Origin` (e.g. `https://evil.example`) is refused
      `403` before the DO: no WebSocket, no announce, discovery unchanged for
      other visitors (DO-level test with real Requests + a worker-route test)
- [ ] Upgrade with no `Origin` header (non-browser client) is refused `403`
- [ ] Same-origin upgrades still work end-to-end: join, welcome, roster
      broadcast, announce to Lobby (harness tests + full e2e suite green)
- [ ] `ALLOWED_ORIGINS` env entries are honored (custom-domain deploy path);
      localhost origins allowed by default for dev/e2e
- [ ] Probe joins (discovery verification) still work — they are same-origin
      app fetches
- [ ] Fix-safety: full e2e suite passes against a local deploy
- [ ] Acceptance criteria traceable to SECURITY-SPEC.md NV-05 (evidence:
      `.scratch/security-remediation/nv-observations.md` — validated
      2026-09-27, planted room appeared in `/api/discover`)
