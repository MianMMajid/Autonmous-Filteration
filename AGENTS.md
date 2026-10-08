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
- `data/overrides.csv` (optional) replaces matcher decisions with human ones
  and is validated on every run; see `docs/OPERATIONS.md`.
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
