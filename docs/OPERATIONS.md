# Operations

How to run the sync on a schedule, read what it produces, and record
decisions so they stick.

## Running it

| Where | How |
|---|---|
| A laptop, by hand | `pnpm sync` in the repo folder. The summary prints at the end. |
| A laptop, on a schedule (macOS) | `crontab -e`, then `0 8,12,16 * * 1-5 cd /path/to/repo && /usr/local/bin/pnpm sync --quiet >> sync.log 2>&1` |
| GitHub Actions | `.github/workflows/sync.yml` runs three times on weekdays and on demand. Add the three secrets in the repository settings. Outputs are attached to each run as an artifact and cached so the next run can diff against them. |

The run takes a few seconds. Two runs cannot overlap: the second exits with
code 6 and a message naming the first.

## Reading the result

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
| `TYPE_MISMATCH` | The only project at the store is a different kind of work |
| `STATUS_CONFLICT` | Canceled or closed on one side only |
| `WEAK_EVIDENCE` | Same street name or same city only |
| `UNRELATED_ONLY` | Projects at the store exist but are another line or another year |
| `EXCLUDED_ONLY` | Only a pathfinder or signage project references it |
| `NO_CANDIDATE` | Nothing relates |
| `OVERRIDE` | A human decision from `overrides.csv` |

## Recording decisions

Once a review row is settled, add it to `data/overrides.csv` so it does not
come back next run:

```
acme_project_id,pulley_project_id,status,note
3716.1005,prj_ae5zai,matched,confirmed with the lead 2026-10-09
2523.1001,,no_match,Pulley never opened this one
```

`status` is `matched` (with a Pulley id) or `no_match` (without one). The
tool validates every line and lists any it cannot apply in the summary, for
example a Pulley id that is pathfinder. Overrides also beat the matcher on
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

## Demo on an updated dataset

Nothing to prepare. Run `pnpm sync`; the summary shows the new counts and,
because the previous run is kept, exactly which rows changed. To explain a
single decision, find the row in `decisions.csv`: it carries the tier, the
reason, and the top candidates with their evidence scores.
