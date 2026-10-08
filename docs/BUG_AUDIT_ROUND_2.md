# Pulley audit, round 2

Audited revision: `0b7e1e5` (2026-10-08). This is a fresh review of the
implementation after `85006cc` and the production-readiness changes. It does
not assume the defects in the earlier audit remain unfixed.

**Verdict: 10 reproduced findings; 5 high priority and 5 medium priority.
I would not approve unattended production publication yet.**

My production-readiness rating is **5/10 for unattended operations**, and
**7/10 for a supervised prototype**. These are engineering judgments, not a
benchmark or a measured accuracy score. The implementation has improved:
typed boundaries, input archives, replay, review evidence, explicit lifecycle
handling, input-volume checks, and a substantial test suite are useful.
However, automatic decisions still violate the brief in reproducible cases,
mutual exclusion is unsafe during stale recovery, and the scheduled workflow
contains a deterministic failure.

## Scope and evidence

The requirements are the original Pulley brief, previously read from the PDF,
and its redacted copy in `docs/BRIEF.md`. In particular:

- A shared permit covers the same building and program year.
- Market and Warehouse Club numbering must remain separate.
- Jurisdiction city may differ from mailing city.
- Uncertainty should be surfaced for review rather than guessed.
- The intended workflow must support repeated updates and accountable review.

I reviewed matching, normalization, overrides, acquisition, HTTP handling,
archiving, publication, retention, locking, CLI status, CI/scheduling, and the
current validation documentation. I used synthetic counterexamples and the
checked-in fixtures. I did not access live upstream systems, load `.env`, or
modify application code or operational data.

Verification:

- Existing suite: **237 tests pass in 21 files**.
- Lint and type checking pass.
- The isolated full pipeline reproduces **332 matched, 18 needs_review,
  50 no_match** on 400 fixture rows: 83% automatic coverage.
- All ten findings are reproduced by
  [`audit-round-2/reproduce.mjs`](audit-round-2/reproduce.mjs).

Run the probes from the repository root:

```sh
node docs/audit-round-2/reproduce.mjs
```

The probes deliberately assert the current **buggy** behavior. A successful
exit means the findings were reproduced, not that correctness tests passed.
After fixes, convert the relevant assertions to the required behavior. They
make no network calls and clean up their temporary directories. The lock
probe uses the public PID/liveness injection points to control the otherwise
rare scheduling interleaving; the filesystem operations are real.

The findings below concern reachable boundary cases. They do not establish
that all ten occur in today's live dataset or quantify its false-match rate.

## Findings

### R2-01 — P1: conflicting strong anchors still allow cross-year assignment

**Location:** `src/domain/match/matcher.ts:161`, especially lines 166 and 168.

`resolveYearConflicts` detects incompatible site/year groups, but `anchorKeys`
returns *every* group supported by an exact ID. If there is no exact ID, it
returns every group supported by dates within seven days. Neither branch
requires the selected anchors to agree on one site/year.

**Reproduction:** use Acme `1556.1002` in 2027 and `1556.1003` in 2028, with
one Pulley name containing both full IDs. Both rows remain `matched` to the
same permit. A separate probe gives both rows the same construction date and
a store-only Pulley name; both are again matched across program years.

**Impact:** the assignment pass still violates the same-year constraint it
is intended to enforce. Fixing exact-ID-versus-date precedence addressed one
case, but equal-strength conflicting anchors remain unsafe.

**Required behavior:** choose at most one supported site/year group per
permit. If strongest anchors disagree, surface the disputed assignment for
review. Test two exact-ID anchors, two date anchors, cross-building anchors,
and valid many-to-one matches within one site/year.

### R2-02 — P1: stale-lock recovery can remove a new owner's live lock

**Location:** `src/run/lock.ts:49`, `src/run/lock.ts:57`,
`src/run/lock.ts:100`.

The atomic hard-link creation prevents partially initialized lock records.
However, stale recovery reads an owner and later renames whatever occupies
the lock path. The rename is not conditional on the identity that was read.

**Reproduced interleaving:**

1. Contender A reads the stale record and pauses in its liveness check.
2. Contender B removes that stale record and acquires a new live lock.
3. A resumes, renames B's live record away, and acquires its own lock.
4. Both `acquireLock` calls have succeeded; B has never released ownership.

The probe observes owner 2001 replaced by owner 2002 while the first owner
still holds its returned lock object. The PIDs are synthetic identifiers
used with the supported liveness callback, not real processes being killed.

**Impact:** two syncs can fetch, publish, and prune concurrently. This defeats
the protection around output history and `latest`. The comment that only
one rename contender can succeed is false once a new owner recreates the
path between contenders.

**Required behavior:** use a mutual-exclusion protocol with safe stale
recovery and owner identity, not an unchecked rename following a stale read.
Retain a deterministic interleaving test; a one-shot concurrent stress test
does not reliably exercise this sequence.

### R2-03 — P1: every otherwise-successful scheduled job fails its freshness step

**Location:** `.github/workflows/sync.yml:71`, `src/cli.ts:83`,
`src/config.ts:25`.

The workflow provides the three required secrets only to the `Sync` step.
The later `Freshness check` step calls `pnpm cli status --max-age-hours 24`
without them. `status` calls the full `loadConfig`, which requires all three
credentials before reading local output status. A clean checkout has no
committed `.env`.

**Reproduction:** invoke the real CLI in a child process with the same
credential-free environment. It exits **2**, reporting all three missing
credentials, before checking freshness. This was reproduced locally; I did
not dispatch a GitHub Actions run.

**Impact:** the scheduler can publish/cache valid outputs and then mark the
job failed every time. The freshness check never performs its intended
check, and job status becomes misleading for operators.

**Required behavior:** let a local status command load only its necessary
configuration, or explicitly provide the environment it currently requires.
Add a clean-environment status test and verify the workflow's step boundaries.

### R2-04 — P1: quarantining contradictory site records makes matching less conservative

**Location:** `src/domain/normalize/build.ts:158`,
`src/domain/normalize/build.ts:171`; quality integration at
`src/run/sync.ts:138`.

Conflicting Site Directory rows are removed from the join, but the affected
project carries no quarantine flag into matching. It becomes indistinguishable
from a project whose site is simply missing, so canonical-name fallback can
restore enough identity to auto-match.

**Reproduction:** a canonical Acme name says NV, its Site Directory entry says
CA, and the exact-ID Pulley project is in NV. The original decision is
`needs_review / ID_OUTSIDE_SCOPE`. Add a conflicting NV row with the same
Site ID. Both site entries are set aside, name fallback supplies NV, and the
decision becomes `matched / EXACT_ID`. The input-quality gate has zero
blockers.

**Impact:** adding contradictory evidence increases confidence. The site
conflict appears in aggregate warnings, but the disputed mapping is accepted
and therefore is not an uncertain row in `review.csv`.

**Required behavior:** preserve structured quarantine reasons on affected
projects. An unresolved identity conflict should reach row-level review or
block publication under a defined policy. Test that contradictory evidence
cannot promote a review decision into an automatic match.

### R2-05 — P1: overrides bypass the assignment and temporal constraints

**Location:** `src/run/overrides.ts:212`,
`src/run/overrides.ts:240`; application order in `src/run/sync.ts`.

Override validation checks banner, state, exclusions, and lifecycle. It does
not check program-year incompatibility or validate the combined assignment
after all overrides have been applied. The global matcher pass runs before
overrides, so it cannot protect the published decisions.

**Reproduction:** the matcher correctly assigns a Pulley project explicitly
named `1556.1002 Remodel 2027` to the 2027 row and marks the 2028 row
`no_match / UNRELATED_ONLY`. An override for `1556.1003` points the 2028 row
at that permit. It is accepted with **zero problems**, leaving both years
matched to the same project.

**Impact:** a stale or erroneous human decision silently defeats a brief-level
constraint even when the automated matcher correctly rejects the target.

**Required behavior:** validate final publication invariants after combining
automated and human decisions. Reconfirm temporal conflicts and incompatible
shared assignments; represent an intentional policy exception explicitly
if the business allows one. Test conflicts between two overrides and between
an override and an automatic match.

### R2-06 — P2: conflicting register duplicates still make output depend on row order

**Location:** `src/domain/normalize/build.ts:145`.

The Site Directory and Key Dates have conflict quarantine, but Project
Register normalization retains the first row of a conflicting ID and only
adds a warning.

**Reproduction:** provide two rows for `1556.1002`, identical except one is
`Active` and one is `Closed`, with a live exact-ID Pulley project. Active
first yields `matched`; Closed first yields `needs_review / STATUS_CONFLICT`.
The quality gate accepts both inputs.

**Impact:** an upstream sort-order change can alter a confident mapping
without changing the set of source facts. The contradictory lifecycle is
not resolved, and selecting one row is not justified by source precedence.

**Required behavior:** retain one output decision for the ID, but route a
conflicting register record to review with the conflicting fields. Collapse
identical duplicates separately. Test permutation invariance across
register duplicates, not just unique rows.

### R2-07 — P2: acceptance uses the wrong candidate as its decisive-score reference

**Location:** `src/domain/match/matcher.ts:538`,
`src/domain/match/matcher.ts:548`, `src/domain/match/matcher.ts:555`.

Candidates are sorted by total score. Acceptance then computes decisive-score
ties against the first candidate in that ordering, without finding the
maximum decisive score. A soft bonus can therefore select a candidate that
is worse under the acceptance policy itself.

**Reproduction:** for a store-1556 remodel at `100 Main St` with no Acme dates:

| Candidate | Evidence distinguishing it | Total score | Decisive score |
|---|---|---:|---:|
| A | Same city, `200 Main St`, same-year Pulley date | 56 | 48 |
| B | `100 Main St` exact address, different jurisdiction city, no dates | 55 | 55 |

Both otherwise have the same store, compatible type, and live status. The
matcher confidently selects **A**. This does not prove B is the real permit;
it proves the stated decisive-evidence acceptance policy is not implemented.

**Required behavior:** determine acceptance from the maximum decisive score
and its tie set. Keep softer ordering for display if useful. Add tests where
total-score order and decisive-score order disagree.

### R2-08 — P2: unknown organizations compare equal because both normalize to null

**Location:** `src/domain/match/compat.ts:113`,
`src/domain/model.ts:29`, `src/domain/normalize/build.ts:171`.

Schemas intentionally preserve new vocabulary. Unknown organization labels
normalize to `null`, but `isInScope` accepts equality of two null banners.
For an Acme name without a recognized canonical banner code, the missing
identity remains null all the way to matching.

**Reproduction:** an Acme site labeled `Acme Outlet` and a Pulley project
labeled `Other Company`, with the same full project ID and state, are both
normalized to null and automatically matched.

**Impact:** the organization-separation boundary fails open precisely when
upstream vocabulary changes. Two unknown values are not evidence that the
organizations agree. Acquisition vocabulary warnings do not prevent this
decision.

**Required behavior:** require known compatible organizational identity for
automatic matching, or an explicitly approved label mapping. Unknown scope
should produce actionable review. Cover unknown-on-one-side and different
unknowns on both sides.

### R2-09 — P2: replay retention deletes the archive referenced by the latest result

**Location:** `src/run/outputs.ts:96`, `src/run/outputs.ts:109`.

Retention independently keeps the newest raw and output directories and
protects only the current *output run ID*. A replay output has a new ID but
references an older input archive, whose ID is not protected.

**End-to-end reproduction:** create live archives A and B, then replay A as
output C with `retainRuns: 1`. C publishes successfully. Its `run.json`
references A, but retention deletes A and keeps B. Repeating the replay of A
fails with `SchemaError: No archived inputs`.

This uses a small configured limit to expose the same boundary reached at
larger retention limits; it does not depend on malformed input.

**Impact:** the newest published result can immediately lose the exact source
bytes needed for inspection and replay. The provenance record survives but
its referenced archive does not.

**Required behavior:** account for output-to-archive references when pruning.
At minimum retain the latest output's source archive; define the guarantee
for other retained outputs as well. Test replaying an old archive at the
retention boundary, then replaying it again after pruning.

### R2-10 — P2: out-of-scope store-number collisions suppress valid exact-ID matches

**Location:** `src/domain/match/matcher.ts:214`; use of the global
`sharedNumbers` set in `decide`.

The collision index counts buildings across all banners and states. Forward
candidate eligibility is scoped correctly, but the collision guard can
still demand locality evidence because of a building that is impossible in
that scope.

**Reproduction:** a Nevada Market row `1556.1002` matches its exact-ID Pulley
project, whose jurisdiction is Washoe County and whose address is absent.
Add a California Warehouse Club site with former location number 1556.
The same Market row now becomes `no_match / NO_CANDIDATE`.

**Impact:** adding an unrelated organization/state can remove a correct
identity match. The jurisdiction mismatch and missing address are ordinary
conditions described by the brief; banner and state already disambiguate
this example.

**Required behavior:** scope collision evidence to the identities that could
actually compete. Add an invariance test proving that unrelated banner/state
records cannot change an existing decision. Apply the same reasoning when
reviewing the global shared-street index.

## Production quality and what is still missing

| Dimension | Rating | Evidence and limitation |
|---|---:|---|
| Structure and maintainability | 8/10 | Clear modules, typed boundaries, deterministic pure matcher, useful operational docs. |
| Matching correctness | 5/10 | Good layered evidence and exclusions, but final assignment constraints and uncertainty handling still fail. |
| Operational reliability | 4/10 | Archives and staged output are useful; locking, scheduler status, and replay retention remain defective. |
| Evaluation and confidence | 3/10 | Unit/fixture coverage is substantial; independent adjudicated accuracy and held-out evaluation are absent. |
| Auditability and review | 6/10 | Detailed decisions and provenance exist; conflicting inputs can escape review and retained provenance can lose its source archive. |

These scores are a practical assessment of the inspected revision, not an
arithmetic average or a certification. This is a deterministic reconciliation
engine; adding an LLM would not repair its identity or assignment invariants.

The following are readiness gaps, **not additional confirmed bugs**:

1. **Measured accuracy.** `docs/adjudication/` provides a template and process,
   but no completed reference set establishing precision. The 83% fixture
   match rate measures automatic coverage. The approximately 96% precision
   estimate remains an author's estimate, as the documentation acknowledges.
   Adjudicate a stratified set, retain whole-store or later-snapshot holdouts,
   and report sample sizes, false matches, false no-matches, and unresolved
   cases by tier. Agree an acceptable false-match rate before unattended use.

2. **One publication acceptance boundary.** Enforce known scope, disputed
   source identities, status compatibility, and compatible shared assignments
   after normalization, matching, and overrides. These requirements are
   currently distributed across paths that can bypass one another. Count
   gates alone cannot detect contradictory identities or bad joins.

3. **Source freshness versus output freshness.** The status command measures
   publication age. In the replay probe, 68-day-old source data reports an
   output age of zero hours. The output explicitly says `source: archive`,
   so this is not a false timestamp; it is insufficient as an upstream
   freshness guarantee. Track acquisition age separately and define which
   value operations monitor. A check that runs only after a successful job
   also cannot independently detect a scheduler that stopped running.

4. **Review capacity and ownership.** The fixture snapshot contains 18 review
   rows. That is not proof of 18 new reviews each week. Measure new/reopened
   cases and unresolved backlog across real snapshots, and assign an owner,
   backup, and response target. Repeated warnings without row-level work items
   are easy to miss.

5. **Adversarial regression coverage.** Add global invariants, duplicate-order
   permutations, irrelevant-record invariance, conflicting-anchor cases,
   controlled concurrency schedules, clean scheduler environments, and
   replay/pruning interactions. The passing 237-test suite does not exercise
   the failures demonstrated here.

6. **Operational acceptance evidence.** This audit did not establish live
   deployment behavior, long-duration scheduling reliability, load limits,
   or recovery under process termination. Run a supervised rollout against
   updated snapshots and rehearse stale-lock recovery and archive restoration
   after addressing the confirmed defects. Keep the previous approved output
   available to operators.

## Recommended order

1. Repair R2-01, R2-04, and R2-05 and add final publication invariants.
2. Repair the lock protocol and workflow environment (R2-02 and R2-03).
3. Repair duplicate handling, acceptance selection, unknown scope, retention,
   and scoped collision checks (R2-06 through R2-10).
4. Convert the probes into correctness regressions and run the full suite.
5. Validate precision and review burden on adjudicated, held-out data before
   granting unattended production approval.

No application fixes are included in this audit. The new files are this
report and the reproduction script; existing audit reports remain historical.
