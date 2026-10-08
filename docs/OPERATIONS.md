# Operations

How to run the sync on a schedule, read what it produces, and record
decisions so they stick.

## Running it

| Where | How |
|---|---|
| A laptop, by hand | `pnpm sync` in the repo folder, or double-click `sync.command` (macOS), which runs it and opens the output folder. The summary prints at the end. |
| A laptop, on a schedule (macOS) | `crontab -e`, then `0 8,12,16 * * 1-5 cd /path/to/repo && /usr/local/bin/pnpm sync --quiet >> sync.log 2>&1` |
| GitHub Actions | Opt-in persistent-host workflow, three times on weekdays at minute 17. Provision state, backups and an independent monitor as described in `DEPLOYMENT.md`; then set `SYNC_ENABLED=true`. |

The run takes a few seconds. Two runs cannot overlap: the second exits with
code 6 and a message naming the first.

## Who owns it

| Role | Name | Responsibility |
|---|---|---|
| Operator | _fill in_ | Runs or watches the scheduled sync, works the review list, records decisions in `overrides.csv` |
| Backup | _fill in_ | Covers the operator; knows where the credentials live |
| Engineering contact | _fill in_ | Exit code 5 (data shape changed), exit code 8 (inputs collapsed), new status vocabulary |

Agree with the Account Lead on two numbers and write them here: the latest
acceptable publication time before each review window, and how old a result
may be before it must not be relied on.

## Freshness and alerts

`pnpm cli status --max-age-hours 24 --max-source-age-hours 24` prints the
last published run, when it was published, when its *source data* was
fetched (a replay republishes old data), and its counts. It exits with code
9 when either age exceeds its limit or nothing has been published. It needs
no credentials. It verifies version 3 output integrity as well as timestamps.
The scheduled workflow checks freshness after sync and sends a success heartbeat
to a configured independent service only after backup and artifact upload.
That service must detect missing runs and deliver alerts to the named operator
and backup. `monitor docs/monitor.example.json` additionally checks scheduled
publication obligations and source freshness across weekend gaps; see DEPLOYMENT.md.
GitHub workflow notifications alone do not establish missed-run detection.

A failed run and an old result are different things: a failed run exits
non-zero and `latest.json` does not move; an old result is a successful run
that nobody has refreshed, which only `status` reveals.

## Recovery

- **Last good output.** `data/out/latest.json` names it. A failed run never
  changes it. Every run directory is immutable once published, and retention
  never removes the archive a retained output was computed from.
- **Concurrency.** The lock is created atomically; a dead owner's lock is
  removed only under a second exclusive file, the reclaim mutex, after
  re-checking liveness while holding it. The mutex never expires. If recovery
  crashes, subsequent reclaim attempts exit 6 with the mutex path. Stop every
  sync process, disable the scheduler, and verify no suspended process can
  resume before removing `data/.lock.reclaim`; then retry and re-enable the
  scheduler. Do not remove a mutex solely because it is old. Hard-link support
  on a local filesystem is required; distributed/shared-host locking is not supported.
- **Reproduce a past decision.** `pnpm sync --replay <runId> --quiet` reruns
  today's rules on that run's archived bytes; the archive verifies every
  file against its recorded hash. To see what the rules were at the time,
  read `run.json`: it records the rules version, tool version, implementation
  SHA-256 (source, package metadata, dependency lockfile), input hashes,
  configuration, the overrides file hash, and the matcher's decision for
  every row a human decision replaced.
- **Drill.** Create a verified backup with `pnpm cli backup <destination>`, restore
  it into a new data directory with `pnpm cli restore <snapshot> <new-directory>`,
  then replay with the snapshot's source/dependencies and overrides. Compare
  mapping bytes. Do not delete `latest.json` to simulate a first run; damaged
  history deliberately blocks publication. Full instructions: `DEPLOYMENT.md`.

## Reading the result

Conflicting Pulley records for one ID refuse the snapshot with exit 5;
identical repeats still collapse. Retry acquisition, then correct the source
if the conflict persists. A contradictory site/store join, register duplicate,
or Key Dates duplicate is held in `review.csv` as `IDENTITY_DISPUTED`.
Matched overrides on disputed rows are rejected for reconfirmation.

HTTP redirects are refused with exit 5; correct the configured endpoint rather
than forwarding credentials. Server `Retry-After` is honored within a five-minute
cumulative wait budget per request. A cooldown beyond the remaining budget
exits 4 with a retry-later message, without sending premature retries.
Cancellation interrupts network attempts and default retry waits.

Archive files use internal report/page names; original download names are
metadata only. Duplicate/reserved internal paths cannot overwrite inputs.
Malformed manifests, unsafe paths, hash/length changes, and inconsistent
archive identities produce typed errors instead of silently replaying them.
Lock-cleanup failures are warnings so they cannot mask a primary failure or
turn a completed publication into a misleading failure; inspect the lock
before running again.

Use `pnpm cli published-path` to resolve the verified current output directory.
The `latest` symlink is optional and may be stale after a failed refresh.

Start with `summary.txt` (also printed to the terminal). It leads with the
counts, then what changed since the previous run, then the review list.

| Outcome | Meaning | What to do |
|---|---|---|
| `matched` | One Pulley project, with compatible type and agreeing status | Nothing |
| `needs_review` | The tool found candidates but will not guess | Open `review.csv`, read the reason and candidates, decide |
| `no_match` | Nothing in Pulley relates, or only another year's work or an excluded project | Usually nothing; `decisions.csv` names any rejected candidate |

Reason codes in `review.csv` and `decisions.csv`:

| Code | Meaning |
|---|---|
| `EXACT_ID` | Acme id appears in the Pulley name |
| `STORE_TYPE_YEAR` | Store number plus compatible type and same year |
| `SEQUENCE_LOCALITY` | Sequence plus city identify one Acme project |
| `ADDRESS` | Exact street match |
| `DATE_LOCALITY` | Milestone dates within a week, same city |
| `AMBIGUOUS` | Two or more candidates tie; usually duplicate Pulley projects |
| `YEAR_CONFLICT` | The same Pulley project is also claimed by a line from another program year |
| `ID_OUTSIDE_SCOPE` | The Acme id is on a project filed under the other banner or state; likely a data-entry error in Pulley |
| `TYPE_MISMATCH` | The only project at the store is a different kind of work |
| `STATUS_CONFLICT` | Canceled or closed on one side only |
| `STATUS_UNKNOWN` | A status value the tool has never seen; it will not guess what it means |
| `EVIDENCE_CONFLICT` | Source identity, year, milestones, or lifecycle evidence conflicts; correct the source before acceptance |
| `INSUFFICIENT_EVIDENCE` | No trustworthy permit-year evidence or no unique strong owner; verify independently |
| `IDENTITY_DISPUTED` | Acme's own source rows for this project or its site contradict each other; it would have matched, but contradictory evidence never raises confidence |
| `WEAK_EVIDENCE` | Same street name or same city only |
| `UNRELATED_ONLY` | Projects at the store exist but are another line or another year |
| `EXCLUDED_ONLY` | Only a pathfinder or signage project references it |
| `NO_CANDIDATE` | Nothing relates |
| `OVERRIDE` | A human decision from `overrides.csv` |

`review.csv` and `decisions.csv` show, per row, the Acme side (city, street,
milestone dates) and for each candidate its city, street, dates, a plain
reading of the evidence, and the score. Review rows also carry a
`recommended_action` that says what to do.

## Keeping recurring review manageable

`review.csv` is the **entire unresolved backlog**. Use it for the Monday review.
`review-changes.csv` contains only new cases and cases whose evidence changed
since the immediately preceding successful run. It is useful when watching
several runs per day, but **must not be used alone for weekly review**: a case
added on Tuesday remains in the full backlog even if Monday's delta is empty.
No unresolved case is silently dropped to meet a review quota.

Candidate identity, status, address, dates, evidence, reason, and review notes
are compared using a stable fingerprint. Candidate/object ordering alone does
not change that fingerprint. The first run after upgrading old output records
resurfaces their pending cases once because no comparison fingerprint exists.
Removed projects are reported separately from resolved reviews.

The initial 41-row backlog on the October 8 archive needs an onboarding review;
it is not a claim that the team will have 41 new cases every week. Actual weekly
workload must be measured over fresh snapshots. Verified overrides retain prior
decisions when evidence is still valid. Contradictory source facts require source
correction; changing an override alone cannot waive the shared safety gate.

## Status differences

A separate section of the summary lists matched rows where the two systems
disagree in a way the brief permits, for example Pulley says Complete while
Acme still says Active. These are not errors in the match; they are the
things a sync between the systems exists to catch. The same text is in the
`status_drift` column of `decisions.csv`.

## Housekeeping

Every run keeps its raw inputs and outputs. The newest 60 runs are kept and
older ones removed automatically (`RETAIN_RUNS` in `.env` changes the
number). The run `latest.json` points at is never removed.

Logs are quiet by default; set `LOG_LEVEL=info` in `.env` to see each step.

## Recording decisions

Once a review row is settled, add it to `overrides.csv` at the repository
root (tracked in version control, so every decision has an author, a date,
and a history) so it is retained when the source evidence still permits it:

```
acme_project_id,pulley_project_id,status,note,author,decided_at
3716.1005,prj_ae5zai,matched,confirmed with the lead,J. Lee,2026-10-09
2523.1001,,no_match,Pulley never opened this one,J. Lee,2026-10-09
```

`author` and `decided_at` are optional but recorded in `run.json` when
present. `OVERRIDES_FILE` in `.env` points elsewhere if the team keeps the
file on a shared drive instead.

`status` is `matched` (with a Pulley id) or `no_match` (without one). The
tool validates every line and lists any it cannot apply in the summary, for
example a Pulley id that is pathfinder. A recorded match is re-checked on
every run against the rules that no human decision can waive: same banner,
same state, compatible work, the canceled-on-both-sides rule, and the shared
identity/year/milestone safety gate. If the upstream facts have
changed since the decision was recorded, the summary says the override needs
reconfirmation and the matcher's own decision is used until the line is
updated. Overrides also beat the matcher on
rows it would have matched differently, so the file doubles as a correction
log. Keep it in version control or a shared drive; it is the team's memory.

A sample lives at `docs/overrides.example.csv`.

## When something fails

The last line on screen names the problem and the exit code says which
kind it is (see README). Nothing is overwritten: `data/out/latest.json`
still points at the last good run. Fix the cause and run again.

| Symptom | Likely cause |
|---|---|
| Exit 3, "rejected the credentials" | Password or API key changed; update `.env` |
| Exit 5, "header does not match" | SiteLedger changed a report layout; engineering needs to update the parser |
| Exit 5, "did not match the expected shape" | Pulley API changed a field; same |
| Warnings about unknown status or type values | A new vocabulary value appeared; matching still ran, treating it conservatively |
| Exit 6 | A sync is already running, or a crashed one left `data/.lock`; the tool reclaims locks whose owner is gone |
| Exit 8, "Publication refused" | An export came back empty or far smaller than last time; inspect the archived inputs, then rerun with `--accept-input-change` only if the change is real |
| Exit 9 from `status` | Nothing published, or the last result or its source data is older than the limit |
| Exit 10, "invariant violation" | The combined result broke a hard rule; a defect in the tool. Nothing was published; contact engineering with `run.json` from the previous run and the archived inputs |

## Demo on an updated dataset

Nothing to prepare. Run `pnpm sync`; the summary shows the new counts and,
because the previous run is kept, exactly which rows changed. To explain a
single decision, find the row in `decisions.csv`: it carries the tier, the
reason, and the top candidates with their evidence scores.
