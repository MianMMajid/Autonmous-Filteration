# Review round 6 — rules 2026-10-08.10

Follow-up to the complete findings numbered 3–6 in the supplied review of
`78ef7d8`. Its opening fragment does not contain the preceding findings, so
this report makes no claim to have addressed those missing details.

## Fixes and qualifications

| Finding | Result |
|---|---|
| Common address aliases stopped matching | Restored Town Center/Ctr before a suffix, numbered Highway/Hwy and Route/Rte prefixes, and suffixless leading/trailing directionals. Regression tests also preserve North Street versus N Street and distinct building numbers. |
| Venue building text leaks into the street key | Drop venue segments before collecting buildings. A standalone `Building 3,` prefix still identifies a building; `Acme Building 3,` is dropped as venue text. Street-side building designators remain significant. |
| Singleton exception counts incompatible siblings | Count potential owners of the selected permit. Incompatible types, contradictory dates and known lifecycle conflicts do not disqualify a singleton; an unknown sibling status is still a possible owner. |
| Summary names the wrong overrides file | Summary receives the actual configured path and lists handoff, override snapshot and integrity manifest alongside the other outputs. Tested with a temporary custom path. |
| Unknown canonical banner creates a false contradiction | An unmapped code supplies no banner evidence on either side. Known contradictory codes, structured banner/state conflicts and exclusions still block acceptance. |
| Former-store full ID is only tier 2 | The verified former/current aliases share indexed exact-ID lookup and exact evidence. Collisions with another building still block unsafe acceptance. |
| Partial output and backup growth | Confirmed operational limitation, not silently declared fixed: normal retention excludes these. The deployment guide now specifies incident-evidence handling, backup-service expiration, protected recovery points and independent capacity monitoring. No automatic history deletion was introduced. |

## Actual replay impact

Offline replay of archive `2026-10-08T20-01-47-980Z` now produces **324 matched,
26 review, 50 no-match**. The only status/target change from the published .9 run
is **3229.1005 → prj_v6stdf**. Its siblings are Expansion and Remodel; neither
can own a dedicated EV permit. Their dated umbrella permits concern other years.
The dedicated EV permit is therefore the unique compatible candidate/owner pair.

**2970.1008 remains in review.** The 2029 Coffee Tenant is compatible with an
undated Remodel umbrella that could also belong to the 2026 Remodel line. That
sibling is a genuine unresolved owner, not an incompatible one. Likewise, EV
can share a Remodel umbrella under the brief, so an EV sibling cannot categorically
be dropped when the selected permit is Remodel. Compatibility is directional.

One already accepted former-ID match becomes tier 1; its target is unchanged.
Matched tiers are 93 / 194 / 14 / 15 / 8. The address changes introduce no other
status or target changes in this snapshot. These counts do not establish accuracy.

## Verification and publication

33 new regression cases cover the reported spellings, non-equivalent streets,
venue/building scope, compatible ownership in both register orders, unknown
status, canonical codes, verified/unverified former IDs, collisions, and summary
paths/artifacts. **479 tests across 30 files pass**, along with lint and typecheck.
The existing synthetic false-positive and publication-boundary tests also pass.

This audit does not fetch upstream data, apply customer overrides, publish a new
run, delete historical state or activate a scheduler. The verified latest output
remains the .9 publication at `2026-10-08T20-01-47-980Z` (323/27/50). The submission
and prior record review are explicitly scoped to that older snapshot. A new .10
publication must use its own mapping and generated handoff; the previous sample
estimate is not independent validation of this newly accepted row.

## Storage work still requiring deployment ownership

The CLI has no default backup expiration and does not infer that an old partial
run is abandoned. This preserves incident evidence and avoids deleting the last
usable backup. It also means storage remains unbounded without an active host
policy. Before scheduling, the operator must configure and test backup retention,
free-space alerts and the procedure for archived incident evidence. The guide
provides the procedure, but actual host configuration has not been demonstrated.
