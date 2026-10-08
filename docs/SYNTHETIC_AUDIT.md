# Synthetic edge-case audit — rules 2026-10-08.7

> Historical results for rules 2026-10-08.7. The seven automatic acceptance
> regressions remain covered. Rules .8 allow explained human overrides of soft
> street/milestone discrepancies and narrow the yearless hold; see
> `REVIEW_FOLLOWUP.md` for current behavior and counts.


This audit runs locally without contacting upstream systems or changing the
published mapping. Seven new counterexamples were reproduced against the
preceding implementation. Each was automatically accepted and passed the
publication checks. They now withhold the unsafe match; overrides and forced
publication attempts are covered by regression tests.

| Case | Previous failure | Correction |
|---|---|---|
| Multiple explicit stores | `Store 1556 / Store 2666 Remodel 2027` matched store 1556 when 2666 was absent from the register | Every named store must be this building's current or verified former number |
| Bracketed signage | `[Signage] 1556.1002 Reno NV 2027` lost the exclusion hint | Bracket prefixes remain part of evidence extraction |
| Bracketed year | `[2025] 1556.1002 Reno NV 2027` lost the conflicting year | Both year signals survive and trigger review |
| Building designators | Building A and Building B at the same base address collapsed to one key | Preserve building IDs, including prefix forms before the house number |
| Street-name words | `100 North Street` collapsed into `100 N Street` | Normalize suffixes and directions by position; preserve proper-name words |
| Future years | `Remodel 2040` was treated as store 2040, allowing a 2027 project to match | Bare years in the supported 2000–2100 range cannot establish store identity; explicit store markers remain usable |
| Acme source disagreement | An Acme name saying 2025 matched using its structured 2027 field | Name/structured ID and year contradictions remain disputed, even without a Pulley candidate |

## Generated scenarios

`tests/synthetic-edge-cases.test.ts` uses deterministic seed `0x50554c4c`:

- 96 valid exact-ID controls with varied IDs, years, organizations, and states.
- 12 deliberate invalid mutations per control: wrong state or organization,
  Pathfinder, signage, cancellation, unknown lifecycle, bracketed signage/year,
  an additional unrelated store, wrong year, canceled marker, incompatible type.
- Every case runs in forward and reverse register/candidate order, with an
  unrelated valid project present. Its correct assignment must survive.
- Total: 1,152 invalid scenarios plus 96 controls; 2,496 generated matcher
  executions across the two orders. All satisfy the independent expected outcomes.
- Direct counterexamples also attempt matched overrides and forced publication
  using automatic and override reason codes. All unsafe attempts are rejected.
- Positive boundary controls cover verified former-store aliases, building-label
  spelling/position variants, and marked store numbers in the program-year range.

Expected outcomes are based on the deliberately generated facts, not calculated
using the matcher's own compatibility predicates. This is a finite adversarial
suite; it does not establish 100% correctness on arbitrary real records.

## Real-data regression check

Replayed archive `2026-10-08T19-21-15-120Z` without network or publication:

- 309 matched, 41 needs_review, 50 no_match.
- Mapping CSV byte-identical to the preceding live publication.
- Publication pointer unchanged.
- Local verification metadata: `data/audits/synthetic-edges/verification.json`.

All 377 tests across 27 files pass; lint and typecheck pass. No new dependency
was needed. Rule version increased from 2026-10-08.6 to 2026-10-08.7.

Reproduce:

```sh
pnpm exec vitest run tests/synthetic-edge-cases.test.ts
pnpm lint
pnpm typecheck
pnpm test
```

Unadjudicated source errors, ambiguous free-text addresses, unknown future naming
formats, and legitimate large schedule changes still require independent permit
evidence and review. Passing this audit is not a production accuracy estimate.
