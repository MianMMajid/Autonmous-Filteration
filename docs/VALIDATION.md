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
The estimate is unchanged. The audit is right that no precision figure can
be established without adjudicated correct mappings; the figure here rests
on the hand check described above and should be read as such.

## How to repeat this

```sh
pnpm sync --dry-run          # re-match the archived inputs
```

Then read `data/out/latest/decisions.csv`. Every row carries its tier, its
reason, and its top candidates with scores, so the sample above can be
rebuilt from the file alone.
