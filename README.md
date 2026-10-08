# SiteLedger Sync

Matches Acme's SiteLedger projects to Pulley projects so Permit Ops no longer
lines them up by hand every Monday. One command, run as often as you like.

## For Permit Ops

**One-time setup** (ask engineering if any step is unclear):

1. Install Node.js 26 or newer from nodejs.org.
2. Open a terminal in this folder.
3. Copy `.env.example` to `.env` and paste in the SiteLedger username and
   password and the Pulley API key.
4. Run `npm i -g pnpm@10`, then `pnpm install`, then `pnpm preflight`.
   Every line should say `ok`.

**Each run:** double-click `sync.command` (macOS), or in a terminal:

```sh
pnpm sync
```

Outputs land in `data/out/<timestamp>/`. `pnpm cli published-path` prints the
verified directory for the current result. `latest` is a convenience link only:

| File | What it is |
|---|---|
| `mapping.csv` | The deliverable. One row per Acme project: `acme_pcroject_id,pulley_project_id,status` |
| `review.csv` | Only the `needs_review` rows, with the reason, a note, and the top candidates |
| `decisions.csv` | Every row with its evidence, for audit |
| `pulley-unmatched.csv` | Pulley projects nobody claimed |
| `summary.txt` | Counts, what changed since the previous run, the review list, status differences |
| `run.json` | Provenance and decisions used for the next run’s quality gate and diff |
| `output-manifest.json` | SHA-256 and byte length for every output |
| `overrides.snapshot.csv` | Exact override input for replay and recovery |

The summary is also printed to the terminal at the end of each run.

The `status` column is one of `matched`, `needs_review`, or `no_match`.

**If it fails**, the last line tells you which system had the problem:

| Exit code | Meaning | What to do |
|---|---|---|
| 2 | Configuration | Check `.env`; run `pnpm preflight` |
| 3 | Authentication | SiteLedger or Pulley rejected the credentials |
| 4 | Network | Retry; if persistent, check whether the sites are up |
| 5 | Data shape changed | A report or API field changed; contact engineering |
| 6 | Already running | Wait for the other run to finish |
| 7 | Disk | Output folder not writable or disk full |
| 8 | Inputs look wrong | An export came back empty or collapsed versus last time; nothing was published |
| 9 | Stale | From `pnpm cli status`: nothing published, or the result or its source data is older than the limit |
| 10 | Tool defect | The result broke a hard rule; nothing was published. Contact engineering |

A failed run never overwrites the previous good output.

**Is the result current?** `pnpm cli status --max-age-hours 24` says when
the last result was published and whether it is older than a day.

**Settling a review row.** Once your team decides, add one line to
`overrides.csv` in this folder and it will not come back:

```
acme_project_id,pulley_project_id,status,note,author,decided_at
3716.1005,prj_ae5zai,matched,confirmed with the lead,J. Lee,2026-10-09
```

More in `docs/OPERATIONS.md`, including how to run it on a schedule.

## For engineers

See `AGENTS.md` for setup and gates, `docs/ARCHITECTURE.md` for the data
flow, and `docs/MATCHING.md` for the matching rules.

```sh
pnpm verify        # preflight, lint, typecheck, tests
pnpm test:watch
pnpm lint:fix
```

Stack: Node 26 (native TypeScript execution), TypeScript 7, Biome, Vitest,
Zod, commander, pino, SheetJS (vendored), csv-parse/csv-stringify.

## Project status

Phases 0 to 4 complete: toolchain, docs, acquisition with raw archiving and
offline replay, normalization, matching, and outputs with run-to-run diffs.
The core workflow is implemented; unattended production release still requires
independent accuracy labels, deployment configuration, alert delivery, and a
restore drill. See `docs/DEPLOYMENT.md`. Validation is in `docs/VALIDATION.md`, operations
in `docs/OPERATIONS.md`, and the submission notes in `docs/SUBMISSION.md`. See
`CHANGELOG.md`.
