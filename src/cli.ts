#!/usr/bin/env node
/**
 * Command-line entry point.
 *
 *   pnpm cli sync                      pull both systems, match, write outputs
 *   pnpm cli sync --dry-run            same, but replay the newest archived inputs
 *   pnpm cli sync --replay <runId>     replay one archived run (implies --dry-run)
 *   pnpm cli sync --accept-input-change
 *                                      publish even if the inputs collapsed versus the previous run
 *   pnpm cli status [--max-age-hours N]
 *                                      show the last published result; exit 9 if older than N hours
 *   pnpm cli --help
 *
 * Exit codes are defined in src/errors.ts and documented in README.md.
 */

import { resolve } from "node:path";
import { Command, InvalidArgumentError } from "commander";
import { loadConfig, loadLocalConfig } from "./config.ts";
import { ExitCode, StaleError, SyncError, toError } from "./errors.ts";
import { createLogger } from "./logger.ts";
import { backupState, restoreState, verifyBackup } from "./run/backup.ts";
import { evaluateRun } from "./run/evaluate.ts";
import { verifyOutputDirectory } from "./run/integrity.ts";
import { monitorPublication } from "./run/monitor.ts";
import { latestRunId, readRunRecord } from "./run/outputs.ts";
import { readPublishedStatus, renderStatus } from "./run/status.ts";
import { runSync } from "./run/sync.ts";
import { TOOL_VERSION } from "./version.ts";

const program = new Command();

program
  .name("siteledger-sync")
  .description("Match Acme SiteLedger projects to Pulley projects and write a mapping CSV.")
  .version(TOOL_VERSION);

program
  .command("sync")
  .description("Download SiteLedger reports and Pulley projects, run the matcher, write outputs.")
  .option(
    "--dry-run",
    "match against the most recent archived inputs without contacting either system",
  )
  .option("--replay <runId>", "replay one archived run by id (implies --dry-run)")
  .option(
    "--accept-input-change",
    "publish even when the inputs look incomplete or very different from the previous run",
  )
  .option("--quiet", "do not print the summary to stdout")
  .action(
    async (options: {
      dryRun?: boolean;
      replay?: string;
      acceptInputChange?: boolean;
      quiet?: boolean;
    }) => {
      const dryRun = options.dryRun === true || options.replay !== undefined;
      const config = dryRun ? loadLocalConfig() : loadConfig();
      const log = createLogger(config.logLevel);
      log.info(
        { dryRun, replay: options.replay ?? null, dataDir: config.dataDir },
        "sync starting",
      );

      const outcome = await runSync({
        config,
        log,
        dryRun,
        ...(options.replay !== undefined ? { replayRunId: options.replay } : {}),
        acceptInputChange: options.acceptInputChange === true,
      });

      if (options.quiet !== true) {
        console.log("");
        console.log(outcome.summary);
      }
    },
  );

program
  .command("status")
  .description("Show the last published result and how old it and its source data are.")
  .option("--json", "output machine-readable publication status")
  .option(
    "--max-age-hours <hours>",
    "exit with code 9 if the last result was published longer ago than this",
    parseHours,
  )
  .option(
    "--max-source-age-hours <hours>",
    "exit with code 9 if the source data behind it was fetched longer ago than this",
    parseHours,
  )
  .action(async (options: { maxAgeHours?: number; maxSourceAgeHours?: number; json?: boolean }) => {
    // Local only: reads data/, never needs credentials.
    const config = loadLocalConfig();
    const maxAge = options.maxAgeHours ?? null;
    const maxSourceAge = options.maxSourceAgeHours ?? null;
    const status = await readPublishedStatus(config.dataDir);
    console.log(options.json ? JSON.stringify(status) : renderStatus(status, maxAge, maxSourceAge));
    if (!status) throw new StaleError("No published result yet");
    if (maxAge !== null && status.ageHours > maxAge) {
      throw new StaleError(
        `Last published result ${status.runId} was published ${status.ageHours.toFixed(1)} h ago, more than ${maxAge} h`,
        { details: { runId: status.runId, publishedAt: status.publishedAt } },
      );
    }
    if (
      maxSourceAge !== null &&
      (status.sourceAgeHours === null || status.sourceAgeHours > maxSourceAge)
    ) {
      throw new StaleError(
        status.sourceAgeHours === null
          ? `Run ${status.runId} does not record when its source data was fetched`
          : `Source data behind ${status.runId} was fetched ${status.sourceAgeHours.toFixed(1)} h ago, more than ${maxSourceAge} h`,
        { details: { runId: status.runId, sourceAcquiredAt: status.sourceAcquiredAt } },
      );
    }
  });

program
  .command("published-path")
  .description("Print the absolute, verified immutable output directory (no credentials).")
  .action(async () => {
    const config = loadLocalConfig();
    const runId = await latestRunId(config.dataDir);
    if (!runId) throw new StaleError("No published result yet");
    await readRunRecord(config.dataDir, runId);
    const directory = resolve(config.dataDir, "out", runId);
    await verifyOutputDirectory(directory, runId);
    console.log(directory);
  });

program
  .command("backup <destination>")
  .description("Create an immutable, verified snapshot including source and overrides.")
  .action(async (destination: string) =>
    console.log(await backupState(loadLocalConfig().dataDir, destination)),
  );
program
  .command("verify-backup <snapshot>")
  .description("Verify a backup without credentials or changing state.")
  .action(async (snapshot: string) => console.log(JSON.stringify(await verifyBackup(snapshot))));
program
  .command("restore <snapshot> <destination>")
  .description("Restore verified state into a NEW data directory; never overwrites existing data.")
  .action(async (snapshot: string, destination: string) => {
    await restoreState(snapshot, destination);
    console.log(resolve(destination));
  });

program
  .command("evaluate <runId> <labels>")
  .description(
    "Compare a run with independent adjudicated labels; outputs JSON, never changes mappings.",
  )
  .action(async (runId: string, labels: string) =>
    console.log(
      JSON.stringify(await evaluateRun(loadLocalConfig().dataDir, runId, labels), null, 2),
    ),
  );
program
  .command("monitor <schedule>")
  .description(
    "Verify scheduled publication and source freshness; run from an independent monitor.",
  )
  .action(async (schedule: string) => {
    const result = await monitorPublication(loadLocalConfig().dataDir, schedule);
    console.log(JSON.stringify(result, null, 2));
    if (!result.healthy) throw new StaleError(result.problems.join("; "));
  });

function parseHours(value: string): number {
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new InvalidArgumentError("must be a positive number of hours");
  }
  return hours;
}

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (raw) {
    const error = toError(raw);
    if (error instanceof SyncError) {
      console.error(`${error.name}: ${error.message}`);
      if (Object.keys(error.details).length > 0) {
        console.error(JSON.stringify(error.details, null, 2));
      }
      process.exit(error.exitCode);
    }
    console.error(`Unexpected error: ${error.message}`);
    process.exit(ExitCode.Unknown);
  }
}

await main();
