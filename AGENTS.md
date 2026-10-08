# AGENTS.md

Operational handoff for coding agents and new engineers. Short on purpose: only
what you cannot infer from the code. Background lives in `docs/`.

## What this is

A CLI that matches Acme's SiteLedger projects to Pulley projects and writes
`mapping.csv` (columns `acme_pcroject_id,pulley_project_id,status`) plus a
review file explaining every uncertain row. Full task statement: `docs/BRIEF.md`.
Matching rules: `docs/MATCHING.md`. Module layout: `docs/ARCHITECTURE.md`.

## Setup (run in order)

```sh
node --version          # must be v26 or newer
pnpm --version          # 10.x; `npm i -g pnpm@10` if missing
cp .env.example .env    # then fill SITELEDGER_USERNAME, SITELEDGER_PASSWORD, PULLEY_API_KEY
pnpm install
pnpm preflight          # every line must say ok
pnpm verify             # preflight + lint + typecheck + tests, all must pass
```

Credentials come from the person who handed you this repo. Never commit `.env`.

## Run

```sh
pnpm sync               # full run; prints the summary; outputs under data/out/<timestamp>/
pnpm sync --dry-run     # re-match the last archived inputs, no network
pnpm sync --quiet       # no summary on stdout (logs still go to stdout as JSON)
pnpm sync --replay <id> # replay one archived run by id
pnpm cli status --max-age-hours 24   # freshness; exit 9 if stale
pnpm cli --help
```

## Before you say a change is done

Run all three. A change that fails any of them is not done.

```sh
pnpm lint
pnpm typecheck
pnpm test
```

`pnpm lint:fix` auto-fixes formatting and import order.

## Gotchas you cannot infer from the code

- Node runs `.ts` directly and ignores `tsconfig.json` at runtime. No `enum`,
  no constructor parameter properties, no decorators. `tsc` enforces this via
  `erasableSyntaxOnly`.
- Relative imports must include the `.ts` extension. Type-only imports must use
  `import type`.
- `xlsx` (SheetJS) is installed from `vendor/xlsx-0.20.3.tgz`, not npm. The npm
  package is frozen and has advisories. Do not "upgrade" it via npm.
- TypeScript 7 has no programmatic API. Do not add ESLint or typescript-eslint;
  Biome handles lint and format.
- `tsconfig.json` is `noEmit`. `tsconfig.build.json` emits to `dist/` if a
  compiled artifact is ever needed.
- Secrets never go in code, tests, fixtures, or log fields. The logger redacts
  common key names as a backstop only.
- The Key Dates CSV mixes `MM/DD/YYYY` and `YYYY-MM-DD` in the same column.
  `reportDateSchema` accepts both on purpose; do not narrow it.
- `overrides.csv` at the repo root (tracked) replaces matcher decisions with
  human ones; it is re-validated against banner, state, and the status gate on
  every run. `data/` is ignored and holds only run artifacts.
- `run.json` is format version 3 with provenance (rules version, implementation
  content hash, input hashes, overrides hash). Bump `RULES_VERSION` in `matcher.ts` when a rule
  or weight changes.
- Run ids include milliseconds and run directories are created exclusively;
  never add code that deletes or reuses an existing run directory.
- Lock records are published by atomic hard links. Dead main-lock owners are
  reclaimed under a non-expiring recovery mutex. Never steal that mutex by
  age: suspended owners can resume. An abandoned `.lock.reclaim` requires
  stopping all sync processes and verifying none can resume before removal.
  Filesystems without hard-link support fail closed. Release checks owner tokens.
- `src/run/invariants.ts` is the publication boundary; every path that can
  change a decision (matcher, assignment pass, overrides) is checked there.
  Add new hard rules to it, not only to the path that first needs them.
- Local commands (status, monitor, replay, backup, restore, evaluate) never require
  upstream credentials. Existing damaged history fails closed; only empty output
  history is a bootstrap. Never treat an unreadable baseline as a first run.
- Version 3 outputs have a required hash manifest. All consumers resolve the JSON
  pointer and verify the immutable directory; the symlink is never authoritative.
- Scheduled deployment is opt-in on a trusted persistent host; see
  `docs/DEPLOYMENT.md`. Never reintroduce customer reports into Actions caches.
- Ties in the matcher go to `needs_review`, never to a guess. See `docs/adr/0004`.
- `docs/brief/` is gitignored because the original PDF contains live credentials.

## Where to look

| Need | File |
|---|---|
| Task statement, redacted | `docs/BRIEF.md` |
| Matching tiers, reason codes | `docs/MATCHING.md` |
| Data flow, modules, exit codes | `docs/ARCHITECTURE.md` |
| Why a tool or rule was chosen | `docs/adr/` |
| Running on a schedule, reading results, overrides | `docs/OPERATIONS.md` |
| Hand check and match-rate estimate | `docs/VALIDATION.md` |
| What to submit and the message to the lead | `docs/SUBMISSION.md` |
| What changed | `CHANGELOG.md` |
