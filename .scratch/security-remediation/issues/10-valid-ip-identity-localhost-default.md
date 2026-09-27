# 10: Valid-IP identity validation + localhost dev default (SEC-10)

**What to build:** Fail closed on untrusted network identity. Both consumption points of the forwarded connection-IP header — member identity at signaling join and caller identity at LAN discovery — validate the value as a syntactically valid IP address and otherwise contribute no identity; the headerless internal fallback can never be supplied or matched by an external request, and arbitrary strings (including the 'local' marker) can never act as a match key. Additionally, the dev/preview server binding defaults to localhost, restoring the README's contract that exposing the app to the LAN is the explicit host-flag opt-in.

**Blocked by:** None (can start immediately).

**Status:** done (see commit c532260 — SEC-10)

- [ ] Pure IP-validity helper unit-tested: valid IPv4/IPv6 pass; arbitrary strings, the 'local' marker, and garbage fail
- [ ] Join path: a forwarded header containing a non-IP value never becomes a matchable member identity (fail closed; honest headerless dev flow still works via the internal fallback)
- [ ] Discovery path: a caller identity that is not a valid IP matches nothing (external 'local'/'arbitrary string' collapse eliminated)
- [ ] Fix-safety: honest valid-IP identities (exact match, private /24, /64) behave exactly as before
- [ ] Dev/preview servers bind localhost by default; the documented host flag still exposes all interfaces when given; existing LAN e2e flows that pass the flag explicitly stay green
- [ ] Acceptance criteria traceable to SECURITY-SPEC.md item SEC-10
