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

## Executable evaluation (0.2.0)

```sh
pnpm cli evaluate <output-run-id> docs/adjudication/expected-mapping.csv
```

Outputs JSON with label coverage, resolved/unresolved counts, automatic-match
precision, false no-match rate, disagreements, and breakdowns by tier and reason.
Counts and denominators accompany rates; no evaluated automatic matches gives
`precision: null`, never 100%. Overrides are excluded from automatic accuracy.
Review decisions are reported separately and are not counted as false automatic
matches. No labels are written into production overrides or changed by evaluation.

All seven template columns are required in that order. Every row requires a
reviewer, valid decision date, source archive run ID, and rationale. Matched truth
requires one or more allowed IDs; no-match truth requires none. Duplicate IDs,
unknown Acme projects, malformed labels, and labels for a different source snapshot
fail with exit 5. `source_run_id` means the archive ID, which can differ from a
replay's output ID. The template intentionally fails validation until adjudicated.

These descriptive metrics do not certify an independently selected holdout or
statistical precision. Reviewers must document sampling and correlated store
families, agree thresholds before evaluation, and adjudicate unseen data. This
repository still contains no completed ground-truth set or production sign-off.
