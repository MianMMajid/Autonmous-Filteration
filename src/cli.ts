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

import { Command, InvalidArgumentError } from "commander";
import { loadConfig, loadLocalConfig } from "./config.ts";
import { ExitCode, StaleError, SyncError, toError } from "./errors.ts";
import { createLogger } from "./logger.ts";
import { readPublishedStatus, renderStatus } from "./run/status.ts";
import { runSync } from "./run/sync.ts";

const program = new Command();

program
  .name("siteledger-sync")
  .description("Match Acme SiteLedger projects to Pulley projects and write a mapping CSV.")
  .version("0.1.0");

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
      const config = loadConfig();
      const log = createLogger(config.logLevel);
      const dryRun = options.dryRun === true || options.replay !== undefined;
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
  .action(async (options: { maxAgeHours?: number; maxSourceAgeHours?: number }) => {
    // Local only: reads data/, never needs credentials.
    const config = loadLocalConfig();
    const maxAge = options.maxAgeHours ?? null;
    const maxSourceAge = options.maxSourceAgeHours ?? null;
    const status = await readPublishedStatus(config.dataDir);
    console.log(renderStatus(status, maxAge, maxSourceAge));
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
