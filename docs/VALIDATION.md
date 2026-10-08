# Validation

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

## What the figures mean

| Figure | What it is |
|---|---|
| 333 of 400 (83%) | Auto-match coverage: how many rows the tool accepted. A count, not correctness. |
| about 96% | The author's hand-check estimate of precision among accepted rows. Not a measured figure; see `docs/adjudication/`. |
| about 81% | Coverage times that precision estimate: the share of all rows believed correctly matched. Not recall, which would need to know how many rows have a correct match at all. |
| about 94% | The author's estimate of rows with the right outcome once justified `no_match` and `needs_review` rows count. Not reproducible from labels in this repository. |

None of these is a measurement until an adjudicated reference set exists.
`docs/adjudication/README.md` describes how to build one and what to report.

## Estimated match percentage

Of the 336 rows reported as `matched`, the sweep after tuning flags 18 with
two or more soft concerns. Reading them: 7 are jurisdiction-versus-mailing
city differences (Harris County for Houston, Jeffersontown for Louisville,
Washington Township for Dayton), which the brief predicts; 8 are same-year
folds into an umbrella permit with a different sequence, which the brief
describes; 3 are borderline (2574.1001, 2970.1008, 5967.1005) where a
Coffee Tenant or EV line sits under a Remodel with no year evidence.

Estimate, stated conservatively:

- about 96% of rows marked `matched` are correct (roughly 322 of 336);
- about 81% of all 400 Acme projects are correctly matched to a Pulley
  project;
- about 94% of all rows carry the right outcome once correct `no_match`
  and justified `needs_review` rows are counted.

The remaining uncertainty sits in tier 2 folds where Pulley has one permit
and Acme has several lines in the same year, and in the 23 `no_match` rows
with no candidate at all, which may be projects Pulley has not opened yet.

## Second pass: edge cases and performance (same day)

A follow-up review of the real data and a scaled copy found and fixed:

- Three Pulley projects claimed by Acme lines from different program years
  (stores 5967, 6409, 4413). A post-pass now demotes claims that lack strong
  evidence to `needs_review` (`YEAR_CONFLICT`). Two were demoted; store 6409
  has an exact id on one line and exact dates on the other, so both stay.
- Two exact ids found only on projects of the other banner (2898.1001,
  5287.1003), previously silent `no_match`, now `needs_review`
  (`ID_OUTSIDE_SCOPE`).
- 33 matched rows with a permitted status difference (Pulley Complete while
  Acme Active, or Acme Deferred while Pulley In Progress) are now listed in
  the summary and `decisions.csv`.
- Quiet failure modes with no instance in today's data: a project whose
  site is missing now takes its banner from the canonical name; an address
  match on a street key shared by two sites now needs the city; status
  spelling variants are accepted; old runs are pruned.
- Matching at ten times today's volume dropped from 2.1 s to 0.9 s by
  computing the register-wide uniqueness checks once per Pulley project.

Results after the second pass: 334 matched, 16 needs_review, 50 no_match.
The estimate below is unchanged; the two rows that left `matched` were the
demoted year conflicts.

## Third pass: external audit (same day)

An independent audit at commit `65696c8` reproduced fifteen defects. Each
was verified against the then-current code and fixed, with a test:

| Finding | Fix |
|---|---|
| One Pulley project claimed across program years | Assignment pass anchored by the full id in the name, then exact dates; a register-wide invariant test |
| Full ids bypassing the shared-store-number guard | Tier 1 requires locality agreement when the id's store number identifies two buildings |
| Street text treated as unique statewide | Address keys require a house number; shared street keys need city agreement |
| Saved overrides surviving later cancellation or banner changes | Overrides are re-checked against banner, state, and the status gate on every run and reported as needing reconfirmation |
| Same-second run ids overwriting history | Run ids carry milliseconds; archive and output directories are created exclusively and never deleted on publish |
| Stale-lock recovery granting several owners | Lock created by atomic `link`; stale locks claimed by `rename`, which exactly one contender wins; 20-way concurrent test |
| Replay differing from live on duplicate pages | One dedupe helper for both paths; equality test with a repeated page |
| Date tier accepting an explicit other-year name | Temporal conflict filter on tier 5 and its reverse check |
| Reverse uniqueness ignoring state | Reverse checks scoped to banner and state |
| Missing site erasing canonical identity | Banner falls back to the canonical name's code (fixed in the second pass) |
| Unknown status values treated as permission to match | Explicit lifecycle classification; unknown values go to review as `STATUS_UNKNOWN` |
| Incomplete addresses promoted to exact evidence | House number required; placeholders rejected |
| Body-read failures bypassing retries | The whole exchange, including the body, runs inside the retry loop |
| Spreadsheet formula injection in exports | `escape_formulas` on every human-facing CSV; the mapping file carries ids only |
| Whitespace bypassing the pathfinder exclusion | Categorical fields trimmed at the schema |

The scheduled workflow now publishes an artifact only on success, so a
failed run can never present the previous run's CSV under its own name.

Results after the third pass: 333 matched, 17 needs_review, 50 no_match.

## Fourth pass: production-readiness assessment (same day)

An assessment at commit `39c8016` rated the tool about 4 of 10 for
unattended use and set release gates. The engineering items were implemented:

- Acceptance separated from ranking: candidates differing only in soft
  corroboration tie and go to review (one more row on today's data).
- Order invariance: no anchor when best scores tie across sites or years;
  a test shuffles the register and the pool and asserts identical decisions.
- One scope rule shared by forward matching, reverse checks, and overrides.
- Conflicting duplicate join rows are set aside rather than chosen by
  position; identical duplicates collapse with a warning.
- Input-quality gate before publication (empty exports, collapses versus
  the previous run) with an explicit operator acceptance flag.
- Provenance in `run.json`: rules version, tool version, input hashes,
  configuration, overrides hash, matcher decisions before overrides.
- Replay of any archived run by id, with hash verification.
- `status` command with a freshness limit; the scheduled workflow runs it
  and names artifacts by run id; publication only on success.
- Review files show both sides' city, street, and dates, a plain reading of
  each candidate's evidence, and a recommended action.
- Overrides moved to a tracked `overrides.csv` with author and date;
  coverage thresholds and dependency advisories enforced in CI; the vendored
  tarball is hash-checked at preflight.

Results after the fourth pass: 332 matched, 18 needs_review, 50 no_match.

Items that need people rather than code are set up but not done: an
adjudicated reference set (`docs/adjudication/`), an owner and backup, and
agreed freshness and review-burden targets (`docs/OPERATIONS.md`).
The estimate is unchanged. The audit is right that no precision figure can
be established without adjudicated correct mappings; the figure here rests
on the hand check described above and should be read as such.

## Fifth pass: round-two audit (same day)

An independent audit at commit `0b7e1e5` (`docs/BUG_AUDIT_ROUND_2.md`)
reproduced ten defects. Each is fixed with a regression test in
`tests/audit-round-2.test.ts`, which replaces the audit's probe script (the
probes asserted the defects; the tests assert the required behavior).

| Finding | Fix |
|---|---|
| R2-01 conflicting strong anchors | Anchors of equal strength must agree on one site and year; otherwise every claim goes to review |
| R2-02 stale recovery displacing a live owner | Removal of a dead owner's lock happens only under a reclaim mutex, after re-checking liveness while holding it; deterministic interleaving test |
| R2-03 freshness step needing credentials | `status` loads only local settings; clean-environment CLI test |
| R2-04 quarantine making matching less conservative | Disputed identity travels with the project and blocks auto-matching (`IDENTITY_DISPUTED`) |
| R2-05 overrides bypassing assignment and temporal rules | Temporal conflict rejects an override; after all overrides, cross-site or cross-year sharing withdraws the overrides involved; a final invariant check guards publication (exit 10) |
| R2-06 register duplicates order-dependent | Conflicting register rows mark the id disputed, so the decision is review in any order |
| R2-07 acceptance from the wrong reference | The tie set is computed from the maximum decisive score |
| R2-08 unknown organizations comparing equal | Scope requires a known, equal banner and a known, equal state |
| R2-09 retention deleting a replay's archive | Pruning protects every archive a retained output references |
| R2-10 out-of-scope collisions | Shared-number and shared-street indexes are keyed by banner and state |

Source freshness is now recorded (`sourceAcquiredAt` in `run.json`) and
`status --max-source-age-hours` checks it separately from publication age.

Results after the fifth pass: see the counts in `docs/MATCHING.md`.

## How to repeat this

```sh
pnpm sync --dry-run          # re-match the archived inputs
```

Then read `data/out/latest/decisions.csv`. Every row carries its tier, its
reason, and its top candidates with scores, so the sample above can be
rebuilt from the file alone.
