# Validation

Current rules are **2026-10-08.10**. See [the latest review fixes](REVIEW_ROUND_6.md)
and [the prior readiness evidence](READINESS_COMPLETION.md)
and [the 50-case source-record review](validation/2026-10-08-record-review.md).
Sections below retain historical tuning observations; they are not independent
accuracy measurements for the current implementation.

Hand check of the matcher's output on the 2026-10-08 dataset, the rule
changes it produced, and the match-rate estimate for the submission.

## Method

A stratified sample was pulled with both sides' full records (name, type,
program year, status, site street and city, Key Dates versus Pulley dates):

| Stratum | Rows checked |
|---|---|
| Tier 1, exact id | 10 (every 10th) |
| Tier 2, store | 12 (every 19th) |
| Tier 3, sequence plus locality | all 15 |
| Tier 4, exact address | all 11 |
| needs_review | all 17 |
| no_match | 12 (every 3rd) |

Plus an automatic sweep over every matched row flagging any with two or more
soft concerns (city differs, year or date differs, type not equal, sequence
differs). The sweep flagged 26 rows, each read by hand.

## Findings before tuning

Tiers 1, 3, and 4 were clean: every sampled row was right, including the
live-over-canceled choice at 2191.1005, the renumbered store at 5137.1005,
and the house-number typo at 1474.1001.

Tier 2 had three real problems, all visible in the flagged rows:

1. **Cross-year folds.** Store 5616 has one Pulley Remodel whose dates equal
   Acme 5616.1003's Key Dates exactly. The matcher also attached 5616.1004
   (program year 2029) to it. Same pattern at stores 3994, 1180, 2009, 6903.
   The brief folds several Acme lines into one permit only for the same
   store *and the same year*.
2. **Former-number collisions.** Store number 4980 is Lowell's current number
   and Worcester's former number. Acme 4980.1001 (Lowell) was matched to
   "Acme | 4980, WORCESTER, MA".
3. **Explicitly other lines.** A candidate with a different sequence *and*
   another year is a different permit, not a review item.

The decisive measurement: among exact-id matches that have dates on both
sides, 57 of 71 have a Pulley milestone within 7 days of the Acme Key Date,
6 more within 30 days. Pulley dates are the Acme dates with small jitter, so
date proximity is the strongest signal after the id itself.

## Rule changes made

- Temporal verdict per candidate (`same`, `near`, `unknown`, `conflict`)
  from the year written in the name, the date year, and the smallest gap
  between corresponding milestones. Tiers 2 to 6 drop `conflict` candidates.
- Dates within 7 days score +45, above type equality, so exact dates break
  same-store ties.
- A store number that identifies two buildings needs city or street
  agreement before it counts.
- When every store-identified candidate belongs to another year, the result
  is `no_match` with reason `UNRELATED_ONLY` and the candidates listed,
  rather than a weak locality guess.
- New tier 5: a store-less name with dates within a week in the same city,
  guarded by the same register-wide uniqueness check as tier 3.

## Results after tuning

| Outcome | Before | After |
|---|---|---|
| matched | 349 | 336 (tier 1: 97, tier 2: 201, tier 3: 16, tier 4: 14, tier 5: 8) |
| needs_review | 17 | 12 |
| no_match | 34 | 52 (23 no candidate, 24 other year or other line, 5 pathfinder only) |
| tier-2 matches with dates more than 90 days apart | 22 | 3 |

The 13 rows that left `matched` were the cross-year and cross-building
cases above. Each is now `no_match` with the former candidate named in
`decisions.csv`, so a reviewer who disagrees can see what was rejected.

The 12 review rows are real questions: 4 pairs of duplicate Pulley projects
for the same store and type with no dates on either (3716, 6912, 5272,
1480), 4 canceled-on-one-side conflicts the brief says to surface, 3 type
mismatches where the only project at the store is a different kind of
work, and 1 weak locality candidate.

## Historical precision audit — rules 2026-10-08.6

The earlier sections are historical tuning notes, not a current accuracy
assessment. The replay at that revision produced 309 matched, 41 needs_review, and
50 no_match out of 400. Automatic coverage is 77.25%; accuracy is not yet
independently measured.

The precision audit found six adversarial unsafe acceptances and 23 accepted
rows requiring verification (five temporal discrepancies and eighteen without
an exact full-ID match or usable temporal evidence). All 23 now go to review.
The six counterexamples and additional marker, ownership, override, publication,
and order-invariance cases are covered by `tests/audit-precision.test.ts`.

Earlier 96% precision, 81% correct-match, and 94% right-outcome estimates are
withdrawn as release claims: they were not derived from independently
adjudicated labels. Missing a counterexample does not certify correctness.

Before claiming measured accuracy, adjudicate the accepted rows and unresolved
cases against independent permit evidence, keep labels separate from overrides,
and evaluate a holdout snapshot/store set. Use `pnpm cli evaluate` as described
in `docs/adjudication/README.md`. Report false positives, denominators, label
coverage, abstentions, and manual overrides separately. Even zero observed
false positives on a fully reviewed snapshot does not guarantee future data.

## Historical live end-to-end verification — rules 2026-10-08.6

A fresh live sync at 2026-10-08T19:21:16.612Z produced 309 matches,
41 review rows, and 50 no-matches. Its publication ID is
`2026-10-08T19-21-15-120Z`. An isolated replay of that archive produced identical
mapping bytes and zero new/changed review rows while retaining all 41 unresolved
rows in the full backlog. The live pointer remained unchanged during the drill.

Preflight, lint, typecheck, and 358 tests across 26 files passed. These checks
validate the implementation and repeat-run workflow, not independently adjudicated
matching accuracy or a deployed scheduler.

## Synthetic audit — rules 2026-10-08.7

Seven additional counterexamples were reproduced and fixed. A deterministic
matrix exercises 1,152 invalid cases and 96 valid controls in both input orders.
All 377 tests across 27 files, lint, and typecheck pass. An offline replay of the
latest live archive leaves the mapping byte-identical at 309/41/50, and the
published pointer is unchanged. See `SYNTHETIC_AUDIT.md` for the cases, limits,
and reproduction command.

## Historical replay — rules 2026-10-08.8

The review follow-up narrows the temporal hold to ambiguous ownership. An offline
replay of archive `2026-10-08T19-21-15-120Z` yields **324 matched, 26 review,
50 no-match**, or **81% automatic coverage**. Fifteen formerly withheld rows now
satisfy the single-Acme-project / unique-compatible-store-candidate exception.
All seven evidence conflicts remain withheld. Existing matched targets and
no-match decisions are unchanged. The published pointer remains on the earlier
309/41/50 live run; this audit did not publish or fetch customer data.

See `REVIEW_FOLLOWUP.md` for regression checks, performance and recovery details.
Coverage is not correctness; independent adjudication is still outstanding.
