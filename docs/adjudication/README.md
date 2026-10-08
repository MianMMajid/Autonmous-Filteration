# Adjudicated expected mappings

The accuracy figures in `docs/VALIDATION.md` and `docs/SUBMISSION.md` rest on
a hand check by the author. They are not a measured precision. This folder
is where an adjudicated reference set lives once Permit Ops has reviewed
rows with knowledge of the real projects.

## What to record

`expected-mapping.csv`, one row per Acme project that has been adjudicated:

| Column | Meaning |
|---|---|
| `acme_project_id` | `store.sequence` |
| `expected_status` | `matched`, `no_match`, or `unresolved` (reviewer could not decide) |
| `allowed_pulley_ids` | One or more Pulley ids separated by `;` that would all be correct (several Acme lines may share one permit; duplicates in Pulley may both be acceptable) |
| `reviewer` | Who decided |
| `decided_at` | ISO date |
| `source_run_id` | The run whose archived inputs the reviewer looked at, so the decision can be reproduced against the same bytes |
| `rationale` | One sentence |

Keep this file separate from `overrides.csv`. Overrides change what the tool
publishes; this file measures the tool and must not feed back into it.

## How to use it

1. Adjudicate a stratified slice: every tier, every review reason, and a
   sample of no_match rows. Include renumbered stores, missing dates,
   cancellations, jurisdiction differences, and duplicates on purpose.
2. Run `pnpm sync --replay <source_run_id> --quiet` to reproduce the tool's
   decisions on the same inputs.
3. Compare `data/out/latest/decisions.csv` with this file. Report, by tier
   and by reason: precision among auto-matched rows, coverage, false
   no_match rate where truth is known, and review workload. State sample
   sizes.
4. Hold out a later snapshot or a set of whole store groups for evaluation;
   never tune on the rows you evaluate on.

A template is in `expected-mapping.template.csv`.
