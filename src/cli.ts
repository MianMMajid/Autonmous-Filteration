#!/usr/bin/env node
/**
 * Command-line entry point.
 *
 *   pnpm cli sync              pull both systems, match, write outputs
 *   pnpm cli sync --dry-run    same, but replay the newest archived inputs
 *   pnpm cli --help
 *
 * Exit codes are defined in src/errors.ts and documented in README.md.
 */

import { Command } from "commander";
import { loadConfig } from "./config.ts";
import { ExitCode, SyncError, toError } from "./errors.ts";
import { createLogger } from "./logger.ts";
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
  .option("--quiet", "do not print the summary to stdout")
  .action(async (options: { dryRun?: boolean; quiet?: boolean }) => {
    const config = loadConfig();
    const log = createLogger(config.logLevel);
    const dryRun = options.dryRun === true;
    log.info({ dryRun, dataDir: config.dataDir }, "sync starting");

    const outcome = await runSync({ config, log, dryRun });

    if (options.quiet !== true) {
      console.log("");
      console.log(outcome.summary);
    }
  });

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
