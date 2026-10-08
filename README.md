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

**Each run:**

```sh
pnpm sync
```

Outputs land in `data/out/latest/` (every run also keeps its own
`data/out/<timestamp>/` folder):

| File | What it is |
|---|---|
| `mapping.csv` | The deliverable. One row per Acme project: `acme_pcroject_id,pulley_project_id,status` |
| `review.csv` | Only the `needs_review` rows, with the reason, a note, and the top candidates |
| `decisions.csv` | Every row with its evidence, for audit |
| `pulley-unmatched.csv` | Pulley projects nobody claimed |
| `summary.txt` | Counts, what changed since the previous run, the review list |
| `run.json` | Machine-readable record used for the next run's diff |

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

A failed run never overwrites the previous good output.

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
Phase 5 validation is in `docs/VALIDATION.md`. Remaining: scheduling and
submission notes. See
`CHANGELOG.md`.
