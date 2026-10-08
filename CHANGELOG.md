# Changelog

All notable changes to this project. Format follows Keep a Changelog.

## [Unreleased]

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
