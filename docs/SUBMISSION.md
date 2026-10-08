# Submission notes

## 1. Mapping CSV

Run `pnpm sync` for fresh upstream data, or `pnpm sync --dry-run` to replay
archived inputs. Resolve the verified immutable output with
`pnpm cli published-path`; submit its `mapping.csv` and `review.csv`.
The CSV uses exactly `acme_pcroject_id,pulley_project_id,status`.

## 2a. Match coverage and correctness

Rules 2026-10-08.6 produce **309 matches, 41 review rows, and 50 no-matches**
on the 400-row 2026-10-08 archive. Automatic coverage is **77.25%**. Twenty-three
previously accepted rows now require verification because evidence conflicts
or does not establish the permit's year.

**Correctness has not been independently measured.** Earlier estimates of
96% precision, 81% correctly matched projects, and 94% correct outcomes were
not supported by adjudicated labels and must not be used as release claims.
A correct no-match is a valid outcome; review is an abstention, not proof of
correctness. Follow `docs/adjudication/README.md` before reporting measured
precision, with label coverage and sample sizes. No 100% accuracy guarantee
is implied by the automated tests.

## 2b. Draft message to the Account Lead — not sent

> Hi! I've built the SiteLedger-to-Pulley matching tool. One command downloads
> the reports and Pulley projects, archives the inputs, and writes the mapping
> CSV plus explanations and candidates for rows needing review.
>
> On the archived October 8 dataset, the current rules accept 309 of 400 rows,
> hold 41 for review, and return no match for 50. These are coverage counts;
> we still need independent checks to establish correctness. The matcher now
> holds conflicting IDs, years, dates, addresses, and lifecycle evidence for
> review rather than treating a high score as sufficient proof.
>
> Pathfinder and signage are excluded. Market and Warehouse Club identities
> stay separate, cancellation must agree, and shared permits cannot span
> buildings or program years. Verified human decisions can supply missing
> evidence; conflicting source facts must be corrected before a match is
> accepted. Overrides are checked again on each run.
>
> Scheduling, verified outputs, backups, and monitoring support are included;
> live scheduled operation still requires deployment setup and verification.
> The 41-row initial review backlog should be resolved before agreeing on an
> acceptable ongoing weekly review workload.
>
> Could we schedule 30 minutes to review the disputed cases, run the tool on
> updated data, and agree on the independent validation needed before relying
> on automatic matches?

## What was built

A TypeScript CLI with archived acquisition, normalized identities and addresses,
a deterministic six-tier candidate matcher with a shared acceptance safety gate,
review and audit outputs, validated overrides, publication invariants, independent
label evaluation, and deployment/backup/monitoring support. See `MATCHING.md`,
`VALIDATION.md`, and `DEPLOYMENT.md` for behavior and remaining release work.
