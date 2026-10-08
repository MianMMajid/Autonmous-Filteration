#!/usr/bin/env node
/**
 * Command-line entry point.
 *
 *   pnpm cli sync        pull both systems, match, write outputs
 *   pnpm cli --help
 *
 * Exit codes are defined in src/errors.ts and documented in README.md.
 */

import { Command } from "commander";
import { loadConfig } from "./config.ts";
import { ExitCode, SyncError, toError } from "./errors.ts";
import { createLogger } from "./logger.ts";

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
  .action(async (options: { dryRun?: boolean }) => {
    const config = loadConfig();
    const log = createLogger(config.logLevel);
    log.info({ dryRun: options.dryRun === true, dataDir: config.dataDir }, "sync starting");
    // Phases 1-4 land here: acquisition -> normalization -> matching -> output.
    log.warn("sync is not implemented yet (Phase 0 scaffold)");
  });

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (raw) {
    const error = toError(raw);
    if (error instanceof SyncError) {
      console.error(`${error.name}: ${error.message}`);
      process.exit(error.exitCode);
    }
    console.error(`Unexpected error: ${error.message}`);
    process.exit(ExitCode.Unknown);
  }
}

await main();
