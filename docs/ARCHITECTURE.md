# Architecture

## Data flow

```
SiteLedger portal ──login──▶ bearer token ──▶ 3 report downloads ─┐
                                                                  ├─▶ data/raw/<run>/
Pulley API ──X-API-Key──▶ cursor pagination ──▶ projects.json ────┘
        │
        ▼
  parse + validate (Zod)          sources/*
        │
        ▼
  normalize to canonical records  domain/normalize/*
        │
        ▼
  match (tiered, deterministic)   domain/match/*
        │
        ▼
  mapping.csv, review.csv, summary.txt, run.json   output/*
        │
        ▼
  data/out/<run>/  +  data/out/latest  (updated only on success)
```

## Modules

| Path | Responsibility | Status |
|---|---|---|
| `src/cli.ts` | commander entry, exit-code mapping | scaffold |
| `src/preflight.ts` | environment health check | done |
| `src/config.ts` | env parsing via Zod | done |
| `src/logger.ts` | pino with redaction | done |
| `src/errors.ts` | typed errors and exit codes | done |
| `src/sources/http.ts` | fetch wrapper: retries, timeouts, status-to-error mapping | done |
| `src/sources/siteledger/` | auth, report download, XLS/XLSX/CSV parsing | done |
| `src/sources/pulley/` | paginated client, response schema | done |
| `src/sources/vocab.ts` | unknown-value detection for categorical fields | done |
| `src/domain/model.ts` | canonical records, banner and type code tables | done |
| `src/domain/normalize/` | name parser, address normalizer, join into canonical records | done |
| `src/domain/match/` | compatibility rules, tiered matcher, reason codes | done |
| `src/output/` | CSV renderers, run diff, summary text | done |
| `src/run/archive.ts` | raw-input archive and replay | done |
| `src/run/acquire.ts` | live fetch or archive replay, parse, drift report | done |
| `src/run/lock.ts` | single-run lock with stale-owner reclaim | done |
| `src/run/outputs.ts` | atomic output directory, latest pointer, run record | done |
| `src/run/overrides.ts` | human decisions from overrides.csv, validated and applied | done |
| `src/run/quality.ts` | semantic input checks versus the previous run | done |
| `src/run/invariants.ts` | the publication boundary: hard rules over the combined result | done |
| `src/run/status.ts` | freshness of the last published result | done |
| `src/run/sync.ts` | the whole run in order; publication is the commit point | done |

Dependency direction is one way: `cli -> run -> (sources | domain | output)`.
`domain` imports nothing from `sources` or `output`; it works on plain typed
records so it can be tested without network or files.

## Boundaries and validation

Every byte that enters from outside is parsed through a Zod schema at the
boundary (`sources/*`). Inside the boundary, code works with the inferred
types and never re-checks. Unknown enum values (a new status, a new project
type) are accepted into an `other` bucket and logged at `warn` so that an
updated dataset degrades gracefully instead of crashing.

## Exit codes

Defined in `src/errors.ts`.

| Code | Class | Meaning |
|---|---|---|
| 0 | | Success |
| 1 | `Error` | Unexpected |
| 2 | `ConfigError` | Missing or invalid configuration |
| 3 | `AuthError` | Credentials rejected or session expired |
| 4 | `NetworkError` | Transport failure after retries |
| 5 | `SchemaError` | Upstream data shape changed |
| 6 | `LockedError` | Another run in progress |
| 7 | `IoError` | Filesystem failure |
| 8 | `QualityError` | Inputs schema-valid but empty or collapsed; nothing published |
| 9 | `StaleError` | `status`: nothing published, or result or source older than the limit |
| 10 | `InvariantError` | Combined result broke a hard rule; a tool defect; nothing published |

## Run artifacts

```
data/
  raw/<run-id>/            exact bytes downloaded (reports, API pages) for replay
  out/<run-id>/            mapping.csv, review.csv, decisions.csv,
                           pulley-unmatched.csv, summary.txt, run.json
  out/<run-id>.partial/    in-progress run; renamed to <run-id> only when complete
  out/latest.json          { "runId": ... } of the last successful run
  out/latest -> <run-id>   convenience symlink where the filesystem allows it
  .lock                    present while a run is active; holds the owner pid
  overrides.csv            optional human decisions, applied after matching
```

`run.json` (format version 2) records the tool version, rules version,
implementation SHA-256 (source files, package metadata, dependency lockfile),
input counts and per-file SHA-256 hashes, the non-secret configuration, the
input-quality assessment, the overrides file hash and the matcher's decision
for every overridden row, and every decision with its evidence. The previous
run's record feeds the diff, the review-workload line, and the input-quality
comparison. A failed run never touches `latest.json`. Retention runs after
publication and its failure is reported, never fatal.

`run-id` is an ISO timestamp in UTC. `--dry-run` reads the newest `raw/`
directory instead of contacting either system, so matching logic can be
iterated offline and reproduced exactly.

## Toolchain

- Node 26 executes TypeScript directly (type stripping). No build step to run.
- TypeScript 7 (`tsc --noEmit`) is the type gate. See `docs/adr/0001`.
- Biome is the single lint and format tool. See `docs/adr/0002`.
- SheetJS is vendored. See `docs/adr/0003`.
- Vitest runs unit tests against real downloaded fixtures.
