# Matching rules

This is the specification the matcher implements. Every rule traces to a
statement in `docs/BRIEF.md` or to an observation in the data. When the
implementation and this document disagree, fix one of them in the same change.

## Canonical records

**Acme project** (from Project Register, joined to Site Directory on Site ID
and to Key Dates on Project ID):
store, sequence, banner (Market or Warehouse Club), project type, program
year, status (Active, Deferred, Closed), street, city, state, ZIP, former
location number, milestone dates.

**Pulley project** (from the API):
id, raw name, extracted full IDs, extracted store numbers, banner (from
`organization`), project type, status, jurisdiction city, state, normalized
street, dates, pathfinder flag.

## Candidate pool

For an Acme project, candidates are Pulley projects where all of the following
hold:

- `account_plan` is not `pathfinder` (brief: skip Pathfinder)
- `project_type` is not `Signage` (brief: signage is Pulley-only)
- banner matches (brief: Warehouse Club numbering is separate)
- state matches (brief: state is reliable)

City is never a filter (brief: jurisdiction city differs from Acme's city).

## Tiers

Evaluated in order. The first tier with any candidate decides. Within that
tier candidates are ranked by evidence (see Scoring); a unique best candidate
wins, a tie produces `needs_review` with all candidates listed. Ranking and
acceptance are separate: two candidates that differ only in soft
corroboration (jurisdiction city, street name without house number) are a
tie, because the brief says those names legitimately differ. Only hard evidence separates candidates for automatic acceptance, and the
acceptance tie set is computed from the best *decisive* score, not from the
display ordering, so a soft bonus can never promote a weaker candidate.

**Disputed identity.** Conflicting Site Directory, Project Register, or Key
Dates rows, and a joined site whose current/former number disagrees with the
project's store number, are held as `IDENTITY_DISPUTED`. This applies even
when the provisional outcome is `no_match`; source order cannot remove the
case from review. Contradictory site numbers are not borrowed as identities.
Matched overrides must wait until the source dispute is resolved.

Identical Pulley duplicate records collapse. Conflicting versions of a Pulley
ID refuse the snapshot with `SchemaError` (exit 5), so lifecycle, plan, or
organization cannot be selected by pagination order. Live and replay use the
same validation.

**Unknown scope.** Banner and state must both be known and equal for a
candidate to be in scope. Two unknown organization labels are not evidence
of agreement; such rows reach review as `ID_OUTSIDE_SCOPE`.

**Collision indexes are scoped.** A store number or street shared by two
buildings only counts as a collision within one banner and state, so an
unrelated organization's site elsewhere cannot change a decision. Tiers 2 to 6
first drop candidates whose temporal verdict is `conflict` (see Temporal
evidence): the brief folds several Acme lines into one permit only for the
same store and the same year.

| Tier | Candidate rule | Reason code on match |
|---|---|---|
| 1 | Acme `store.sequence` appears verbatim in the Pulley name. When that store number also identifies a second building (a former number reused as a current one), the locality must agree too | `EXACT_ID` |
| 2 | Acme store number, or the site's former location number, appears in the Pulley name. A number that identifies two buildings (one site's former number is another's current number) also needs city or street agreement | `STORE_TYPE_YEAR` |
| 3 | Pulley name has no store but carries this sequence, sits in this city, and across the whole register exactly one Acme project with a compatible type and no temporal conflict fits it | `SEQUENCE_LOCALITY` |
| 4 | Pulley name has no store; normalized street (house number plus street, never a bare street name or placeholder) equals the Acme site street; sequence does not contradict; when two sites share the street key the city must agree | `ADDRESS` |
| 5 | Pulley name has no store or full id; a milestone date lands within 7 days of the Acme Key Date; same city; compatible type; no temporal conflict; and exactly one Acme project in the same banner and state fits it | `DATE_LOCALITY` |
| 6 | Weak evidence only: same street name with a different house number, or same city plus compatible type | never matches; `WEAK_EVIDENCE` review |

If tiers 1 to 5 yield nothing, two checks run before tier 6. The exact Acme
id on a project of the *other* banner or state is most likely a data-entry
error in Pulley, so it becomes `needs_review` (`ID_OUTSIDE_SCOPE`) naming
the project. Otherwise, if store-identified projects exist in other years,
the result is `no_match` with reason `UNRELATED_ONLY` and those projects
listed, in preference to a tier 6 guess.

**Assignment pass.** After every project is decided, any Pulley project
claimed by Acme lines from different sites or program years (possible when
the project has no dates to conflict with) is resolved across the register.
The full id written in the name pins the project to that line's year and
anchors the group; failing that, claims with dates within a week anchor it;
failing that, the best-scored claim. Anchors of equal strength that disagree
with each other (two full ids from different years on one name, or two
lines with the same exact dates in different years) anchor nothing, and so
does a tie among best scores: every claim goes to review, and input order
can never pick a winner. Every non-anchored site-and-year claim goes to
`needs_review` (`YEAR_CONFLICT`). Tests enforce that no Pulley project is
ever assigned to two sites or two years and that decisions are invariant to
the order of the register and the pool.

**Shared street keys.** When two sites share a normalized street key, an
address-tier match there also needs city agreement. Street name alone (the
weak tier) likewise needs the city.

Store numbers in Pulley names are extracted by `normalize/name.ts`. A 4-digit
token preceded by a store marker (`#`, `Store`, `Club`, `AM-`, `Acme`, `|`)
is a store. An unmarked token in 2024 to 2035 is a year. Sequences found on
their own (`.1004`, `Seq 1005`, `Proj 1001`, trailing `(1001)`) are never
treated as stores. Three real stores (2020, 2020, 2023) fall in the year
range; they are recognized only when marked.

**Type compatibility, not type equality.** The type code inside a Pulley
name is Acme's line-item type, while Pulley's `project_type` is the permit
type. In the data, Coffee Tenant, Deli Remodel, and Pharmacy Relocation
lines are filed under Remodel or Expansion permits at the same store and
year. Candidates are therefore judged on *compatible* type: equal types, or
a Pulley umbrella type (Remodel, Expansion, New Build) covering an Acme line
of type Remodel, Expansion, Coffee Tenant, Deli Remodel, or Pharmacy
Relocation. EV Charging only matches EV Charging. Signage never matches.

## Temporal evidence

Pulley dates are the Acme Key Dates with small jitter: among exact-id
matches with dates on both sides, 57 of 71 are within 7 days and 63 within
30. The matcher computes the smallest gap between corresponding milestones
(construction start, permit submitted, permit approved) and combines it with
the year written in the name:

| Verdict | When |
|---|---|
| `same` | Year in the Pulley name equals the program year, or a milestone is within 30 days |
| `near` | Same year by date, or a different year but a milestone within 180 days (year-boundary slip) |
| `unknown` | No year in the name and no overlapping dates |
| `conflict` | Year in the name differs, or the date year differs with no milestone within 180 days |

## Scoring (ordering within a tier)

| Evidence | Weight |
|---|---|
| Exact id in name | +100 |
| Milestone within 7 days | +45 |
| Temporal `same` / `near` / `conflict` (tier 1 only) | +30 / +8 / -35 |
| Sequence equal / different | +30 / -30 |
| Type equal / compatible / incompatible | +20 / +8 / -40 |
| Exact street / street name only | +15 / +5 |
| City matches | +3 |
| Statuses agree (status gate) | +20 |

Weights only order plausible candidates; hard exclusions (banner, state,
pathfinder, signage, contradicting store or sequence, temporal conflict)
never reach scoring. Status agreement outranks every soft signal so a live
duplicate beats a canceled one, but never outranks an exact id or exact
dates.

## Decision after ranking

| Situation | Result |
|---|---|
| One best candidate, compatible type, statuses agree | `matched` |
| Several candidates tie, all canceled or all live | `needs_review` (`AMBIGUOUS`) |
| Several tie, exactly one is live | the live one is `matched` |
| Best candidate has incompatible type, and every candidate has a different sequence | `no_match` (`UNRELATED_ONLY`, other line) |
| Best candidate has incompatible type otherwise | `needs_review` (`TYPE_MISMATCH`) |
| Best candidate fails the status gate | `needs_review` (`STATUS_CONFLICT`) |
| A status on either side has no known lifecycle meaning | `needs_review` (`STATUS_UNKNOWN`) |
| The Acme project's own source rows conflict | `needs_review` (`IDENTITY_DISPUTED`) |
| Only store-identified projects in other years | `no_match` (`UNRELATED_ONLY`, other year) |
| Exact id found only on the other banner or state | `needs_review` (`ID_OUTSIDE_SCOPE`) |
| Same Pulley project claimed from another program year without strong evidence | `needs_review` (`YEAR_CONFLICT`) |
| Only tier 6 evidence | `needs_review` (`WEAK_EVIDENCE`) |
| Only pathfinder or signage projects reference the id or store | `no_match` (`EXCLUDED_ONLY`) |
| Nothing at all | `no_match` (`NO_CANDIDATE`) |

## Input quality and publication

Schema validation proves shape, not completeness. Before publishing, the run
compares its inputs and outcome with the previous successful run:

| Condition | Effect |
|---|---|
| Any report or the Pulley list has zero rows | publication refused |
| Any input or the matched count fell by more than half | publication refused |
| Any input or the matched count fell by more than a fifth | reported in the summary |
| Source rows repeat a key with different content | conflicting Site Directory/Key Dates joins are set aside and affected Acme projects go to review; conflicting Pulley versions refuse publication |
| Rows repeat a key with identical content | collapsed to one, reported |

A refused publication exits with code 8, names the condition, points at the
archived inputs, and leaves `latest.json` untouched. `--accept-input-change`
publishes anyway and records that choice in `run.json`.

**Publication invariants.** After normalization, matching, the assignment
pass, and human overrides, the combined result is checked once more before
anything is written: one decision per register row; every matched row has
an in-scope target that passes the status gate and is not disputed; no
non-matched row carries a target; and no Pulley project is assigned to more
than one building or year. A violation is a defect in the tool, exits with
code 10, and publishes nothing. Overrides that would create such a conflict
are withdrawn with a reconfirmation message before this check runs.

## Status gate

Applied to the winning candidate of tiers 1 to 3.

| Acme status | Pulley status | Result |
|---|---|---|
| Closed | Canceled or Complete | matched |
| Closed | anything else | needs_review (`STATUS_CONFLICT`) |
| Active or Deferred | Canceled | needs_review (`STATUS_CONFLICT`) |
| Active or Deferred | anything else | matched |

Brief: canceled only counts when canceled or closed on both sides. Every
status value is classified explicitly as active, complete, or canceled
(spelling variants such as Cancelled, Completed, Closed, Done included). A
value outside those lists is `unknown`, and unknown never produces a
confident match; the row goes to review as `STATUS_UNKNOWN`.

**Status drift.** Differences the gate permits but the two systems may want
to reconcile (Pulley Complete while Acme is Active or Deferred; Acme
Deferred while Pulley is In Progress or Draft) are reported per matched row
in `decisions.csv` (`status_drift`) and summarized, never used to change an
outcome.

## Cardinality

- Several Acme rows may map to the same Pulley project. This is expected when
  store and program year agree (brief: one permit covers several lines).
- One Acme row never maps to more than one Pulley project. Ties are
  `needs_review`.
- When two Pulley candidates differ only in status and exactly one is
  Canceled, the live one wins and the canceled one is recorded as a runner-up.

## Output statuses

| Status | When |
|---|---|
| `matched` | Exactly one candidate survived its tier, type is compatible, status gate passed |
| `needs_review` | Ambiguous tie, type mismatch, status conflict, or weak evidence only |
| `no_match` | No candidate, only excluded projects, or only explicitly unrelated lines |

## Review file

Every `needs_review` row includes the reason code, a one-line note, and up to
five candidates with their Pulley id, name, status, type, tier, and score,
so a reviewer can decide in seconds. Matched rows carry the same evidence
so a disputed match can be audited.

## Determinism

Same inputs produce byte-identical outputs. Candidate ordering is by Pulley
id, never by map iteration order. A test enforces this.

## Results on the 2026-10-08 dataset

| Outcome | Count |
|---|---|
| matched | 332 (tier 1: 97, tier 2: 197, tier 3: 16, tier 4: 14, tier 5: 8) |
| needs_review | 18 (4 ambiguous, 4 status conflict, 3 type mismatch, 4 year conflict, 2 id outside scope, 1 weak) |
| no_match | 50 (21 no candidate, 24 other year or other line, 5 pathfinder only) |
| status differences on matched rows | 33 (reported, not an outcome) |

See `docs/VALIDATION.md` for the hand check behind these numbers and the
match-rate estimate. Counts come from `tests/domain/match/matcher.test.ts`
running the matcher over the archived fixtures; they will drift as the data
changes.

## Observed data facts that justify the rules (as of 2026-10-08)

- 400 Acme project rows, 363 sites, 449 Pulley projects (20 pathfinder).
- Sequences 1000 to 1007 recur under almost every store.
- 16 stores have more than one site row; no banner-plus-store collisions.
- 10 sites carry a former location number; 8 Pulley names use the old number.
- 146 Pulley names contain a full ID (137 found in the register), 275 contain
  a store number only, 28 contain neither.
- 299 Pulley projects have a street; 169 match the directory before
  normalization, 256 after (`normalize/address.ts`). Of the 43 remaining,
  39 are the correct street with a mistyped house number (411 vs 501,
  3288 vs 3688, 4549 vs 4949) and 4 belong to names with no store number.
  So an exact street match is strong evidence, and a street-name-only
  match (`streetNameKey`) is corroboration, never proof.
- Canonical names: 66 Pulley names and all 400 Acme names carry the
  `STORE.SEQ-CITY-ST-BANNER-TYPE-YEAR` structure. Banner codes SUP and MKT
  mean Market, WHC means Warehouse Club. City in the canonical name equals
  Pulley's jurisdiction city in 64 of 66 cases.
- 11 Pulley names carry a `[Canceled]` marker; 32 names carry no store,
  full id, or sequence at all (28 of them have no digits).
- 15 Pulley Signage projects; Acme has no Signage type.
- 15 Pulley Canceled projects; only 3 are Closed on Acme's side.
- 17 Acme store-and-year groups contain more than one row (39 rows).
- Key Dates mixes two date formats: 1146 cells `MM/DD/YYYY`, 223 cells
  `YYYY-MM-DD`, 631 blank. Pulley dates are always ISO.
