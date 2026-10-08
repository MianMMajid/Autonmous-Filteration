# Review follow-up — rules 2026-10-08.8

Reviewed against local commit `3771332`. The safety and synthetic changes cited
as uncommitted in the supplied review were already committed at that point.

## Findings and resolutions

1. **Action pin confirmed.** `git ls-remote` on the pnpm repository reports
   `f40ffcd9367d9f12939873eb1018b921a783ffaa` as the annotated v4 tag and
   `b906affcce14559ad1aafd4ab0e942779e9f58b1` as its peeled target. Both workflows
   now use the latter with `# v4`. This follows
   [GitHub's full commit SHA guidance](https://docs.github.com/en/actions/reference/security/secure-use#using-third-party-actions).
2. **Temporal over-withholding confirmed.** Yearless matching may now pass when
   a site has exactly one Acme project and exactly one compatible candidate
   identified by store number. Additional compatible address, sequence or date
   candidates remove the exception. Multiple Acme lines still require evidence
   of the permit year, preserving the brief's same-store/same-year fold rule.
   Jurisdiction differences remain acceptable. The change is applied equally at
   the matcher and publication boundary, not just during candidate ranking.
3. **Override escape hatch restored for soft evidence.** A note explaining the
   checked permit evidence permits a street-name or milestone discrepancy,
   including cross-calendar-year dates. Automatic matching still withholds these
   pairs. Explicit program-year/identity contradictions, another registered
   owner, incompatible work, scope/status/exclusions and cross-building/year
   assignment remain blocked. Author/date provenance remains available. Historical
   tests now distinguish automatic acceptance from explained human decisions.
4. **First-run crash recovery documented and tested.** A missing pointer cannot
   safely distinguish a bootstrap crash from damaged established history. The
   CLI therefore continues to fail closed, but its diagnostic now points to the
   first-run recovery procedure in `DEPLOYMENT.md`: stop writers, establish that
   no successful publication ever existed, preserve the failed DATA_DIR, and
   perform a supervised fresh sync and backup in an unused persistent directory.
   No orphan is silently accepted, no history is deleted, and no nonexistent
   snapshot is required. Tests cover partial and complete orphan output state.
5. **Network diagnostics restored safely.** An explicit allowlist reports DNS,
   connection and TLS codes, including nested and aggregate causes. Raw error
   messages, URLs and arbitrary custom codes remain excluded. Cyclic causes are
   bounded. Timeout and abort names retain their existing treatment.
6. **Register-wide safety scans removed.** Per-run indexes select relevant
   ownership records by site, full ID, store, address and locality; no cache
   survives input changes. Exact-ID/store candidate tiers and final target lookup
   also use indexes, avoiding the broad lower-tier scans on the common path.
7. **Smaller items.** Future source/publication timestamps now yield freshness
   exit 9 through both `status` and `monitor`. Empty evaluation populations have
   an explicit error. The reported NaN was not reachable through a valid label
   file before this fix: empty labels already failed validation, and a nonempty
   label cannot reference an empty population. Historical readiness and synthetic
   reports are marked as such, and current submission/matching docs agree.
   The scheduled workflow no longer uploads customer CSVs or run records to
   GitHub artifacts; verified backups stay on approved storage.

## Replay and regression evidence

Read-only replay of archive `2026-10-08T19-21-15-120Z`:

| Outcome | Rules .7 | Rules .8 |
|---|---:|---:|
| Matched | 309 | 324 |
| Needs review | 41 | 26 |
| No match | 50 | 50 |
| Evidence-conflict holds | 7 | 7 |
| Insufficient-evidence holds | 20 | 5 |

All 15 changes are review-to-match transitions for unique store candidates.
Previously matched targets and no-match outcomes are unchanged. Publication
invariants pass; the existing published pointer is unchanged. Replay details
are retained locally in ignored `data/audits/review-followup/replay.json`.

The regression suite passes **404 tests in 28 files**, including the earlier
2,496 generated adversarial/control executions. Added cases exercise singleton
and multi-project sites, competing candidates, explained overrides, hard blocks,
indexed ownership, bootstrap recovery, future-clock exit codes and diagnostics.
Coverage checks pass: 92.85% statements, 87.45% branches, 95.7% functions and
94.75% lines. These percentages describe executed code, not match correctness.

## Performance reproduction

Run `node scripts/benchmark-matching.ts` on Node 26. It creates synthetic records
only and reports medians of three runs, excluding fixture construction. Each run
must match every expected owner and pass publication invariants. The same script
was run against an isolated copy of `3771332` and the working tree.

Illustrative local 4,000-project medians, milliseconds:

| Scenario | Previous matcher | Current matcher | Previous publication checks | Current checks |
|---|---:|---:|---:|---:|
| Exact ID | 3151 | 31 | 1530 | 15 |
| Store number + year | 2931 | 22 | 1619 | 11 |

Local runtime and system load affect these timings; they are not an SLA. The
common path scales with input/index size. Large ambiguity groups and fallback
sequence/address/date searches can still require broad scans; this benchmark
does not establish worst-case linear complexity for every dataset.

## Remaining release evidence

The 26-row initial backlog still needs onboarding review. The restored matches
need independent permit adjudication before claiming precision; the brief's
small ongoing weekly workload must be measured on fresh snapshots. Live
scheduler, backup restore and independent-alert drills still require the
provisioned deployment environment. This change does not activate deployment,
publish a new customer mapping, or claim 100% accuracy.
