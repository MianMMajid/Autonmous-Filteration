# Deployment and completion gates

The original Pulley PDF specifies the mapping CSV, estimated match percentage,
Account Lead onboarding notes, and a live demo on updated data. It does not
specify a cloud provider, monitoring vendor, or deployment owner. This release
keeps the CLI usable locally and provides a provider-neutral persistent-host
workflow. No external service has been provisioned or activated by this change.

## Supported deployment

One trusted Linux or macOS host, Node 26+, pnpm 10, and a local filesystem with
atomic hard links. Do not share DATA_DIR between hosts or use a network filesystem
for locking. A backup destination may be on separately protected storage.

The opt-in GitHub workflow uses a dedicated self-hosted Linux runner labelled
`pulley-sync`; never allow untrusted pull requests to run on this host. CI remains
on GitHub-hosted Linux and macOS runners. Actions are pinned to verified upstream
v4 commit SHAs and Dependabot proposes weekly action updates.

Before enabling unattended runs:

1. Assign an operator, backup operator and engineering contact in OPERATIONS.md.
2. Provision separate absolute `SYNC_DATA_DIR` and `SYNC_BACKUP_DIR` paths outside
   the checkout. Restrict access to the runner identity and authorized operators.
   Keep the backup on a separately protected volume/service; a second folder on
   the same disk does not establish disaster recovery. Configure its retention
   policy and capacity monitoring. The CLI never deletes backup snapshots.
3. Create `.deployment-ready` containing `pulley-state-v1` inside each provisioned
   directory. Place these on the actual mounted volumes, not beneath an unmounted
   mountpoint. The preflight checks these markers and an existing valid publication.
4. Run one supervised `pnpm sync` using that DATA_DIR. Inspect the results. Create
   and restore a backup using the commands below before enabling the scheduler.
5. Set repository variables `SYNC_DATA_DIR`, `SYNC_BACKUP_DIR`. Configure the three
   upstream secrets and `SYNC_HEARTBEAT_URL` for an independent missed-run monitor.
   Configure that monitor to expect successful publications at 13:17, 17:17, 21:17
   UTC on weekdays, with the team's agreed grace period. The example is 60 minutes.
6. Withhold a heartbeat deliberately and confirm delivery to both named operators.
   Check weekend behavior and recovery notifications. Only then set
   `SYNC_ENABLED=true`. Until this variable is set, the scheduled job is disabled.

The workflow reads persistent state, syncs, verifies the result, creates a verified
backup, uploads the immutable output directory, and finally sends a success
heartbeat. A failed sync/backup/upload sends no success heartbeat. The independent
service must alert when no heartbeat arrives, including when GitHub or the host
never runs. An error after local publication can leave a valid new local result
while the job fails; inspect `published-path` before retrying. Each retry produces
a new immutable run. No raw customer data is stored in Actions caches.

This persistent-host option is an integration prepared for deployment, not proof
that a host, backup service, alert destination, or delivery SLO is configured.

## Publication and migration

`latest.json` is authoritative. `latest` is only a convenience link and may remain
stale on platforms that cannot replace it. Use:

```sh
node --env-file-if-exists=.env src/cli.ts published-path
node --env-file-if-exists=.env src/cli.ts status --json --max-age-hours 24 --max-source-age-hours 24
```

Version 3 run records require output integrity verification. Their manifest hashes
all seven output files, including `run.json` and `overrides.snapshot.csv`. Status,
subsequent sync, backups, and artifact selection reject damaged version 3 outputs.
Hashes detect corruption; they do not authenticate files against an attacker who
can rewrite both files and manifests. Access control and a trusted backup store
remain necessary. File writes are flushed before publication; storage durability
and power-loss recovery still require validation on the deployed filesystem.

Versions 1 and 2 remain readable for migration. Version 2 must contain its quality
comparison fields; version 1 can derive its matched count from decisions. Legacy
outputs lack the new artifact-integrity guarantee and cannot be exported by
`published-path` or backed up until a supervised successful sync produces version 3.
No matching rules changed in this release.

Missing `latest.json` with existing completed outputs is an error, not a first run.
Never delete history to bypass the quality gate. Restore a known snapshot into a
new directory, validate it, then explicitly switch DATA_DIR. A truly empty output
history remains the supported supervised bootstrap path. Existing but corrupted
baseline state cannot be waived using `--accept-input-change`.

## Backup, restoration, and rollback drill

Commands below use illustrative paths; substitute provisioned locations.

```sh
# Creates /separate-volume/pulley-backups/<published-run-id> exclusively.
node --env-file-if-exists=.env src/cli.ts backup /separate-volume/pulley-backups
node src/cli.ts verify-backup /separate-volume/pulley-backups/<run-id>
# Destination MUST NOT exist; restore never merges or overwrites state.
node src/cli.ts restore /separate-volume/pulley-backups/<run-id> /new-volume/pulley-restored
```

A snapshot contains the published output, its referenced raw archive (which may
have a different ID after replay), exact override input, runtime source, package
metadata, lockfile, and vendored SheetJS tarball. It excludes `.env`, tokens,
node_modules, unrelated data history, and the credential-bearing PDF. It refuses
backup under different implementation bytes: use the exact producing revision,
or create and review a new run before backing up. Source fingerprint verification
also detects missing or changed implementation files in a snapshot.

On a clean host, verify the snapshot first. Use its `implementation/` directory
and `pnpm install --frozen-lockfile`. For source-mode snapshots:

```sh
DATA_DIR=/new-volume/pulley-restored \
OVERRIDES_FILE=/new-volume/pulley-restored/out/<output-run-id>/overrides.snapshot.csv \
node src/cli.ts sync --replay <archive-run-id> --quiet
```

Read `<archive-run-id>` from `backup.json`. Compiled snapshots contain `dist/`
instead of `src/`; invoke `node dist/cli.js`. Compare the new mapping with the
snapshot mapping using `cmp`. Do not upgrade dependencies or substitute current
overrides in a reproducibility drill. Record the host, snapshot ID, hashes,
elapsed recovery time, and result. Stop scheduling before switching DATA_DIR for
rollback, and retain the previous data directory for investigation.

Rehearse corruption, absent records, full disk, interrupted writes, a dead main
lock, and a stranded reclaim mutex. For mutex recovery, stop all processes and
verify suspended owners cannot resume before manual removal. Automated tests
exercise selected failures; an actual storage/host recovery drill is still a
release condition.

## Independent monitoring

`monitor` is read-only and requires no upstream credentials:

```sh
DATA_DIR=/var/lib/pulley/data node src/cli.ts monitor docs/monitor.example.json
```

It validates output integrity and checks publication AND source acquisition against
the latest scheduled obligation whose grace period has elapsed. It handles the
weekend gap and reports structured JSON; missed deadlines exit 9, corrupt state
exits 5/7. A replay with old inputs cannot satisfy a newer source obligation.

Run it from independently operated infrastructure with a current verified copy of
state, or use the workflow's external missed-heartbeat service. Merely scheduling
this command on the sync host does not detect total host loss. The example schedule
uses UTC deliberately; edit the workflow, monitor schedule and external service
together if the business calendar changes. The monitor checks bytes fetched, not
whether an upstream export itself represents current business data.

## Limits and measured capacity

- HTTP body/report limit: 32 MiB; streamed bodies are counted even without a length
  header. Over-limit responses fail with exit 5 without retrying the oversized body.
- Pulley snapshot: 200 pages, 20,000 rows before deduplication, 96 MiB total page text.
- Spreadsheet: 20,000 data rows, 64 columns, first sheet only; ZIP expansion is
  validated with a bounded inflater before SheetJS reads XLSX (128 MiB, 1,024 entries).
- CSV record: 65,536 characters under the parser's record-size semantics; report
  byte/row/column ceilings also apply. Archive metadata totals are bounded.
- Backups: 512 MiB total declared files, 4,096 files, 128 MiB per file. These are
  supported safety bounds, not a promise of runtime at every combination of limits.
- Scheduled Node heap: 1 GiB. An OS/process memory limit is still the deployment
  operator's responsibility. The workflow's outer timeout is 15 minutes.

Reproduce the local synthetic matcher probe with:

```sh
node --max-old-space-size=1024 scripts/benchmark.mjs 4000
```

On the development Mac with Node 26.5.0: 4,000 exact pairs took 1,261 ms;
4,000 Acme rows against 8,000 duplicated targets took 2,373 ms, all correctly held
for review. Peak process RSS across both cases was 181 MiB. Invariants passed.
These measurements exclude network, spreadsheet parsing, archiving, and deployment
hardware; they are neither a production SLO nor full maximum-input certification.

## Accuracy and supervised pilot

Use `evaluate <runId> <labels.csv>` as described in `adjudication/README.md`.
The template is not ground truth. Label reviewers, holdout groups/later snapshots,
acceptable false-match risk, and review-workload limits require Permit Ops.

Before unattended reliance, record:

- the agreed accuracy and weekly review-effort targets and independent results;
- named operator/backup and demonstrated missed-run alert delivery;
- clean-host restore and rollback evidence;
- representative peak-load results on the deployed host;
- customer-data access and retention rules and credential rotation ownership.

A proposed pilot is one to two working weeks, extended until representative changes
occur. Review outputs before downstream use. Repeated identical snapshots do not
establish accuracy on new projects or a long-term reliability percentage.

## References

The independent monitor addresses documented GitHub scheduling delays/dropped jobs:
[GitHub schedule](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).
Removing the customer-data cache addresses eviction and access concerns:
[GitHub caching](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching).
The staged rollout and recovery drills follow
[Google SRE pipeline guidance](https://sre.google/workbook/data-processing/).
