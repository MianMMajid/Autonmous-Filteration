# Production readiness assessment

Assessment date: 2026-10-08. Final reviewed commit: `39c8016`. Scope: the Acme
SiteLedger-to-Pulley matching CLI against the original take-home brief. Ratings are engineering judgments about
readiness for unattended use, not estimates of matching accuracy or company hiring
standards. No production code was edited for this assessment.

**Production readiness: approximately 4/10 (weighted rubric: 4.25/10). Take-home
prototype: approximately 7/10.** The implementation has a maintainable structure
and substantial test coverage. It does not yet provide sufficient evidence that
automatically accepted mappings are correct, that damaged inputs cannot replace
good results, or that operators will promptly notice failure and stale data.

The supported next deployment stage is a supervised pilot after the correctness
and publication blockers are repaired. The reviewed state is not ready for
unattended operational reliance. This assessment does not require a large service,
a web application, or a learned model for a 400-project batch workflow.

## Evidence and revision boundaries

The completed baseline audit is [BUG_AUDIT.md](BUG_AUDIT.md), covering commit
`65696c8` and 15 locally reproduced defects. Baseline lint and type checking pass.
All 192 tests across 19 files pass. A fresh coverage run measured:

| Metric | Measured baseline |
|---|---:|
| Statement coverage | 94.06% |
| Branch coverage | 88.64% |
| Function coverage | 94.62% |
| Line coverage | 95.52% |

The coverage configuration excludes CLI and preflight. CI runs `pnpm test`, not
the coverage command, so configured coverage thresholds are not enforced in CI.
High coverage is useful but did not prevent the reproduced business-rule defects.

Implementation edits arrived during this assessment and were subsequently
committed as `39c8016`. They were left untouched, and the final committed revision
was rechecked. It adds a year-conflict pass, address checks, canonical banner
fallback, more status synonyms, status-difference reporting, run retention, and a
macOS launcher. These improvements deserve credit: not every baseline finding is
still open in its original form.

**Final revision verification: lint and type checking pass; all 202 tests across
19 files pass.** Coverage percentages above are from the earlier baseline, not
a claim about the revised files. Intermediate failures while edits were underway
were superseded by this final verification.

The final matcher produces 334 matched, 16 review, and 50 no_match on the
fixtures. It still assigns `prj_4t96jk` to `6409.1005` (2026) and `6409.1007` (2027):
the resolver retains both years when both claims count as strong. With two equally
supported years and no strong claim, reversing register order changes which year
stays matched. This confirms that the global matching policy remains incomplete.

## Rating rubric

| Dimension | Weight | Rating | Evidence behind the rating |
|---|---:|---:|---|
| Matching and data correctness | 25% | 3/10 | Real cross-year conflicts; incomplete identity and ambiguous-evidence controls; no publication quality gate |
| Reliability and recovery | 20% | 4/10 | Useful retry/archive/atomic-publication structure, but reproduced lock, collision, replay, and transport failures |
| Evaluation and test validity | 15% | 4/10 | Strong code coverage; weak independent accuracy evidence and missing invariants/fault combinations |
| Security and data governance | 10% | 5/10 | Sensible secret exclusions and limited integration scope; CSV formula exposure and incomplete lifecycle controls |
| Operations and observability | 10% | 3/10 | Scheduling, logs, exit codes, and summaries exist; no demonstrated freshness alerting, ownership, or recovery exercise |
| Architecture and maintainability | 10% | 8/10 | Clear modules, pure domain logic, explicit types/schemas, lockfile, docs, and fast checks |
| Permit Ops usability | 10% | 5/10 | Useful files and overrides; incomplete decision evidence and an engineering-heavy ownership model |

The weighted score is 4.25/10. Averages do not override release gates: a confirmed
silent wrong-match path or last-good-output corruption can block rollout even if
the documentation and architecture scores are high.

## What is already worth keeping

- A deterministic rules engine is appropriate for the identifiers and explicit
  constraints in the brief. The architecture allows inspection and replay of a
  decision without depending on a model provider.
- Acquisition, normalization, matching, output, and orchestration are separated.
  The core matching functions accept plain data, which makes targeted tests easy.
- Strict TypeScript, runtime Zod boundaries, frozen dependencies, linting, and CI
  establish useful development controls. The repo avoids unnecessary services.
- The exact required mapping header, including its intentional misspelling, is
  tested. Review, decisions, unmatched-project, summary, and run-record outputs
  give operators more than the minimum deliverable.
- Pagination loop protection, retry/backoff, typed failures, raw archiving,
  previous-run comparison, and manual corrections address real operational needs.
- The documentation explains business rules and tradeoffs. Its claims need to be
  reconciled with verified behavior, but its structure is useful.

## 1. Matching needs an acceptance policy across the entire dataset

The main gap is not another scoring weight. The system must prevent a set of
individually plausible decisions from producing a jointly invalid assignment.

Before publication, require all of these:

- Each input project has one output decision, and every matched target exists.
- Every target satisfies the allowed account-plan, banner, and lifecycle rules.
- Several Acme rows sharing one Pulley project resolve to the same building and
  program year, unless an explicit business exception has been approved.
- Former/current store-number collisions and addresses shared by multiple
  buildings are resolved by evidence, not iteration order.
- Unknown or missing critical identity/status evidence cannot silently count as
  agreement. It produces review or an explicitly quarantined input condition.
- Human overrides pass the same non-overridable constraints and are reconsidered
  when relevant upstream facts change.

The baseline accepts a unique highest score even when the difference is only the
three-point city bonus. A reproduced example has two live projects with the same
full Acme ID and otherwise identical evidence: a Reno jurisdiction scores 173,
while Washoe County scores 170. Reno wins automatically even though the brief
explicitly says jurisdiction names can differ. This is an acceptance-policy gap,
not proof that a particular duplicate is wrong. Score separation needs validation
before it can justify suppressing human review.

Keep ranking and acceptance separate. A score can order what a reviewer sees;
automatic acceptance should require defined sufficient evidence and no unresolved
contradictions. A score of 173 has no demonstrated probabilistic interpretation.

## 2. Input schemas need semantic data-quality checks

Correct types and column headers do not establish that an export is complete,
consistent, or current.

Two additional local probes established concrete gaps:

- After a successful 400-row run, a valid XLS declaring `Rows: 400` but containing
  only headers produced a successful zero-row run. Both warnings appeared, yet
  latest.json advanced and mapping.csv contained only its header. The pipeline
  recorded 400 removals without blocking publication.
- Adding a conflicting duplicate Site Directory row for `ST-10412`, then moving
  that row from the beginning to the end, changed `2036.1001` from matched to
  no_match with no normalization warning. `new Map(...)` silently selects the
  last site row. Key Dates uses the same map-construction pattern.

Missing controls include uniqueness checks for join keys; a distinction between
identical duplicate rows and conflicting duplicates; join-coverage checks; banner
row-count consistency; large changes in row counts or outcomes; unexpected missing
dates/addresses; and evidence of export freshness.

Some empty exports can be legitimate. Make exceptional publication an explicit
policy with an explanation, rather than accepting every schema-valid collapse.
Archive suspect inputs for diagnosis and preserve the last approved result.

The two source systems and separate reports are acquired independently. If the
upstreams cannot supply a common snapshot, record acquisition windows and export
timestamps and detect inconsistent joins. Do not promise cross-system snapshot
consistency that the sources cannot provide.

## 3. Accuracy claims need independent, reproducible evaluation

The current documentation reports several different quantities:

| Figure | What it actually represents |
|---|---|
| 336/400 = 84% baseline; 334/400 = 83.5% revised | Auto-match coverage: a count, not correctness |
| Approximately 96% | Claimed precision among accepted matches; not backed by a reproducible labeled evaluation artifact |
| Approximately 81% | Estimated correctly matched share of all input rows, obtained from coverage times estimated precision |
| Approximately 94% | Claimed overall outcome correctness, including no_match and review; its calculation is not reproducible from labels in the repo |

The 81% figure is not recall: recall requires knowing how many input projects
actually have an eligible correct Pulley match. A justified abstention is also
different from a verified correct project mapping.

Validation describes examining samples and tuning rules on the same dataset.
That is useful debugging evidence, but it does not measure performance on new
data independently. The repository has no adjudicated expected-mapping dataset
with reviewer identity, rationale, source snapshot, and unresolved labels.

For this small dataset, adjudicate the 400-row snapshot with domain assistance.
Store expected outcomes and allowed targets separately from matcher output. Keep
a fresh later dataset or held-out site groups for evaluation; splitting related
line items from the same store across tuning and evaluation can overstate generality.

Report precision among auto-matches, coverage, false no_match rate where truth is
available, ambiguity/review workload, and results by evidence tier. Include sample
sizes and uncertainty. Evaluate new names, renumberings, missing dates, cancellations,
jurisdiction differences, and duplicates separately.

If the claimed 96% precision were accurate, it would imply approximately 13 wrong
auto-matches among 336 accepted rows in that snapshot. That is material alongside
12 visible review rows. Repeating the same run does not create 13 new independent
errors, and the estimate itself remains unverified. Agree with the Account Lead
on an acceptable error cost and review burden before setting acceptance targets.

## 4. Tests need stronger assertions and failure combinations

The coverage numbers show that code runs under tests. They do not show that the
expected results represent the brief correctly.

Add executable business invariants over all fixtures and generated cases. Include
input-order invariance, live/replay parity, duplicate-row behavior, unique valid
identities, and the consistency of all assignments sharing a target. Distinguish
invariance of decisions from irrelevant differences such as timestamps.

Test combinations: two years plus an exact-ID/date disagreement; a renumbered full
ID plus a current-number collision; missing site plus canonical banner; an existing
override plus a later cancellation; duplicated API pages plus replay. Existing
tests largely cover these ingredients separately.

Fault tests should exercise body-read failures, concurrent stale recovery, run-ID
collisions, interrupted publication, failed pointer updates, corrupt prior state,
and cleanup errors after publication. Assertions must verify that the visible
latest result and recoverable history remain consistent.

The baseline test claiming to verify both type compatibility and the status gate
does not assert status agreement. Fix the assertion, not just the title. Enforce
coverage in CI if the thresholds are intended to be a gate. Add CLI smoke tests
for documented flags, failures, and exit codes, and exercise the supported
deployment OS. Mutation testing of the critical matching constraints would be
useful after the basic invariants exist; blanket extra tests would not be.

## 5. Publication and recovery need explicit guarantees

The current primitives are useful, but their edge cases invalidate some documented
guarantees. A safe batch lifecycle is: acquire inputs, validate semantics, calculate
decisions, validate assignment invariants, stage all artifacts, verify them, then
publish a single immutable run reference.

Use collision-resistant run IDs and exclusive creation. Keep completed run
directories immutable. Make pointer publication the clear commit point. Retention
or other maintenance failures after that point should not misleadingly report
that no result was published; their outcome needs separate reporting.

The new retention work needs tests for failed runs, dry-run references to earlier
archives, interrupted cleanup, and all artifacts needed to reconstruct retained
results. A retention count alone is not a backup or a recovery procedure.

Lock recovery needs ownership-safe coordination, and network retries need to cover
the full body download. Replay must use exactly the same aggregation and semantic
validation as live acquisition. Demonstrate restoring a known good output and
recomputing it from its archived inputs before treating recovery as complete.

## 6. Audit provenance is insufficient to reproduce a historical decision

Raw bytes and run.json are a good start. The archive manifest records file names,
byte counts, kinds, and times, but does not record or verify content hashes.
run.json has a format version, not a matcher/rules version, and does not capture
the exact overrides that influenced that run.

Capture source revision or release ID; rules version; source content hashes;
acquisition/export times; effective non-secret configuration; the overrides snapshot
and hash; input-quality diagnostics; and publication status. Record immutable
source references or enough original fields to explain each decisive comparison.

Provide a way to replay a selected historical run, not only the newest archive.
Separate "reproduce the old decision" from "apply today's rules to old inputs."
Changing today's overrides should not silently change the meaning of historical
replay. Retain the pre-override decision, the human action, and the final outcome.

## 7. Operations need someone accountable for freshness and failure

The repo defines a scheduler and logs, but it does not establish a monitored
service. No repository evidence demonstrates an alert destination, accountable
owner, missed-run detection, or a recovery exercise. GitHub account notification
settings were not inspected and must not be assumed absent or sufficient.

At minimum, track last successful publication time, source-data age, run duration,
source failures, retries, row-count changes, unmatched/review changes, and invalid
overrides. Alert on a missed expected publication and on integrity failures. Give
the operator a clear distinction between a failed run and a successful result
whose source data is old.

Assign an owner and backup, document credential renewal and rollback, and decide
how long stale results remain usable. Establish measurable expectations with the
business, such as delivery before the next agreed review window and an explicit
freshness limit. These expectations should reflect the customer's cadence.

The scheduled workflow currently restores the whole data directory using a cache
and uploads latest results even after failure. Treat human decisions and the
canonical latest-success reference as persistent operational state with defined
recovery, rather than relying on a cache-only design. Label prior-run artifacts
with their actual run identity. GitHub Actions itself is an adequate scheduler
for this scale if these controls are supplied.

## 8. Security and data lifecycle need targeted hardening

The current scope is favorable: it fetches from upstreams and creates local CSVs;
it does not write changes into customer projects. The credential PDF and .env are
ignored, and the logger has redaction rules. This review did not establish a
credential leak.

The reproduced CSV formula exposure must be fixed in human-facing exports.
Production also needs an explicit policy for who can read raw reports, artifacts,
and logs; where secrets are stored and rotated; how long those artifacts survive;
and how restored copies are protected. The tracked fixtures are the simulated
take-home dataset, so their presence is not evidence of a real customer-data leak.

Dependency checks should include the vendored SheetJS release, not just registry
packages. Keep its provenance and integrity review documented. CI action references,
dependency updates, and secret scanning need a defined review process. No fresh
vulnerability advisory scan, remote repository permission review, full history
secret audit, or host-level encryption verification was performed; no claims about
those conditions follow from this score.

## 9. Permit Ops needs a complete review-and-correction workflow

The summary, review.csv, and override mechanism are a useful foundation. The new
launcher reduces friction, but installation convenience does not finish onboarding.

Review CSVs currently expose three candidate slots with names, statuses, types,
and aggregate scores. They do not show the candidate addresses, compared milestone
values, program-year evidence, score contribution breakdown, or why a close
runner-up was rejected. Those details are central to deciding the difficult rows
without searching other files.

Show the facts required for the decision side by side, and give an explicit
recommended action. Preserve the required three-column deliverable separately.
Use direct project links only when the real application provides stable URLs;
do not fabricate links from opaque IDs.

Human resolutions need an author, time, reason, source facts or version, and an
undo/reconfirmation path. A file can serve a single operator if it is safely
versioned and backed up. Multiple simultaneous reviewers need conflict handling.
The current documentation says overrides can be committed, while data/* is ignored;
make the supported storage path explicit.

Measure new review cases, unresolved case age, and decision time. Twelve unresolved
rows shown three times a day are not automatically 36 distinct review tasks. The
brief's "a few a week" should be evaluated as actual new and reopened work, with
an owner and a mechanism to avoid repeatedly triaging unchanged cases.

## 10. Maintainability and scale should remain proportional

Keep the CLI and module boundaries. Make invalid decision states harder to create,
for example by giving matched decisions a required target and non-matched decisions
no target. Centralize eligibility and evidence rules so forward checks, reverse
uniqueness checks, overrides, and post-processing cannot quietly disagree.

The baseline repeats register scans during reverse identification; the new
memoization addresses some of that work. The updated validation document reports
a tenfold scaled-copy benchmark improving from 2.1 seconds to 0.9 seconds. That
benchmark was not independently repeated in this assessment. Measure runtime and
memory on projected data sizes and adversarial ambiguity before optimizing
further; current correctness blockers do not depend on throughput estimates.

Document parser assumptions such as four-digit IDs and the 2024-2035 unmarked-year
window. Tie rules to versioned examples and evaluation changes. Keep operational
docs, reason codes, test counts, and accuracy claims synchronized with releases.

Adding an LLM is not a prerequisite for this problem. A future model could assist
with unstructured evidence for review, but its output would still need evidence,
evaluation, and the same hard constraints. The present gaps are not caused by the
absence of embeddings, a vector database, Kubernetes, or microservices.

## Concrete release gates

| Stage | Required evidence |
|---|---|
| Repair the reviewed baseline | All reproduced high-priority defects have failing-before/passing-after tests; the final diff passes the required checks |
| Trust input and assignment integrity | Invariants hold across all fixture rows; conflicting duplicates and incomplete exports cannot silently publish; order changes do not select arbitrary winners |
| Establish measured quality | Adjudicated labels, an independent evaluation slice, tier-level results, and business-approved acceptance/review targets |
| Demonstrate recovery | Injected failures preserve last good output; same-input live/replay parity; concurrent runs cannot both own the lock; historical replay is reproducible |
| Start a supervised pilot | Named operator and backup, freshness/failure alerts tested, clear review workflow, reversible corrections, and outputs checked before reliance |
| Permit unattended use | Pilot evidence meets agreed quality and operational targets across representative data changes; remaining risk is explicitly accepted by the owner |

The quickest credible improvement is to strengthen the decisions and guarantees
around the existing implementation. More packaging or higher code coverage alone
would not justify a higher production-readiness rating.
