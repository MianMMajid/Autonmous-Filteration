import type { MatchReport } from "../domain/match/types.ts";
import type { NormalizedInputs } from "../domain/model.ts";
import type { AcquiredInputs } from "../run/acquire.ts";
import type { QualityAssessment } from "../run/quality.ts";
import type { PreviousDecision, RunDiff } from "./diff.ts";
import { reviewWorkload } from "./review.ts";

/**
 * Human-readable run summary. This is what Permit Ops reads first, so it
 * leads with counts and changes and keeps file paths to the end.
 */

export interface SummaryInput {
  readonly runId: string;
  readonly source: AcquiredInputs["source"];
  readonly inputs: AcquiredInputs;
  readonly normalized: NormalizedInputs;
  readonly report: MatchReport;
  readonly diff: RunDiff;
  readonly overrides: {
    readonly applied: number;
    readonly problems: readonly string[];
    readonly path: string;
  };
  readonly quality: QualityAssessment & { readonly accepted: boolean };
  readonly previousDecisions: readonly PreviousDecision[] | null;
  readonly rulesVersion: string;
  readonly outputDirectory: string;
}

const MAX_LISTED = 25;

export function renderSummary(s: SummaryInput): string {
  const sections = [
    headerSection(s),
    qualitySection(s.quality),
    changesSection(s.diff),
    reviewSection(s.report),
    workloadSection(s.report, s.previousDecisions),
    statusDriftSection(s.report),
    overridesSection(s.overrides),
    warningsSection(s),
    pulleySideSection(s.report),
    filesSection(s.outputDirectory),
    [provenanceLine(s.rulesVersion)],
  ];
  return `${sections
    .filter((lines) => lines.length > 0)
    .map((lines) => lines.join("\n"))
    .join("\n\n")}\n`;
}

function headerSection(s: SummaryInput): string[] {
  const total = s.report.decisions.length;
  const pct = (n: number): string => (total === 0 ? "0.0" : ((100 * n) / total).toFixed(1));
  const pathfinder = s.normalized.pulley.filter((p) => p.isPathfinder).length;
  const signage = s.normalized.pulley.filter((p) => p.isSignage).length;
  const pool = s.normalized.pulley.length - pathfinder - signage;
  const reasons = Object.entries(s.report.reasons)
    .sort(([, a], [, b]) => b - a)
    .map(([reason, n]) => `${reason} ${n}`)
    .join(", ");
  return [
    `SiteLedger sync run ${s.runId} (${s.source === "live" ? "live data" : "replayed archive"})`,
    "",
    `Inputs: ${s.normalized.acme.length} Acme projects, ${s.normalized.sites.length} sites, ` +
      `${s.normalized.pulley.length} Pulley projects (${pool} candidates after excluding ${pathfinder} pathfinder and ${signage} signage)`,
    `Results: matched ${s.report.counts.matched} (${pct(s.report.counts.matched)}%), ` +
      `needs_review ${s.report.counts.needs_review}, no_match ${s.report.counts.no_match}`,
    `By reason: ${reasons}`,
  ];
}

function qualitySection(q: SummaryInput["quality"]): string[] {
  if (q.blockers.length === 0 && q.warnings.length === 0) return [];
  const lines: string[] = [];
  if (q.blockers.length > 0) {
    lines.push(
      q.accepted
        ? "Input quality: publication was forced with --accept-input-change despite:"
        : "Input quality: publication blocked:",
    );
    for (const b of q.blockers) lines.push(`  ${b}`);
  }
  if (q.warnings.length > 0) {
    lines.push("Input quality notes:");
    for (const w of q.warnings) lines.push(`  ${w}`);
  }
  return lines;
}

/** How much new review work this run created, versus rows already pending. */
function workloadSection(
  report: MatchReport,
  previous: readonly PreviousDecision[] | null,
): string[] {
  if (!previous) return [];
  const workload = reviewWorkload(previous, report.decisions);
  const fresh = workload.fresh.map((d) => d.acmeId);
  const { resolved, removed, changed, unchanged } = workload;
  return [
    `Review workload: ${fresh.length} new, ${resolved.length} resolved since the previous run, ${changed.length + unchanged.length} still pending from before`,
    `Review evidence: ${changed.length} changed or lacking a comparison baseline, ${unchanged.length} unchanged; ${removed.length} removed from the register (not resolved)`,
    "  review-changes.csv contains new/changed cases since the previous run; review.csv retains the entire backlog",
    ...(fresh.length > 0 ? [`  new: ${fresh.slice(0, MAX_LISTED).join(", ")}`] : []),
    ...(resolved.length > 0 ? [`  resolved: ${resolved.slice(0, MAX_LISTED).join(", ")}`] : []),
    ...(removed.length > 0 ? [`  removed: ${removed.slice(0, MAX_LISTED).join(", ")}`] : []),
  ];
}

function changesSection(diff: RunDiff): string[] {
  if (diff.previousRunId === null) return ["Changes: first run, nothing to compare against."];
  const c = diff.counts;
  const lines = [
    `Changes since ${diff.previousRunId}: ${c.newlyMatched} newly matched, ${c.lostMatch} lost match, ` +
      `${c.rematched} rematched, ${c.statusChanged} other status change, ` +
      `${diff.newAcmeIds.length} new Acme project(s), ${diff.removedAcmeIds.length} removed`,
  ];
  for (const change of diff.changes.slice(0, MAX_LISTED)) {
    lines.push(`  ${change.acmeId}: ${describeState(change.from)} -> ${describeState(change.to)}`);
  }
  if (diff.changes.length > MAX_LISTED) {
    lines.push(`  ... ${diff.changes.length - MAX_LISTED} more in decisions.csv`);
  }
  if (diff.newAcmeIds.length > 0)
    lines.push(`  new: ${diff.newAcmeIds.slice(0, MAX_LISTED).join(", ")}`);
  if (diff.removedAcmeIds.length > 0) {
    lines.push(`  removed: ${diff.removedAcmeIds.slice(0, MAX_LISTED).join(", ")}`);
  }
  return lines;
}

function describeState(state: { status: string; pulleyId: string | null }): string {
  return state.pulleyId ? `${state.status} (${state.pulleyId})` : state.status;
}

function reviewSection(report: MatchReport): string[] {
  const review = report.decisions.filter((d) => d.status === "needs_review");
  const lines = [`Needs review (${review.length}):`];
  if (review.length === 0) lines.push("  none");
  for (const d of review.slice(0, MAX_LISTED)) {
    lines.push(`  ${d.acmeId}  ${d.reason.padEnd(16)} ${d.note}`);
  }
  if (review.length > MAX_LISTED)
    lines.push(`  ... ${review.length - MAX_LISTED} more in review.csv`);
  return lines;
}

function statusDriftSection(report: MatchReport): string[] {
  const rows = report.decisions.filter((d) => d.statusDrift !== null);
  if (rows.length === 0) return [];
  const lines = [
    `Status differences on matched rows (${rows.length}), worth syncing between the systems:`,
  ];
  for (const d of rows.slice(0, MAX_LISTED)) {
    lines.push(`  ${d.acmeId} -> ${d.pulleyId}  ${d.statusDrift}`);
  }
  if (rows.length > MAX_LISTED)
    lines.push(`  ... ${rows.length - MAX_LISTED} more in decisions.csv (status_drift column)`);
  return lines;
}

function overridesSection(o: SummaryInput["overrides"]): string[] {
  if (o.applied === 0 && o.problems.length === 0) return [];
  return [
    `Overrides: ${o.applied} applied from ${o.path}` +
      (o.problems.length > 0 ? `, ${o.problems.length} could not be applied:` : ""),
    ...o.problems.map((problem) => `  ${problem}`),
  ];
}

function warningsSection(s: SummaryInput): string[] {
  const warnings = [...s.inputs.warnings, ...s.normalized.warnings];
  const drift = s.inputs.vocabulary;
  if (warnings.length === 0 && drift.length === 0) return [];
  return [
    "Warnings:",
    ...warnings.map((w) => `  ${w}`),
    ...drift.map((v) => `  unknown ${v.source} ${v.field} value "${v.value}" (${v.count}x)`),
  ];
}

function pulleySideSection(report: MatchReport): string[] {
  return [
    `Pulley side: ${report.unmatchedPulley.length} candidate project(s) not claimed by any Acme project (pulley-unmatched.csv); ` +
      `${report.pulleyIdsNotInRegister.length} Pulley name(s) cite an Acme id that is not in the register`,
    ...report.pulleyIdsNotInRegister.slice(0, 10).map((x) => `  ${x.pulleyId} cites ${x.acmeId}`),
  ];
}

function filesSection(outputDirectory: string): string[] {
  return [
    `Files in ${outputDirectory}:`,
    "  mapping.csv           the deliverable (acme_pcroject_id,pulley_project_id,status)",
    "  review.csv            needs_review rows with reasons and candidates",
    "  review-changes.csv    new or changed review cases since the previous run",
    "  decisions.csv         every row with evidence, for audit",
    "  pulley-unmatched.csv  Pulley projects nobody claimed",
    "  run.json              machine-readable record used for the next run's diff",
    "  handoff.md            run-specific counts, provenance and draft Account Lead response",
    "  overrides.snapshot.csv exact human decisions used for this run",
    "  output-manifest.json  hashes and byte lengths for integrity verification",
    "  summary.txt           this text",
  ];
}

export function provenanceLine(rulesVersion: string): string {
  return `Rules version ${rulesVersion}; inputs, hashes, config, and overrides are recorded in run.json`;
}
