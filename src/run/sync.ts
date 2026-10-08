import type { Config } from "../config.ts";
import { matchProjects } from "../domain/match/matcher.ts";
import type { MatchReport } from "../domain/match/types.ts";
import { normalizeInputs } from "../domain/normalize/build.ts";
import type { Logger } from "../logger.ts";
import {
  renderDecisionsCsv,
  renderMappingCsv,
  renderReviewCsv,
  renderUnmatchedPulleyCsv,
} from "../output/csv.ts";
import { diffRuns, type RunDiff } from "../output/diff.ts";
import { renderSummary } from "../output/summary.ts";
import type { HttpClient } from "../sources/http.ts";
import { acquireInputs } from "./acquire.ts";
import { acquireLock } from "./lock.ts";
import {
  loadPreviousRun,
  RUN_RECORD,
  renderRunRecord,
  updateLatest,
  writeOutputs,
} from "./outputs.ts";

/**
 * The whole run, in order: lock, acquire, normalize, match, diff against the
 * previous run, write outputs atomically, move `latest`, release the lock.
 */

export interface SyncOptions {
  readonly config: Config;
  readonly log: Logger;
  readonly dryRun: boolean;
  readonly http?: HttpClient;
  readonly now?: () => Date;
}

export interface SyncOutcome {
  readonly runId: string;
  readonly outputDirectory: string;
  readonly summary: string;
  readonly report: MatchReport;
  readonly diff: RunDiff;
}

export async function runSync(options: SyncOptions): Promise<SyncOutcome> {
  const { config, log } = options;
  const lock = await acquireLock(config.dataDir);
  try {
    const inputs = await acquireInputs(options);
    log.info(
      {
        runId: inputs.runId,
        source: inputs.source,
        acmeProjects: inputs.acme.projects.length,
        acmeSites: inputs.acme.sites.length,
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

    const report = matchProjects(normalized);
    log.info({ ...report.counts, reasons: report.reasons }, "matching complete");

    const previous = await loadPreviousRun(config.dataDir);
    const diff = diffRuns(previous, report.decisions);

    const outputDirectory = `${config.dataDir}/out/${inputs.runId}`;
    const summary = renderSummary({
      runId: inputs.runId,
      source: inputs.source,
      inputs,
      normalized,
      report,
      diff,
      outputDirectory,
    });

    const written = await writeOutputs(config.dataDir, inputs.runId, {
      "mapping.csv": renderMappingCsv(report.decisions),
      "review.csv": renderReviewCsv(report.decisions),
      "decisions.csv": renderDecisionsCsv(report.decisions),
      "pulley-unmatched.csv": renderUnmatchedPulleyCsv(report),
      "summary.txt": summary,
      [RUN_RECORD]: renderRunRecord({
        runId: inputs.runId,
        createdAt: (options.now?.() ?? new Date()).toISOString(),
        source: inputs.source,
        archiveDirectory: inputs.archiveDirectory,
        counts: report.counts,
        reasons: report.reasons,
        decisions: report.decisions,
        warnings: [...inputs.warnings, ...normalized.warnings],
      }),
    });
    await updateLatest(config.dataDir, inputs.runId);
    log.info({ outputDirectory: written, changes: diff.counts }, "outputs written");

    return { runId: inputs.runId, outputDirectory: written, summary, report, diff };
  } finally {
    await lock.release();
  }
}
