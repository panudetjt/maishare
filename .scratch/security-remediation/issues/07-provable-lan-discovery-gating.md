# 07: Provable-LAN predicate gates discovery disclosure (SEC-07)

**What to build:** Stop LAN discovery from handing out room rosters on a bare public-IP match. A pure predicate distinguishes topology-provable relations (private /24, v4-mapped equality, IPv6 /64, and the loopback dev marker) from bare public-IP equality, which proves nothing behind CGNAT. Discovery uses the predicate to gate the disclosure itself: provable matches keep the full response; non-provable matches return the room id only — which the client's host-only probe needs to verify — with member names, counts, and creation time withheld. Roster content remains available to actual joiners via the existing welcome message after signaling access.

**Blocked by:** None (can start immediately).

**Status:** done (commit series: SEC-06, SEC-01, SEC-02, SEC-03, SEC-04, SEC-05, SEC-07, SEC-08, SEC-09, SEC-10 — see git log)

- [ ] Predicate unit table: private /24 same-subnet → provable; v4-mapped equality → provable; IPv6 same /64 → provable; loopback dev marker equality → provable; distinct public IPv4 equal only exactly → NOT provable; everything else unchanged from the existing matcher
- [ ] Discovery: a caller matching a room only via a non-provable relation receives the room id with roster content withheld (empty names/counts), while a provable match receives the full response including names
- [ ] Client discovery flow still works: id-only candidates still pass the host-only probe and join normally; names arrive with the welcome message on join
- [ ] Fix-safety: genuine same-network discovery (private /24, /64) shows names and counts exactly as before
- [ ] The predicate is pure and unit-tested in the existing server suite style
- [ ] Acceptance criteria traceable to SECURITY-SPEC.md item SEC-07
