# Changelog

All notable changes to this project. Format follows Keep a Changelog.

## [Unreleased]

### Added

- Phase 0 scaffold: Node 26 native TypeScript execution, TypeScript 7 strict
  config, Biome, Vitest, Zod-validated configuration, pino logger with
  redaction, typed errors with stable exit codes, `preflight` health check,
  commander CLI skeleton with a `sync` stub.
- Documentation: `AGENTS.md` handoff (with `CLAUDE.md` import), `README.md`
  for Permit Ops and engineers, `docs/BRIEF.md` (redacted task),
  `docs/ARCHITECTURE.md`, `docs/MATCHING.md` specification, ADRs 0001 to 0005.
- CI workflow running lint, typecheck, and tests on push and pull request.
- Vendored SheetJS 0.20.3 tarball.
