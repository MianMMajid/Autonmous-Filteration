# Dedicated signage validation — rules 2026-10-08.12

The PDF says signage uses separate projects. The previous implementation excluded
all Pulley signage, including a valid dedicated Acme Signage / Pulley Signage pair.
This change makes signage eligibility pair-specific rather than globally excluded.

## Behavior

- Structured Signage rows can match each other through the existing evidence tiers.
  Type comparison ignores case and surrounding whitespace; unknown type aliases
  are not guessed.
- Signage and general work cannot share a permit, in either direction. Pathfinder
  remains excluded even when its structured type is Signage.
- The scope rule is shared by candidate indexes, reverse ownership checks,
  overrides and publication invariants. All identity, state, banner, lifecycle,
  temporal and shared-building/year constraints still apply.
- Explicit name/type contradictions remain holds. Mixed remodel/sign scope and
  other soft discrepancies require human confirmation with an explanatory note.
- Unclaimed non-Pathfinder signage is visible in `pulley-unmatched.csv`. Its presence
  alone does not add Acme rows to the review backlog. Summary counts no longer
  double-subtract records that are both Pathfinder and signage.

## Verification

`pnpm verify` passed: preflight, lint, typecheck, and **575 tests in 32 files**.
The 47 new cases in `tests/signage.test.ts` cover:

- Exact IDs, store/year, jurisdiction differences with exact streets, verified
  former store numbers, yearless singleton stores and normalized type spelling.
- Separate remodel/signage permits at the same building/year, and a general permit
  sharing the full ID without defeating the eligible signage permit.
- Duplicate targets in either order, explained overrides, and consistent unclaimed
  signage reporting after overrides.
- Sequence and date fallbacks with unique ownership, competing signage owners,
  unrelated general-work siblings, and reused sequences without locality evidence.
- Pathfinder, wrong banner/state/building/year, contradictory source markers,
  unknown or incompatible lifecycles, missing site identity, disputed source rows,
  and both directions of signage/general-work exclusion.
- Forced invalid override/publication attempts, cross-year and cross-building
  sharing, and selection of a valid live permit over a canceled duplicate.
- Missing temporal evidence, street/milestone conflicts, and mixed sign/remodel
  descriptions, including the explanatory-note requirement for soft conflicts.
- A synthetic XLS Project Register, XLSX Site Directory, CSV Key Dates and API
  response passing through the full acquisition/publication pipeline; exact CSV
  contract; byte-identical replay; and a saved override invalidated by an upstream
  change to a general permit. The match-count collapse blocks normal publication
  and preserves the pointer. Explicit acceptance of that input change still cannot
  restore the invalid override.

## Archived-data replay

Isolated run `2026-10-08T20-53-27-807Z` replayed source archive
`2026-10-08T20-23-30-750Z` with rules .12. All 400 mapping rows are byte-identical
to the baseline: **324 matched, 26 needs_review, 50 no_match**. A second replay
was also byte-identical, with zero new/changed review rows and original source
freshness preserved. The main published pointer was checked unchanged.

The audit checked the exact CSV header and statuses, one row per Acme ID,
separate banners/states, cancellation agreement, and one building/year per shared
permit. No violations were found. The snapshot has zero Acme signage rows and
15 Pulley signage projects; dedicated signage matching is demonstrated by the
synthetic cases, not by actual signage pairs in this snapshot.

Reproduction and machine-readable results are in the ignored local directory
`data/audits/signage-20261008-135327/`. Automated regression tests live in the
tracked test suite. These results close the confirmed functional gap; they do
not establish independent accuracy, eliminate the existing review backlog, or
prove every possible future input is covered. No live scheduler was enabled.
