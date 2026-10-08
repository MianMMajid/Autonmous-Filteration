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
wins, a tie produces `needs_review` with all candidates listed.

| Tier | Candidate rule | Reason code on match |
|---|---|---|
| 1 | Acme `store.sequence` appears verbatim in the Pulley name | `EXACT_ID` |
| 2 | Acme store number, or the site's former location number, appears in the Pulley name | `STORE_TYPE_YEAR` |
| 3 | Pulley name has no store but carries this sequence, sits in this city, and across the whole register exactly one Acme project with a compatible type and non-contradicting year fits it | `SEQUENCE_LOCALITY` |
| 4 | Pulley name has no store; normalized street equals the Acme site street; sequence does not contradict | `ADDRESS` |
| 5 | Weak evidence only: same street name with a different house number, or same city plus compatible type plus non-contradicting year | never matches; `WEAK_EVIDENCE` review |

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

## Scoring (ordering within a tier)

| Evidence | Weight |
|---|---|
| Exact id in name | +100 |
| Sequence equal / different | +30 / -30 |
| Type equal / compatible / incompatible | +20 / +8 / -40 |
| Year in name equal / different | +25 / -35 |
| Year by Pulley date equal / different | +12 / -6 |
| Exact street / street name only | +15 / +5 |
| City matches | +3 |
| Statuses agree (status gate) | +20 |

Weights only order plausible candidates; hard exclusions (banner, state,
pathfinder, signage, contradicting store or sequence) never reach scoring.
Status agreement outranks every soft signal so a live duplicate beats a
canceled one, but never outranks an exact id.

## Decision after ranking

| Situation | Result |
|---|---|
| One best candidate, compatible type, statuses agree | `matched` |
| Several candidates tie, all canceled or all live | `needs_review` (`AMBIGUOUS`) |
| Several tie, exactly one is live | the live one is `matched` |
| Best candidate has incompatible type, and every candidate is explicitly another line (different sequence or year) | `no_match` (`UNRELATED_ONLY`) |
| Best candidate has incompatible type otherwise | `needs_review` (`TYPE_MISMATCH`) |
| Best candidate fails the status gate | `needs_review` (`STATUS_CONFLICT`) |
| Only tier 5 evidence | `needs_review` (`WEAK_EVIDENCE`) |
| Only pathfinder or signage projects reference the id or store | `no_match` (`EXCLUDED_ONLY`) |
| Nothing at all | `no_match` (`NO_CANDIDATE`) |

## Status gate

Applied to the winning candidate of tiers 1 to 3.

| Acme status | Pulley status | Result |
|---|---|---|
| Closed | Canceled or Complete | matched |
| Closed | anything else | needs_review (`STATUS_CONFLICT`) |
| Active or Deferred | Canceled | needs_review (`STATUS_CONFLICT`) |
| Active or Deferred | anything else | matched |

Brief: canceled only counts when canceled or closed on both sides.

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
| matched | 349 (tier 1: 97, tier 2: 226, tier 3: 15, tier 4: 11) |
| needs_review | 17 |
| no_match | 34 (23 no candidate, 7 unrelated lines only, 4 pathfinder only) |

Counts come from `tests/domain/match/matcher.test.ts` running the matcher
over the archived fixtures; they will drift as the data changes.

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
