# Production readiness reassessment

Date: 2026-10-08. Audited revision: `9668e4b` (`siteledger-sync` 0.1.1).
**Implementation update:** The three findings below are now addressed by the
0.2.0 working-tree changes, with regression tests and a portable restore drill.
See `DEPLOYMENT.md` for completed safeguards and deployment/accuracy gates that
still require real-world evidence. This report preserves the original audit.

Scope: the brief in `docs/BRIEF.md`, matching and publication safeguards,
recovery paths, scheduled workflow, tests, and operational evidence in this repository.
No production source or workflow was changed during this review.

## Decision

**Suitable for a supervised pilot; not yet ready for unattended production reliance.**
My engineering judgment is **6.5/10 for unattended production readiness**, versus
roughly **8/10 for a supervised pilot** whose operator checks each output before use.
These are qualitative release judgments, not measured accuracy or percentages of work complete.

The previous fixes substantially improved identity handling, ambiguity, override
validation, concurrency, credential forwarding, retry behavior, and reproducibility.
The remaining work is concentrated in publication/recovery boundaries and evidence
that the decisions and operating process work on changing real data. Passing more
unit tests alone will not establish that evidence.

## Verification

- `pnpm test:coverage`: **296 tests passed in 23 files**. Statements 94.41%,
  branches 88.45%, functions 97.05%, lines 95.92%.
- `pnpm lint` and `pnpm typecheck`: passed.
- `node src/preflight.ts --skip-env`: passed; credentials were deliberately not checked.
- The coverage configuration excludes CLI and preflight source from coverage
  percentages. CLI behavior does have tests; the percentages are not whole-product coverage.
- Fixture pipeline baseline: **400 Acme projects, 449 Pulley projects;
  332 matched (83%), 18 review, 50 no-match**. Coverage of input rows is not precision.
- New failure probes reproduced all three findings below, using temporary
  directories and local fixture HTTP doubles. No live credentials or upstream
  requests were used. No GitHub workflow was executed during this audit.

Reproduce with:

```sh
node docs/audit-round-4/reproduce.mjs
```

The script asserts the observed defects. After fixes, convert these probes into
regression tests asserting the required behavior; do not retain tests that require a bug.

## Confirmed findings

### R4-01 — P1: unreadable history silently disables collapse protection

Evidence: `src/run/outputs.ts:255`, `src/run/quality.ts:54`,
and the call to `loadPreviousRun` in `src/run/sync.ts`.

`loadPreviousRun` returns the same `null` for a legitimate first run, invalid
pointer/record JSON, invalid record schema, missing referenced records, and read
failures. With `previous === null`, the quality gate only checks for zero-row
inputs and never compares the matched count or input counts against history.

Reproduction:

1. Publish the ordinary fixture snapshot: 449 Pulley projects, 332 matches.
2. Send a schema-valid snapshot containing one Pulley project. With healthy
   history, publication correctly fails with `QualityError`.
3. Corrupt the prior `run.json`, keeping its latest pointer. Send the same
   collapsed snapshot again. Publication succeeds, with **zero matches**, an
   empty blocker list, and no previous run in the diff. The latest pointer moves.
4. Invalid JSON, invalid schema, and a missing referenced `run.json` each
   reproduce this behavior. No `--accept-input-change` flag is supplied.

Impact: a damaged/restored/incomplete local state turns an abnormal upstream
snapshot into an apparently ordinary first run, hiding hundreds of lost matches.
The failure requires bad prior state; it does not occur in every normal run.

Required fix: distinguish absent initial state from corrupt or inaccessible
existing state. Fail publication with a typed diagnostic when a pointer exists
but its referenced baseline cannot be validated. Validate pointer/record identity
and the comparison fields required by that record version. Define an explicit,
auditable bootstrap/recovery procedure when history is genuinely unavailable.
Simply returning `null` or silently selecting another baseline is insufficient.

Acceptance: malformed pointer and record, missing referenced file, read failure,
record-ID mismatch, and absent required counts all refuse publication; a true
first run still works; healthy-history collapse checks still work; the prior
pointer and artifacts survive each rejected run.

### R4-02 — P2: artifact name and uploaded output can identify different runs

Evidence: `src/run/outputs.ts:54`, `.github/workflows/sync.yml:57`.

`updateLatest` first commits `latest.json`, then attempts to refresh the optional
`latest` symlink. All symlink errors are swallowed. The workflow names its artifact
using the JSON pointer but uploads `data/out/latest/`.

Reproduction: publish A, prepare B, and place a directory at `out/latest.tmp` so
the link replacement fails. `updateLatest(B)` returns success. `latest.json`
names B, while `latest/mapping.csv` still contains A. The workflow consequently
selects A's files for an artifact named B. This demonstrates path selection
locally; an actual GitHub upload was not performed.

Impact: on a symlink update failure with an existing link, consumers can receive
stale output labeled as the new result. With no old link, upload can instead fail.
The freshness command reads the JSON pointer and does not expose the divergence.

Required fix: make publishing and documented automation resolve the validated
run ID to its immutable output directory. Use that directory for upload. Report
symlink refresh failures as a warning; avoid making an optional alias authoritative.

Acceptance: simulate unavailable symlinks and stale links; uploaded path and
artifact name must identify the same run, and its `run.json` must agree.

### R4-03 — P2: offline replay requires unrelated live credentials

Evidence: `src/cli.ts:63` calls `loadConfig()` before deciding whether this is a
replay; `src/config.ts` requires all three live credentials. Replay acquisition
itself only reads archived files.

Reproduction: create a valid fixture archive, launch `node src/cli.ts sync
--replay <runId> --quiet` in a clean environment with `DATA_DIR` set and no live
credentials. The command exits **2**, requesting SiteLedger username/password
and the Pulley key, before inspecting the valid archive.

Impact: offline recovery, review on a clean machine, and credential-free CI replay
cannot use the advertised CLI without providing unnecessary or dummy credentials.
This is a recovery/usability defect, not evidence of an incorrect match. The API
level replay tests do not catch this CLI configuration boundary.

Required fix: validate local-only configuration for replay/dry-run, with types
that do not require live secrets; continue requiring credentials for live sync.

Acceptance: both offline CLI forms work with valid archives and no credentials;
missing/corrupt archives produce their archive errors; live sync still fails
clearly when credentials are missing.

## Readiness by area

| Area | Judgment | Evidence and remaining limit |
|---|---|---|
| Matching safeguards | 8/10 | Conservative ambiguity, explicit scope, identity quarantine, validated overrides, final invariants, and regression coverage. These cannot prove the selected real project is correct. |
| Accuracy evidence | 4/10 | Hand checks exist; no completed adjudicated expected-mapping set or independent holdout evaluation exists in `docs/adjudication/`. |
| Failure handling and publication | 7/10 | Typed errors, bounded retries, redirect refusal, staging, quality gates, and locks; R4-01 and R4-02 remain. |
| Traceability and recovery | 7/10 | Hashed inputs, implementation fingerprint, replay, retention, override provenance; R4-03 and unproven deployed restore remain. |
| Operations and ownership | 4/10 | Scheduler, status command, and runbook exist; named owners, independent missed-run detection, and demonstrated alert delivery are not established here. |
| Maintainability and testing | 8/10 | Small typed modules, clean checks, meaningful failure/concurrency tests and coverage gates. Existing tests missed these integration boundaries. |
| Security and resource limits | 6/10 | Credential exclusions, redirect refusal, CSV escaping, and dependency checks exist; deployment access/rotation and large-input limits need evidence. |

The overall rating gives extra importance to output correctness and detecting
silent operational failures; it is not an arithmetic average of these rows.

## What still gates unattended use

1. **Close R4-01 and R4-02, then make offline recovery work.** Add tests at the
   actual caller boundaries: full sync, CLI process, and workflow artifact path.
   Run lint, typecheck, and the full suite after changes.
2. **Establish decision accuracy independently.** The reference folder currently
   contains a README and template only. Have Permit Ops adjudicate all 18 current
   review rows and a stratified sample of matched and no-match rows. Include every
   matching tier, store renumbering, reused sequences, different banners,
   umbrella permits, signage, cancellation, absent dates, and conflicting identity.
   Hold out whole store groups or a later snapshot from tuning. Report false matches,
   false no-matches, unresolved cases, and sample sizes by tier. Agree the acceptable
   false-match risk with the Account Lead before using labels as a release gate.
3. **Measure review workload across time.** Eighteen review rows in one snapshot
   are not evidence that operations only need to check a few per week. During a
   supervised pilot, record newly unresolved rows, recurring rows, handling time,
   override reconfirmations, and erroneous automatic changes over repeated updates.
4. **Detect a job that never runs.** The only checked-in scheduled freshness check
   is inside the sync workflow and gated by `success()`. It cannot execute if that
   workflow never starts. Add an independently scheduled freshness/heartbeat check,
   with named operator and backup, and prove notification delivery by deliberately
   withholding a publication. Configure weekday/weekend expectations explicitly.
   The runbook currently overstates missed-publication notification assurance.
5. **Prove backup and recovery in the intended deployment.** The workflow caches
   `data` and uploads output artifacts, but no independent raw-archive backup and
   restore verification is configured here. Decide the retained source of truth;
   restore it onto a clean host, replay the exact code/dependencies/override state,
   and compare mapping bytes. Also rehearse dead-owner recovery, a stranded reclaim
   mutex, disk-write failure, and preservation of the last usable output. A local
   unit test or source hash is not evidence that the deployed backup is recoverable.
6. **Set and exercise operating limits.** HTTP timeouts and page-count limits exist,
   but response bodies are buffered with `arrayBuffer()` without a byte ceiling.
   Spreadsheet expansion, total rows, and total run memory have no demonstrated
   production envelope. Add appropriate byte/row limits and test expected peak load
   plus oversized inputs. This is an availability hardening gap; no out-of-memory
   event was induced during this audit.
7. **Confirm access and error-log handling.** Record who can retrieve raw reports,
   mappings, caches, and logs; credential rotation and retention responsibilities;
   and the allowed endpoint configuration. Configuration accepts general URLs,
   without requiring HTTPS, and upstream error messages reach CLI stderr verbatim.
   Test with synthetic secret-like error text and require sanitization where needed.
   These are observed hardening gaps, not a claim that credentials have leaked.

## Pilot and release approach

Start with an operator-supervised pilot against representative changing inputs.
Use the exact output directory identified by `latest.json`, check row counts and
diffs, and approve the mapping before downstream use. Keep the manual matching
process available while accuracy and review effort are measured.

The engineering fixes are bounded; the largest uncertainty is how long it takes
to obtain independent labels and observe enough real updates. A proposed pilot
window is one to two working weeks, extended if it does not include representative
changes. This is a validation proposal, not a delivery estimate or guaranteed
sufficient sample. Release only after the agreed accuracy/workload targets,
missed-run alert drill, and clean-host restore drill pass.

This review did not establish live API health, deployed scheduler reliability,
Linux filesystem behavior, measured production latency/memory, current dependency
advisories, host access controls, or a complete secret-history audit. The local
suite and reproductions support the findings above, not a claim that every possible
edge case or failure mode has been eliminated.
