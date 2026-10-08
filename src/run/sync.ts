import type { Config } from "../config.ts";
import { matchProjects, RULES_VERSION } from "../domain/match/matcher.ts";
import type { MatchReport } from "../domain/match/types.ts";
import { normalizeInputs } from "../domain/normalize/build.ts";
import { IoError, QualityError } from "../errors.ts";
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
import { implementationSha256, TOOL_VERSION } from "../version.ts";
import { type AcquireOptions, acquireInputs } from "./acquire.ts";
import { assertPublicationInvariants } from "./invariants.ts";
import { acquireLock } from "./lock.ts";
import {
  loadPreviousRun,
  pruneRuns,
  RUN_RECORD,
  renderRunRecord,
  updateLatest,
  writeOutputs,
} from "./outputs.ts";
import { applyOverrides, loadOverrides } from "./overrides.ts";
import { assessInputQuality, type QualityAssessment } from "./quality.ts";

/**
 * The whole run, in order: lock, acquire, normalize, match, apply human
 * decisions, assess input quality against the previous run, diff, stage
 * every artifact, publish by moving `latest`, prune old runs, release.
 *
 * Publication is the commit point. Anything after it (retention) is
 * reported separately and never undoes a published result.
 */

export interface SyncOptions {
  readonly config: Config;
  readonly log: Logger;
  readonly dryRun: boolean;
  /** With dryRun: replay this archived run instead of the newest one. */
  readonly replayRunId?: string;
  /** Publish even when input-quality blockers stand (recorded in run.json). */
  readonly acceptInputChange?: boolean;
  readonly http?: HttpClient;
  readonly now?: () => Date;
}

export interface SyncOutcome {
  readonly runId: string;
  readonly outputDirectory: string;
  readonly summary: string;
  readonly report: MatchReport;
  readonly diff: RunDiff;
  readonly quality: QualityAssessment;
}

/** Refuse to publish on blockers unless the operator accepted the change; returns that acceptance. */
function enforceQuality(
  quality: QualityAssessment,
  accepted: boolean,
  archiveDirectory: string,
  log: Logger,
): boolean {
  for (const w of quality.warnings) log.warn(w);
  if (quality.blockers.length === 0) return accepted;
  if (!accepted) {
    throw new QualityError(
      `Publication refused; the inputs look incomplete or very different from the previous run: ${quality.blockers.join("; ")}. ` +
        `The raw inputs are archived under ${archiveDirectory} for inspection. ` +
        "If this change is expected, rerun with --accept-input-change.",
      { details: { blockers: quality.blockers, warnings: quality.warnings } },
    );
  }
  log.warn({ blockers: quality.blockers }, "input-quality blockers accepted by the operator");
  return true;
}

export async function runSync(options: SyncOptions): Promise<SyncOutcome> {
  const { config, log } = options;
  const now = options.now ?? (() => new Date());
  const lock = await acquireLock(config.dataDir);
  try {
    const implementation = await implementationSha256();
    const acquireOptions: AcquireOptions = {
      config,
      log,
      dryRun: options.dryRun,
      ...(options.replayRunId !== undefined ? { replayRunId: options.replayRunId } : {}),
      ...(options.http !== undefined ? { http: options.http } : {}),
      now,
    };
    const inputs = await acquireInputs(acquireOptions);
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

    const matched = matchProjects(normalized);
    log.info({ ...matched.counts, reasons: matched.reasons }, "matching complete");

    const loadedOverrides = await loadOverrides(config.overridesFile);
    const overrides = applyOverrides(matched, loadedOverrides, normalized);
    for (const problem of overrides.problems) log.warn(problem);
    if (overrides.applied > 0) log.info({ applied: overrides.applied }, "overrides applied");
    const report = overrides.report;
    assertPublicationInvariants(report.decisions, normalized.acme, normalized.pulley);

    const previous = await loadPreviousRun(config.dataDir);
    const counts = {
      acmeProjects: inputs.acme.projects.length,
      acmeSites: inputs.acme.sites.length,
      acmeKeyDates: inputs.acme.keyDates.length,
      pulleyProjects: inputs.pulley.length,
    };
    const quality = assessInputQuality({
      counts,
      matched: report.counts.matched,
      previous: previous
        ? { runId: previous.runId, inputCounts: previous.inputCounts, matched: previous.matched }
        : null,
    });
    const accepted = enforceQuality(
      quality,
      options.acceptInputChange === true,
      inputs.archiveDirectory,
      log,
    );

    const diff = diffRuns(previous, report.decisions);
    const outputDirectory = `${config.dataDir}/out/${inputs.runId}`;
    const summary = renderSummary({
      runId: inputs.runId,
      source: inputs.source,
      inputs,
      normalized,
      report,
      diff,
      overrides: { applied: overrides.applied, problems: overrides.problems },
      quality: { ...quality, accepted },
      previousDecisions: previous?.decisions ?? null,
      rulesVersion: RULES_VERSION,
      outputDirectory,
    });

    const publishedAt = now().toISOString();
    const written = await writeOutputs(config.dataDir, inputs.runId, {
      "mapping.csv": renderMappingCsv(report.decisions),
      "review.csv": renderReviewCsv(report.decisions),
      "decisions.csv": renderDecisionsCsv(report.decisions),
      "pulley-unmatched.csv": renderUnmatchedPulleyCsv(report),
      "summary.txt": summary,
      [RUN_RECORD]: renderRunRecord({
        runId: inputs.runId,
        createdAt: publishedAt,
        publishedAt,
        sourceAcquiredAt: inputs.sourceAcquiredAt,
        source: inputs.source,
        toolVersion: TOOL_VERSION,
        rulesVersion: RULES_VERSION,
        implementationSha256: implementation,
        inputs: { archiveDirectory: inputs.archiveDirectory, files: inputs.archiveFiles, counts },
        config: {
          siteLedgerBaseUrl: config.siteLedger.baseUrl,
          pulleyBaseUrl: config.pulley.baseUrl,
          dataDir: config.dataDir,
          overridesFile: config.overridesFile,
          retainRuns: config.retainRuns,
          dryRun: options.dryRun,
          replayRunId: options.replayRunId ?? "",
          acceptInputChange: accepted,
        },
        quality: { ...quality, accepted },
        overrides: {
          path: loadedOverrides.source.path,
          sha256: loadedOverrides.source.sha256,
          applied: overrides.applied,
          problems: overrides.problems,
          overridden: overrides.overridden,
        },
        counts: report.counts,
        reasons: report.reasons,
        decisions: report.decisions,
        warnings: [...inputs.warnings, ...normalized.warnings],
      }),
    });
    await updateLatest(config.dataDir, inputs.runId);
    log.info({ outputDirectory: written, changes: diff.counts }, "outputs published");

    // Retention runs after the commit point; its failure is reported, never fatal.
    try {
      const pruned = await pruneRuns(config.dataDir, config.retainRuns);
      if (pruned.length > 0) log.info({ removed: pruned.length }, "old runs pruned");
    } catch (error) {
      if (error instanceof IoError)
        log.warn({ err: error.message }, "retention failed after publication; outputs are intact");
      else throw error;
    }

    return { runId: inputs.runId, outputDirectory: written, summary, report, diff, quality };
  } finally {
    try {
      await lock.release();
    } catch (error) {
      log.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "lock cleanup failed; inspect the lock before the next run",
      );
    }
  }
}
