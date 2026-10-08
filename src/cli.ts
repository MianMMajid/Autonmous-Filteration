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
import { matchProjects } from "./domain/match/matcher.ts";
import { normalizeInputs } from "./domain/normalize/build.ts";
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

    const normalized = normalizeInputs(inputs);
    for (const warning of normalized.warnings) log.warn(warning);
    log.info(
      {
        acmeProjects: normalized.acme.length,
        acmeWithSite: normalized.acme.filter((p) => p.site !== null).length,
        pulleyCandidates: normalized.pulley.filter((p) => !p.isPathfinder && !p.isSignage).length,
        pulleyWithFullId: normalized.pulley.filter((p) => p.parsedName.fullIds.length > 0).length,
        pulleyWithStreetKey: normalized.pulley.filter((p) => p.streetKey !== null).length,
      },
      "inputs normalized",
    );

    const report = matchProjects(normalized);
    log.info(
      {
        ...report.counts,
        reasons: report.reasons,
        unmatchedPulley: report.unmatchedPulley.length,
        pulleyIdsNotInRegister: report.pulleyIdsNotInRegister.length,
      },
      "matching complete",
    );

    // Phase 4 lands here: output files.
    log.warn("output files are not written yet (Phase 3: matching only)");
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
