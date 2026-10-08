# Solution audit against the original Pulley brief

Audited 2026-10-08 at commit `65696c8`. Investigation only; no production code,
existing tests, credentials, or project data changed. The original PDF, repository
documentation, source, workflows, and tests were reviewed. All network-dependent
reproductions used fake upstreams and synthetic credentials. Filesystem experiments
used temporary directories that were removed afterward.

Baseline verification: `pnpm lint` and `pnpm typecheck` passed; `pnpm test` passed
192 tests across 19 files. Recomputing the archived fixtures produced 336 matched,
12 needs_review, and 52 no_match. Passing these checks does not establish that the
mapping satisfies the brief.

Fifteen defects below were reproduced locally. P1 means a high-priority incorrect
mapping, concurrency, or data-preservation problem. P2 means a narrower correctness,
reliability, or security problem. Synthetic cases establish the behavior and its
trigger, not its prevalence in production. Only finding 1 below establishes a
current mapping problem from the unmodified archived dataset.

1. **P1: Many-to-one assignments violate the same-program-year constraint.**

   Sources: `src/domain/match/matcher.ts:61`, `:128`, `:133`;
   `src/domain/match/compat.ts:150`.

   Each Acme row is decided independently. There is no final check that rows
   sharing a Pulley project have the same site and program year. Unknown temporal
   evidence is accepted, and the 180-day allowance can also admit another program
   year. The register's program year for a full ID in the Pulley name is not used
   to constrain other rows that claim that project.

   The unmodified fixture produces these prohibited cross-year groups:

   | Pulley project | Acme rows and program years |
   |---|---|
   | `prj_2r96nc` | `5967.1004` (2027), `5967.1005` (2028) |
   | `prj_4t96jk` | `6409.1005` (2026), `6409.1007` (2027) |
   | `prj_ndjjtq` | `4413.1001` (2027), `4413.1003` (2028) |

   All six rows are labeled matched. The Oxford pair has no Pulley dates or year
   evidence at all. The Charlotte pair contains conflicting full-ID and date
   evidence. These observations do not identify which row in each pair is correct;
   they establish that the tool cannot confidently accept both under the brief.

   Recommended correction: resolve assignments across the register, use known
   full-ID year evidence, and surface incompatible site/year claims for review.
   Test this invariant over every shared Pulley ID, including the actual fixtures.

2. **P1: Full IDs bypass the former/current store-number collision guard.**

   Source: `src/domain/match/matcher.ts:132` versus `:172`.

   Reproduction: current store 4980 in Lowell and store 1912 in Worcester with
   former number 4980 both have sequence 1001. A Pulley project named
   `4980.1001 Worcester, MA` at Worcester's address matches BOTH buildings:
   Lowell by EXACT_ID and Worcester by STORE_TYPE_YEAR. The shared-number locality
   guard applies only to tier 2; tier 1 returns before that guard can help.

   Recommended correction: disambiguate full IDs against current and historical
   building identities before treating them as exact evidence. Do not allow an
   old identifier to resolve to two buildings.

3. **P1: Address matching treats a street address as unique within an entire state.**

   Source: `src/domain/match/matcher.ts:143`, `:255`.

   Reproduction: Market stores 1111 in Reno and 2222 in Las Vegas both have
   `100 Main St`. One store-less Pulley project in Reno with that street matches
   both stores as ADDRESS. Tier 4 has no reverse uniqueness check, unlike tiers 3
   and 5. Ignoring jurisdiction-city disagreement is reasonable; assuming identical
   street text identifies one building statewide is not.

   Recommended correction: check distinct buildings sharing the normalized street
   in the scoped register. Ambiguous addresses require additional evidence or
   review; do not introduce strict city equality that would break the brief's
   jurisdiction examples.

4. **P1: Saved overrides silently preserve matches after cancellation conflicts appear.**

   Source: `src/run/overrides.ts:135` through `:156`.

   Reproduction: run the real fixtures; save an override confirming active Acme
   `3497.1001` to `prj_yeeq2r`; change that Pulley project's status to Canceled and
   run again. The matcher correctly detects the status conflict, but the old
   override restores `matched`. Its retained candidate evidence explicitly has
   `statusAgree: false`. No override problem is reported.

   Only target existence, Pathfinder, and signage are checked when applying an
   override. Banner, cancellation, and other material evidence changes are not
   revalidated. The feature deliberately permits human corrections, but an old
   confirmation is not a new approval of changed upstream facts.

   Recommended correction: enforce the brief's non-overridable constraints and
   invalidate or require reconfirmation of decisions whose relevant source facts
   have changed. Retain the human note and explain why reconfirmation is needed.

5. **P1: Same-second run IDs overwrite history and can change the last good output on failure.**

   Sources: `src/run/archive.ts:42`, `:61`, `:76`;
   `src/run/outputs.ts:40`.

   `createRunId` discards milliseconds. Archive initialization reuses an existing
   directory, archive writes overwrite files, and output writing explicitly deletes
   an existing final directory.

   Reproduction: successful mocked run at `10:00:00.100Z`, then a second with changed
   data at `10:00:00.900Z`. Force the latest-pointer update to fail by creating a
   directory at `out/latest.json.tmp`. The second run raises IoError, but the first
   run's mapping has changed and latest.json still points at that overwritten run
   ID. This violates the promised preservation of the previous good output.

   Recommended correction: allocate collision-resistant run IDs and create archive
   and final output directories exclusively. Never delete an existing completed
   run as part of publishing a new one.

6. **P1: Stale-lock recovery can grant the lock to multiple owners.**

   Source: `src/run/lock.ts:45` through `:53`.

   A contender reads a stale lock, then unconditionally removes the path. Another
   contender can replace it with a live lock between those operations; the first
   contender then deletes that new lock. An empty file during creation can also be
   mistaken for an unreadable stale lock.

   Reproduction: preseed a lock with a nonexistent PID; start 20 simultaneous
   acquireLock calls without releasing any successful acquisition. Across 50 local
   trials, 7 granted multiple acquisitions, with up to 3 owners. A separate test
   releasing 20 independent worker threads from a shared barrier granted 8
   acquisitions. These are timing-dependent observed results, not claimed rates.
   A control experiment without a stale lock produced no multiple acquisitions in
   30 trials.

   Recommended correction: use a proven lock primitive or a recovery protocol that
   cannot delete a replacement owner. Include concurrent stale-recovery tests and
   ownership-safe release tests.

7. **P2: Offline replay changes decisions when API pages contain duplicate projects.**

   Sources: `src/run/acquire.ts:154` through `:162`;
   compare `src/sources/pulley/client.ts:69` through `:75`.

   Live fetching deduplicates IDs; replay appends every archived project. The same
   Pulley ID can therefore appear as two tied candidates during replay.

   Reproduction: serve the archived projects, followed by a second page repeating
   `prj_yeeq2r`. Live output is 336 matched / 12 review / 52 no_match. Replay of those
   exact bytes becomes 335 / 13 / 52: `3497.1001` loses its match to an artificial
   ambiguity. This breaks the offline-demo and reproducibility guarantees.

   Recommended correction: share page aggregation and duplicate handling between
   live and replay paths. Test equality of decisions with duplicate pages present.

8. **P2: The date tier accepts candidates explicitly classified as another year.**

   Source: `src/domain/match/matcher.ts:147`, `:228`.

   Reproduction: Acme program year 2027 with construction start 2027-01-15; Pulley
   name `Acme Reno Remodel 2026` with that same construction date. The decision is
   matched / DATE_LOCALITY even though its own evidence says `temporal: conflict`
   and `year: name_different`. Tier 5 omits the temporal filter applied to tiers
   2, 3, and 4, and its reverse check also omits it.

   Recommended correction: apply a consistent conflict policy to the date tier
   and its reverse identification check. Explicitly contradictory evidence should
   not silently turn into a strong match.

9. **P2: Reverse uniqueness checks ignore state and reject otherwise unique matches.**

   Source: `src/domain/match/matcher.ts:207`, `:241`.

   Reproduction: one Acme store in Springfield, IL and another in Springfield, MA,
   both with sequence 1002 and compatible type. A Pulley project in IL named
   `Springfield Seq 1002` is unique in its valid state pool, but the IL row becomes
   WEAK_EVIDENCE review because the reverse lookup counts the MA row too. The
   date-based reverse lookup has the same missing state constraint.

   Recommended correction: use the same banner/state eligibility rules in forward
   and reverse matching. Test repeated city names across states.

10. **P2: Missing Site Directory rows erase usable canonical identity evidence.**

    Source: `src/domain/normalize/build.ts:110`;
    `src/domain/match/matcher.ts:126`.

    Reproduction: register row `1556.1002-RENO-NV-SUP-RM-2027`, missing joined site,
    and an otherwise matching Market Pulley project with that exact full ID.
    Normalization sets banner to null and the pool rejects the project. Output is
    NO_CANDIDATE with the misleading note that no Pulley project carries the ID.
    The canonical name already provides the SUP banner and NV state.

    Recommended correction: use validated canonical identity as a documented
    fallback, or emit a missing-data review decision if confidence is insufficient.
    Missing source data should not be reported as evidence of absence.

11. **P2: Unknown status values are treated as permission to match.**

    Source: `src/domain/match/compat.ts:165` through `:186`.

    Reproduction: Acme status `Canceled` against live Pulley gives matched. An
    unknown Pulley status such as `Archived` against active Acme also gives matched.
    Schemas intentionally accept new vocabulary, but the status gate recognizes
    only Acme `Closed` and defaults every other Acme value to active. Pulley's
    unknown values similarly pass unless spelled canceled/cancelled.

    Recommended correction: classify statuses explicitly, handle recognized
    synonyms, and route unknown lifecycle meanings to review. A logged vocabulary
    warning does not make a confident mapping conservative.

12. **P2: Incomplete addresses are promoted to exact-address evidence.**

    Source: `src/domain/normalize/address.ts:92` through `:106`;
    `src/domain/match/matcher.ts:255`.

    Reproduction: Acme street `Main St` and store-less Pulley street `Main Street`
    produce matched / ADDRESS without a house number. `N/A` and `unknown` also
    produce non-null address keys. This contradicts the normalizer's stated
    requirement for a usable house number and street.

    Recommended correction: distinguish a full street address from a street-name
    or placeholder key. Only the full-address form should be eligible for tier 4.

13. **P2: Downloads interrupted after headers bypass retries and return the wrong error category.**

    Sources: `src/sources/http.ts:84`;
    `src/sources/pulley/client.ts:108`;
    `src/sources/siteledger/client.ts:67`, `:84`.

    The retry loop ends when fetch returns a successful Response. Body consumption
    happens outside that loop. A connection failure or timeout while reading the
    body therefore bypasses the retry policy.

    Reproduction: use a 200 Response with a ReadableStream that errors while read,
    configure three retries. Pulley and report download each make just one request
    and propagate TypeError (CLI exit 1). Login makes one request and misclassifies
    the failure as SchemaError (exit 5). Expected: transport retries and, if they
    fail, NetworkError (exit 4).

    Recommended correction: keep body consumption inside the retried transport
    operation; separate transport exceptions from invalid JSON/schema failures.

14. **P2: Human-facing CSV exports preserve spreadsheet formulas from upstream text.**

    Source: `src/output/csv.ts:74`, `:91`.

    Reproduction: an accepted Acme project name `=1+1` is emitted literally in
    decisions.csv, starting `1556.1002,=1+1,Remodel,...`. Names, notes, and candidate
    names are copied into operator-facing CSVs with no formula escaping. This is
    a spreadsheet formula-injection exposure when those fields are interpreted as
    formulas. No spreadsheet application or malicious formula was executed during
    this audit; the unsafe export was verified directly.

    Recommended correction: escape formula-like free-text cells in the review,
    decisions, and unmatched-project exports. The installed csv-stringify version
    exposes `escape_formulas`. Preserve the required mapping IDs and schema.

15. **P2: Whitespace in account_plan bypasses the Pathfinder exclusion.**

    Source: `src/domain/normalize/build.ts:149`;
    `src/sources/pulley/schema.ts:31`.

    Reproduction through normalization: `accountPlan: "pathfinder"` produces
    no_match / EXCLUDED_ONLY, while `accountPlan: "pathfinder "` on the same exact-ID
    project produces matched. The schema accepts the string, and the exclusion
    lowercases without trimming. The vocabulary warning does not exclude it.

    Recommended correction: trim and normalize categorical values before matching
    or exclusion checks; define a conservative policy for unknown plan values.

Additional workflow finding, confirmed by source inspection but not by running
GitHub Actions: `.github/workflows/sync.yml:57` uploads `data/out/latest/` under the
current run's artifact name with `if: always()`. If a restored cached output exists
and the new sync fails, it publishes the previous run's CSV under the failed run's
name. Restrict the current-result artifact to successful runs, or label retained
previous results explicitly with their original run ID. The workflow itself was
not executed or changed.

The tests explain why these defects escaped detection. The real-data tests assert
aggregate match/review thresholds and same-input determinism, but no global
site/year invariant. The test named "every matched row satisfies the status gate
and type compatibility" (`tests/domain/match/matcher.test.ts:502`) never asserts
`statusAgree`. The replay test has no duplicate page, the output-failure test uses
different run IDs, and the lock tests do not exercise simultaneous stale recovery.

Suggested repair order: enforce the shared-assignment and identity constraints;
revalidate overrides; repair run identity and lock ownership; unify live/replay
input handling; then correct the remaining matching, transport, and export cases.
Recompute all outputs and repeat validation before updating the submission's
accuracy estimates. This audit cannot establish a new precision percentage
without adjudicated correct mappings.
