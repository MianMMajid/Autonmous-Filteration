# Changelog

All notable changes to this project. Format follows Keep a Changelog.

## [Unreleased]

### Added

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
