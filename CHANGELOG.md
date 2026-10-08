# Changelog

## Review follow-up — 2026-10-08

- Pin pnpm setup to its commit target; retain customer output on approved host/backup storage instead of GitHub artifacts.
- Narrow yearless holds to ambiguous ownership; allow explained human overrides of street/milestone discrepancies while preserving hard constraints. Rules version 2026-10-08.8.
- Index safety ownership and exact-ID/store candidate paths; add a reproducible synthetic benchmark.
- Document first-run crash recovery without deleting history, restore safe network cause codes, use freshness exit 9 for future timestamps, and reject empty evaluation populations explicitly.
- Add 27 regressions (404 tests total); offline replay produces 324 matched, 26 review and 50 no-match. Existing publication unchanged; historical reports labeled and current documentation aligned.


All notable changes to this project. Format follows Keep a Changelog.

## [Unreleased]

### Synthetic edge-case audit — rules 2026-10-08.7

- Reproduced and fixed seven new unsafe acceptances: stripped bracket signage
  and year evidence, extra named buildings absent from the register, building
  designators removed from addresses, street-name words treated as directions,
  future years treated as store numbers, and conflicting Acme name/year facts.
- Add deterministic mutation tests: 1,152 invalid scenarios and 96 valid controls,
  each in both input orders, plus direct override/publication bypass checks.
- Preserve verified former-store aliases and valid building spelling variants.
  Test results do not imply perfect accuracy on unadjudicated real data.

### Recurring review workflow

- Add a hashed `review-changes.csv` output for new or changed review evidence
  since the previous run; retain the entire backlog in `review.csv`.
- Persist stable evidence fingerprints in run records; legacy baselines surface
  existing review rows once. Separate removed projects from resolved reviews.
- Explain initial versus ongoing review workload and the deployment activation
  boundary. No accuracy or weekly workload guarantee is implied.

### Precision safeguards — rules 2026-10-08.6

- Withhold conflicting identity/year/milestone/marker evidence across matching,
  overrides, and publication. Missing temporal evidence requires review unless
  a trusted full ID establishes the site/year.
- Preserve explicit owners even when their provisional match is withheld;
  reject conflicting address/date ownership and unresolved store-number reuse.
- Remove score-based assignment across buildings/years without a strong anchor.
- Replay moves 23 prior acceptances to review: 309 matched, 41 review, 50 no match.
  Regression cases cover the six audit counterexamples and bypass attempts.
- Withdraw unmeasured accuracy estimates. No 100% accuracy claim; independent
  adjudication and holdout evaluation remain required.

### Added and fixed — 0.2.0 (matching rules unchanged)

- Fail closed on damaged history, use verified immutable output paths in automated
  consumers, and permit offline replay without live credentials (round-four fixes).
- Version 3 records, output hashes, captured overrides, verified portable backups
  including implementation bytes, and non-overwriting restoration into a new directory.
- Independent-label evaluation and schedule-aware publication/source monitoring.
- Streamed HTTP byte ceilings, report/ZIP expansion and row limits, HTTPS-only
  production configuration, and static safe error descriptions.
- Opt-in persistent-host scheduling with protected backups and an external success
  heartbeat. Removed customer data from Actions caches. Pinned action commits,
  added Dependabot and Linux/macOS CI. Activation requires DEPLOYMENT.md setup.
- Regression and restore drills in tests/audit-round-4.test.ts; synthetic capacity
  probe in scripts/benchmark.mjs. No live deployment or accuracy sign-off implied.

### Fixed — 0.1.1, rules 2026-10-08.5

- Round-three findings: disputed joins and duplicate source evidence remain
  in review; conflicting Pulley versions refuse the snapshot; stale overrides
  are rejected and conflict withdrawal converges for arbitrary batch sizes.
- Recovery mutexes never expire; release is token-checked and idempotent.
  Unsupported locking filesystems fail closed with a clear error.
- Authenticated redirects are refused. Retry-After is honored within a bounded
  wait budget, and cancellation stops retries.
- Collision-free internal archive filenames preserve upstream names as metadata.
  Duplicate writes, unsafe paths, damaged manifests, and size/hash mismatches
  fail explicitly. Cleanup errors preserve primary failures and published state.
- Run provenance includes an implementation content hash; CLI and run records
  share the package version. Regression coverage: tests/audit-round-3.test.ts.

### Added

- Round-two audit response: anchors must agree (`YEAR_CONFLICT` otherwise),
  reclaim-mutex lock recovery, credential-free `status` with source-data age
  (`--max-source-age-hours`), disputed identity held for review
  (`IDENTITY_DISPUTED`), override temporal and assignment checks, final
  publication invariants (exit 10), order-independent register duplicates,
  acceptance from the best decisive score, known-scope requirement,
  retention protecting referenced archives, collision indexes scoped by
  banner and state. Regression tests in tests/audit-round-2.test.ts.

- Readiness pass: acceptance separated from ranking (soft-corroboration ties
  go to review), order-invariant assignment resolution, one scope rule shared
  by forward, reverse, and override checks, conflicting-duplicate quarantine,
  input-quality gate with `--accept-input-change` (exit 8), run.json v2
  provenance (rules and tool versions, input hashes, config, overrides hash
  and pre-override decisions), `--replay <runId>` with hash verification,
  `status --max-age-hours` (exit 9), review evidence columns and recommended
  actions, tracked `overrides.csv` with author and date, preflight tarball
  hash check, coverage thresholds and dependency advisories in CI, artifacts
  named by run id, adjudication template. 237 tests.

- Audit response: register-wide assignment pass (the full id in the name pins
  the year), locality guard on full ids whose store number identifies two
  buildings, house-number requirement and shared-street guard for addresses,
  override reconfirmation against banner, state, and the status gate,
  millisecond run ids with exclusively created directories, link-and-rename
  lock protocol, one dedupe path for live and replay, temporal filter on the
  date tier, state-scoped reverse checks, explicit status lifecycle with
  `STATUS_UNKNOWN`, body-inclusive HTTP retries, formula escaping on
  human-facing CSVs, trimmed categorical fields, artifact upload only on
  success. 218 tests.

- Edge-case and performance pass: year-conflict post-pass (`YEAR_CONFLICT`),
  exact ids on the other banner or state surfaced as `ID_OUTSIDE_SCOPE`,
  status drift reported per matched row and in the summary, banner fallback
  from the canonical name when a site is missing, city agreement for shared
  street keys, status spelling variants, run retention (`RETAIN_RUNS`),
  memoized uniqueness checks (10x data: 2.1 s to 0.9 s), quieter default
  logs, and a double-click `sync.command` launcher for macOS.

- Phase 5 validation: hand check of a stratified sample (docs/VALIDATION.md)
  led to temporal evidence (date proximity to Key Dates, year verdicts),
  exclusion of other-year store candidates, a locality guard for store
  numbers shared by two buildings, exact dates as a tie-breaker, and a new
  dates-plus-locality tier. 336 matched, 12 needs_review, 52 no_match.

- Phase 4 outputs: `mapping.csv` with the exact required columns,
  `review.csv`, `decisions.csv` with evidence, `pulley-unmatched.csv`,
  `summary.txt` with a diff against the previous run, and `run.json`.
  Outputs are written to a partial directory and renamed atomically;
  `latest.json` moves only on success. Single-run lock with stale-owner
  reclaim. `pnpm sync` now runs the whole pipeline and prints the summary.

- Phase 3 matcher: deterministic five-tier matching (exact id, store,
  sequence plus locality, exact address, weak evidence) with evidence
  scoring, type compatibility for umbrella permits, former-location-number
  support, the canceled-on-both-sides status gate, live-over-canceled
  tie-breaking, and stable reason codes for every decision. On the
  2026-10-08 dataset: 349 matched, 17 needs_review, 34 no_match.

- Phase 2 normalization: canonical `AcmeProject`, `AcmeSite`, and
  `PulleyRecord` models; project-name parser that extracts full ids, store
  numbers, sequences, years, canonical `STORE.SEQ-CITY-ST-BANNER-TYPE-YEAR`
  structure, and status decorations from all 116 observed name shapes;
  street-address normalizer (suffixes, directionals, units, venue prefixes)
  that lifts exact-address hits from 169 to 256 of 299; join of the Project
  Register to the Site Directory and Key Dates with warnings for join gaps.

- Phase 1 acquisition: HTTP client with retry, timeout, and typed error
  mapping; SiteLedger sign-in and report download; parsers for the BIFF8
  Project Register, the XLSX Site Directory, and the Key Dates CSV with
  strict headers and row validation; paginated Pulley client with cursor-loop
  and page-cap guards; raw-input archive with manifest and `--dry-run`
  replay; vocabulary drift reporting for categorical fields. Tests run
  against the real downloaded reports as fixtures.

- Phase 0 scaffold: Node 26 native TypeScript execution, TypeScript 7 strict
  config, Biome, Vitest, Zod-validated configuration, pino logger with
  redaction, typed errors with stable exit codes, `preflight` health check,
  commander CLI skeleton with a `sync` stub.
- Documentation: `AGENTS.md` handoff (with `CLAUDE.md` import), `README.md`
  for Permit Ops and engineers, `docs/BRIEF.md` (redacted task),
  `docs/ARCHITECTURE.md`, `docs/MATCHING.md` specification, ADRs 0001 to 0005.
- CI workflow running lint, typecheck, and tests on push and pull request.
- Vendored SheetJS 0.20.3 tarball.
