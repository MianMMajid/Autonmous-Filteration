# Submission notes

## Current mapping and handoff

The latest verified publication is **2026-10-08T20-23-30-750Z**, rules .10,
with **324 matched, 26 review, 50 no-match**. Source data was acquired at
**2026-10-08T20:23:32.271Z**. Rules .12 replay the same mapping byte-for-byte
([signage validation](SIGNAGE_VALIDATION.md)) in an isolated audit directory; the main
publication pointer remains on .10. A fresh .11 audit fetch also confirmed the same
records at 2026-10-08T20:44:55.343Z.

Use `pnpm cli published-path` to resolve the currently verified publication,
and submit its `mapping.csv`, `review.csv` and generated `handoff.md` together.
The exact CSV header is `acme_pcroject_id,pulley_project_id,status`.
Each new run generates a matching handoff; do not copy older counts into it.
No Account Lead message has been sent.

The notes below preserve the **historical .9 assessment**, publication
`2026-10-08T20-01-47-980Z`. Its 50 sampled decisions remain unchanged in .10,
but that is not independent validation of the newly accepted row or of rules .11.
Use the source-record review as qualified background, not measured current accuracy.

## Historical .9 coverage and estimated correctness

The .9 snapshot had **323 matches, 27 review rows and 50 no-matches** out
of 400 rows: **80.75% automatic coverage**, with no applied human overrides.

For the brief's requested estimate of the share we think is right, the
implementer's 50-case source-record review gives a provisional **about 90% of
resolved outcomes supported** (including no-matches), after weighting strata
and counting unresolved sampled cases as unsupported. See the linked review
for every case, selection method and denominators. Four sampled cases need
permit-level confirmation, including two accepted umbrella matches with
plausible dedicated alternatives. This is a subjective estimate from supplied
records, not independent adjudication, measured production accuracy, or proof
of zero false positives. The 27 review abstentions are excluded from its
resolved-outcome denominator. A strict all-400 denominator gives 84.2% supported.

Earlier unsubstantiated precision claims remain withdrawn. Independent permit
labels, separate from overrides and tuning data, are still needed to measure
precision and false positives (`docs/adjudication/README.md`).

## Historical .9 draft message — not sent; use the current generated handoff

> Hi! I've built a CLI that downloads SiteLedger's three reports and the Pulley
> projects, then creates the requested mapping CSV and a review list explaining
> uncertain cases. Run `pnpm sync` for updated data and `pnpm cli published-path`
> to locate the verified results. Human review decisions can persist across runs
> and are checked again when source data changes.
>
> The latest snapshot matches 323 of 400 rows, holds 27 for review, and finds no
> match for 50. My provisional record-based estimate is about 90% supported
> resolved outcomes; this is not independently verified accuracy. Four sampled
> cases need permit-level checks, and the initial review backlog needs onboarding.
> We should measure new cases on changing data before promising only a few
> reviews each week.
>
> The matcher separates Market from Warehouse Club, uses full store/sequence
> identities, tolerates jurisdiction-city differences, supports evidenced shared
> store/year permits including EV, keeps signage separate, excludes Pathfinder,
> and enforces cancellation agreement. It retains raw inputs, decision evidence
> and human overrides for reproduction.
>
> Fresh acquisition, reviewed reruns, upstream changes, backup/restore, corruption
> detection and missed-run detection have been exercised locally. Scheduling and
> monitoring support are ready for configuration; live operation still needs a
> persistent host, named operators, independent alert delivery and off-host backup
> verification. Could we meet for 30 minutes to review the disputed cases, run the
> updated-data demo and onboard your team?

See `READINESS_COMPLETION.md` for verification evidence and release conditions.
