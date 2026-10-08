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
import { acquireInputs } from "./run/acquire.ts";

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
    const dryRun = options.dryRun === true;
    log.info({ dryRun, dataDir: config.dataDir }, "sync starting");

    const inputs = await acquireInputs({ config, log, dryRun });

    log.info(
      {
        runId: inputs.runId,
        source: inputs.source,
        acmeProjects: inputs.acme.projects.length,
        acmeSites: inputs.acme.sites.length,
        acmeKeyDates: inputs.acme.keyDates.length,
        pulleyProjects: inputs.pulley.length,
      },
      "inputs acquired",
    );
    for (const warning of inputs.warnings) log.warn(warning);
    for (const drift of inputs.vocabulary) {
      log.warn(
        drift,
        `unknown ${drift.source} ${drift.field} value "${drift.value}" (${drift.count}x)`,
      );
    }

    // Phases 2-4 land here: normalization -> matching -> output.
    log.warn("matching is not implemented yet (Phase 1: acquisition only)");
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
