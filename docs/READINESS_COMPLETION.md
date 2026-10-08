# Readiness completion — October 8, 2026

The implementation now covers the brief's EV umbrella case, symmetric source
contradictions, reviewer guidance, conflicting human decisions and a consistent
submission handoff. This addresses the concrete findings against commit
`316bced`; it does not certify every future match or a deployed service.

## Delivered changes

- EV can share a Remodel, Expansion or New Build permit with store/year evidence.
  A compatible dedicated EV alternative or missing year prevents an automatic
  umbrella fold. Reviewed scope decisions remain possible within hard boundaries.
- Acme cancellation, signage, canonical banner/state and building contradictions
  are checked through matching, overrides and the publication invariant. Explicit
  Sign Permit / Pylon Sign vocabulary is recognized without matching Design.
- CSV advice distinguishes soft street/date discrepancies from hard identity,
  scope, explicit-year and lifecycle constraints. Conflicting duplicate overrides
  refuse publication regardless of row order; identical duplicates deduplicate.
  Impossible audit dates are rejected.
- New raw archives use owner-only directories/files and flushed writes. Existing
  partial output directories survive collisions. Existing filesystem permissions
  are unchanged and need checking on the deployment host.
- Every new publication includes a hashed `handoff.md` with its own counts,
  provenance, usage and unsent Account Lead draft. Historical v3 runs stay readable.

## Evidence

Preflight, lint, typecheck and **446 tests across 29 files** passed. Coverage
thresholds passed: 94.77% lines and 87.51% branches. These metrics demonstrate
exercised paths, not accuracy. New tests cover EV positives/negatives, hard-rule
bypass attempts, signage false positives, duplicate-order invariance, filesystem
collisions and the reviewer lifecycle.

Fresh live publication: `2026-10-08T20-01-47-980Z`, acquired at
`2026-10-08T20:01:49.356Z`, rules `2026-10-08.9`, implementation SHA-256
`0516d7d93621d883e524b5018c4fb4937f95b345f87f19ab1201972d73620690`.
It contains **323 matched, 27 review, 50 no-match**, with no applied overrides.
Compared with rules .8, EV row 1679.1001 is now held: a newly compatible umbrella
candidate means its undated dedicated permit is no longer a unique candidate.
This preserves precision instead of optimizing the number of accepted rows.

The fresh normalized records equal the earlier audited snapshot. Fresh retrieval
is demonstrated; changed business inputs are demonstrated separately in the
synthetic integration test. That test reviews ambiguous row 3716.1005, confirms
its chosen permit on a subsequent run, checks byte-identical repeat results,
then changes the permit to Canceled and verifies the override is not retained.
It uses temporary test decisions, never invented customer approvals.

A local isolated drill on the fresh publication demonstrated:

1. Verified backup including exact implementation, source inputs and overrides.
2. Restore into a new directory; replay with byte-identical mapping and no new
   review cases, while retaining all 27 unresolved rows.
3. Original source-acquisition timestamp preserved through replay.
4. Healthy publication detection, then missed publication/source deadlines under
   an advanced test clock.
5. Rejection of a deliberately corrupted scratch mapping; original publication
   remained verified and its pointer unchanged.

Drill evidence is local and ignored at `data/audits/completion/drill-results.json`.
The backup is on the same machine; this is not an off-host disaster recovery or
real alert-delivery test. No schedule or external messaging was activated.

The [50-case record review](validation/2026-10-08-record-review.md) supplies a
qualified estimate for the brief, with four unresolved cases identified by ID.
Its reviewer was the implementing assistant, not an independent operator.

## Onboarding work that cannot be replaced by more code

| Work | Why it matters | Completion evidence |
|---|---|---|
| Check the two sampled umbrella matches and two no-matches | Supplied records admit competing interpretations | Permit evidence and named reviewer decision for 6544.1003, 6287.1005, 3960.1002, 5746.1004 |
| Resolve the 27-row initial queue | Starting backlog exceeds “a few” | Corrected sources or explained validated overrides; no forced matches |
| Validate automatic matches independently | Tests and record consistency do not establish precision | Labeled independent sample/holdout; reported false positives, denominators and abstentions |
| Run on a trusted persistent host | A laptop fetch does not demonstrate recurring service | Scheduled fresh runs with observed results, operator and backup owner |
| Prove independent alerts and off-host restore | Local monitor logic cannot establish delivery or host-loss recovery | Missed-run notification received by operators; restored verified snapshot on another host/volume |
| Measure new weekly review effort | An identical replay says nothing about changing business data | Review counts and operator time across genuinely updated snapshots |

The 27 cases comprise seven evidence conflicts (five soft/date, two hard owner),
six insufficient-evidence cases, four ambiguous choices, four status conflicts,
three type mismatches, two outside-scope identities and one weak-locality case.
`review.csv` is the full backlog; `review-changes.csv` is only the immediately
preceding run's delta. Do not discard old unresolved cases because a delta is empty.

## Assessment

The brief implementation and handoff are now approximately **9/10 as a take-home
solution**, an engineering judgment about requirements coverage and demonstrated
behavior. That number is not 90% accuracy. Production engineering is substantially
hardened, but **9/10 live production readiness is not yet demonstrated**: independent
matching validation, real scheduling/alert delivery, off-host recovery and observed
review workload remain open. The original PDF does not supply host or operator
choices, so these must be completed in the deployment environment rather than
invented or marked done from local tests.
