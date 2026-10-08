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
- dedicated `Signage` matches only dedicated `Signage`; general work cannot use a signage permit
- banner matches (brief: Warehouse Club numbering is separate)
- state matches (brief: state is reliable)

City is never a filter (brief: jurisdiction city differs from Acme's city).

## Tiers

Evaluated in order. The first tier with any candidate decides. Within that
tier candidates are ranked by evidence (see Scoring); a unique best candidate
wins only if the shared safety gate passes; a tie produces `needs_review` with all candidates listed. Ranking and
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

**Normalization safeguards (rules 2026-10-08.7).** Bracketed prefixes remain
part of identity, year, and signage extraction even when removed from display
text. Every named store must be the project's current or verified former number;
an additional building is a conflict even if missing from the register. Acme
name/structured ID or year conflicts remain in review even with no candidate.
Address keys retain building designators in both prefix and suffix forms. Street
suffixes and directionals are normalized by position; words inside the street's
proper name are preserved (North Street is not silently equated with N Street).

**Safety gate (rules 2026-10-08.11).** Ranking is not sufficient for acceptance.
`domain/match/safety.ts` is used by the matcher, overrides, and publication:

- Exact IDs do not bypass temporal contradictions. Explicit year conflicts,
  conflicting years in one name, or any corresponding milestone more than
  180 days apart produce `EVIDENCE_CONFLICT`. The 180-day threshold is a
  conservative review trigger, not proof of a wrong mapping. Submission uses
  actual dates when available, otherwise projected dates.
- Both Acme and Pulley names are checked against structured identity, state,
  banner, signage and cancellation fields. Source contradictions are held even
  when no candidate exists. Explicit signage phrases such as Sign Permit and
  Pylon Sign are recognized without misclassifying Design or Sign Off.
- A close milestone cannot hide other contradictory milestones. Name/field
  disagreements about cancellation, signage, organization, or state also go
  to review. Incompatible types and explicitly different buildings cannot be
  forced through with an override.
- A different street name, an exact address identifying another registered
  building, or competing building evidence from dates blocks acceptance.
  A house-number typo alone is not proof of a different building. A shared
  current/former store number can be resolved by a unique full composite ID, a
  uniquely agreeing city, or a unique exact address. A second owner of the same
  full ID or an exact address pointing to another site remains a hard conflict.
  A stale former number with a different sequence cannot overrule an explicit ID.
- Explicit full IDs (including known former-number aliases) remain evidence
  of ownership even if that owner's match is withheld or another candidate
  wins for it. A conflicting site/year cannot inherit the permit silently.
- Without a trusted full ID establishing the site/year, unknown temporal
  evidence produces `INSUFFICIENT_EVIDENCE`, except when there is exactly one
  compatible Acme project for the selected permit and exactly one compatible candidate identified by
  its current/former store number. Address-, sequence-, and date-based competitors
  count against this exception. Siblings with incompatible permit types, conflicting
  lifecycle states or contradictory temporal evidence do not count as owners;
  unknown sibling status remains unresolved. Multiple compatible Acme lines or
  compatible candidates still need temporal evidence. Jurisdiction-city differences do not block a unique store.
- A human override with an explanatory note can resolve a street-name or milestone
  discrepancy. Explicit year/identity conflicts, another registered owner,
  banner/state/exclusion/status rules and one-building/one-year assignment remain
  enforced. Dates in another calendar year alone are a soft signal for a reviewed
  override; an explicit conflicting program year in a name is a hard constraint.
- Per-run indexes select relevant owners by site, full ID, store, street, and
  locality. Exact-ID and store tiers use indexed candidates before broader fallback
  scans. No ownership cache survives a new run.

**Assignment pass.** A Pulley project cannot be assigned across sites or
program years. Full-ID anchors must agree; otherwise date anchors within
seven days must agree. Without a unique strong anchor, every competing
claim goes to review. Ranking scores (including street-name and city
bonuses) never choose the winning building/year. Safety checks run before
assignment, and the publication boundary checks accepted pairs again.

**Shared street keys.** When two sites share a normalized street key, an
address-tier match there also needs city agreement. Street name alone (the
weak tier) likewise needs the city.

Store numbers in Pulley names are extracted by `normalize/name.ts`. A 4-digit
token preceded by a store marker (`#`, `Store`, `Club`, `AM-`, `Acme`, `|`)
is a store. An unmarked token in the supported program-year range 2000 to 2100 is a year. Sequences found on
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
Relocation or EV Charging. EV-to-umbrella folding additionally requires a known
permit year and no compatible dedicated EV candidate; otherwise a reviewer must
confirm the permit scope. This is directional: Remodel cannot fold into an EV
permit. Signage never folds into these permits.

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
pathfinder, crossing the signage/general-work boundary, contradicting store or sequence, temporal conflict)
never reach scoring. Status agreement outranks every soft signal so a live
duplicate beats a canceled one, but never outranks an exact id or exact
dates.

## Decision after ranking

| Situation | Result |
|---|---|
| One best candidate, compatible type, statuses agree, safety gate passes | `matched` |
| Contradictory identity, year, dates, or lifecycle evidence | `needs_review` (`EVIDENCE_CONFLICT`) |
| No trusted full ID and no usable temporal evidence | `needs_review` (`INSUFFICIENT_EVIDENCE`) |
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
| Only Pathfinder or projects across the signage/general-work boundary reference the id or store | `no_match` (`EXCLUDED_ONLY`) |
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
an in-scope target that passes the status and shared safety gates and is not disputed; no
non-matched row carries a target; and no Pulley project is assigned to more
than one building or year. A violation is a defect in the tool, exits with
code 10, and publishes nothing. Overrides that would create such a conflict
are withdrawn with a reconfirmation message before this check runs.

## Status gate

Applied to every accepted match, including overrides.

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

## Current offline results on the 2026-10-08 dataset

| Outcome | Count |
|---|---|
| matched | 324 (tier 1: 93, tier 2: 194, tier 3: 14, tier 4: 15, tier 5: 8) |
| needs_review | 26 (5 insufficient evidence, 7 evidence conflicts, 4 ambiguous, 4 status conflicts, 3 type mismatches, 2 outside scope, 1 weak) |
| no_match | 50 (21 no candidate, 24 other year or other line, 5 pathfinder only) |
| status differences on matched rows | 29 (reported, not an outcome) |

These are coverage counts, not an accuracy measurement. Narrowing the temporal
requirement restores 15 unique store matches relative to rules 2026-10-08.7;
all seven evidence-conflict holds remain. Rules .9 additionally withhold EV row 1679.1001: allowing umbrella permits
introduces a second compatible candidate, so its undated dedicated EV permit
no longer qualifies for the unique-candidate exception. See `docs/VALIDATION.md`
for historical tuning and the remaining independent-validation requirement.
Rules .10 restore 3229.1005 because its siblings cannot own its dedicated EV
permit; 2970.1008 still has a compatible competing owner and remains in review.
A verified former full ID moves one existing match from tier 2 to tier 1 without
changing its target. These are also the rules .11 counts: its replay is byte-identical to the
published .10 mapping at `2026-10-08T20-23-30-750Z`. Counts come from `tests/domain/match/matcher.test.ts`
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

## Review follow-up — rules 2026-10-08.10–.11

Full IDs using a verified former store number receive exact-ID evidence and
can anchor ownership like current-number IDs. Reused-number collisions still
require disambiguation and pass all shared safety checks. Unknown banner codes
in free-text canonical names supply no banner evidence; known contradictory
codes and mismatched structured banners remain blocked on either side.

Address normalization also handles Town Center/Ctr before a street suffix,
numbered Highway/Hwy and Route/Rte prefixes, and directionals on suffixless
streets. North Street is preserved as a proper name; Center/Centre/Ctr is an explicit
spelling alias even in Center Boulevard.
Venue text is discarded before extracting building designators; a standalone
`Building 3,` prefix is retained, while `Acme Building 3,` is venue text.
Explicit building designators in the actual street address remain part of its
identity. This is a conservative string normalizer, not a geocoder.


## Contextual evidence — rules 2026-10-08.11

A brand prefix followed by punctuation still marks a store: `Acme Market - 2043`
is store 2043, not a program year. Bare numbers in 2000–2100 without a store
marker remain year evidence. Recognizable embedded street addresses (including
numbered highways/routes) claim their house numbers before numeric classification;
`1556.1001 – 2050 Main St` does not assert year 2050 or another store. Explicit
program years outside that address span still apply.

A mixed scope such as `Remodel + exterior signs` is a soft confirmation request:
automatic matching holds it, but an explained human decision can verify the
permit's scope. Explicit signage markers, separate/signage-only wording and sign
permit/package labels remain hard exclusions or source-type contradictions.
Signage projects are never silently folded into general permits.

All verified ID aliases (register, current site number and former site number)
are used both for matching and the “not in register” diagnostic. Building keys
normalize `BLDG-3` to `BLDG 3` while preserving distinct IDs and internal hyphens
such as `A-3`.


## Dedicated signage — rules 2026-10-08.12

The brief separates signage from general permits; it does not exclude signage
altogether. Acme and Pulley rows whose structured type is `Signage` can match
through the existing evidence tiers. Type comparison ignores case and surrounding
whitespace. Unknown labels such as `Signs` are not silently interpreted as Signage.

The pair-specific scope rule is shared by candidate selection, reverse ownership
checks, overrides and publication invariants. Neither direction of a signage /
general-work assignment is allowed, even with a full ID or a human override.
Pathfinder, banner, state, lifecycle, building and year safeguards still apply.
Source name/type contradictions remain holds; mixed remodel/sign descriptions
retain the existing explained-review path. Ties and insufficient evidence remain
review cases rather than guesses.

Unclaimed non-Pathfinder signage projects now appear in `pulley-unmatched.csv`,
including when the register has no signage rows. They are not automatically added
to the Acme review backlog. The summary counts signage within the non-Pathfinder
pool and explains that it is eligible only for Acme signage. A project flagged as
both Pathfinder and Signage is excluded once, not subtracted twice.

The current 400-row snapshot has zero Acme signage rows. Its mapping remains
byte-identical at 324 matched / 26 review / 50 no-match. The dedicated-signage
workflow is exercised with synthetic source files; see [validation](SIGNAGE_VALIDATION.md).
