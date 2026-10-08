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
| `src/domain/normalize/` | name parser, address normalizer, canonical records | phase 2 |
| `src/domain/match/` | candidate pool, tiers, reason codes | phase 3 |
| `src/output/` | CSV writers, summary, run diff | phase 4 |
| `src/run/archive.ts` | raw-input archive and replay | done |
| `src/run/acquire.ts` | live fetch or archive replay, parse, drift report | done |
| `src/run/` (lock, outputs) | lock file, output directory, latest pointer | phase 4 |

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

## Run artifacts

```
data/
  raw/<run-id>/      exact bytes downloaded (reports, API pages) for replay
  out/<run-id>/      mapping.csv, review.csv, summary.txt, run.json
  out/latest -> out/<run-id>   symlink, moved only after a successful run
  .lock              present while a run is active
```

`run-id` is an ISO timestamp in UTC. `--dry-run` reads the newest `raw/`
directory instead of contacting either system, so matching logic can be
iterated offline and reproduced exactly.

## Toolchain

- Node 26 executes TypeScript directly (type stripping). No build step to run.
- TypeScript 7 (`tsc --noEmit`) is the type gate. See `docs/adr/0001`.
- Biome is the single lint and format tool. See `docs/adr/0002`.
- SheetJS is vendored. See `docs/adr/0003`.
- Vitest runs unit tests against real downloaded fixtures.
