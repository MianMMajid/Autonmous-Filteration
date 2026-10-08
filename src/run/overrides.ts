import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parse as parseCsv } from "csv-parse/sync";
import {
  acmeState,
  isInScope,
  StatusVerdict,
  statusVerdict,
  Temporal,
  temporalVerdict,
} from "../domain/match/compat.ts";
import type { MatchDecision, MatchReport, OutputStatus } from "../domain/match/types.ts";
import { ReasonCode } from "../domain/match/types.ts";
import type { AcmeProject, PulleyRecord } from "../domain/model.ts";
import { SchemaError } from "../errors.ts";

/**
 * Human decisions that persist across runs.
 *
 * When Permit Ops resolves a `needs_review` row (or disagrees with a match),
 * they record it in `data/overrides.csv`:
 *
 *   acme_project_id,pulley_project_id,status,note
 *   3716.1005,prj_ae5zai,matched,confirmed with the lead 2026-10-09
 *   2523.1001,,no_match,Pulley never opened this one
 *
 * The matcher still runs; the override replaces its decision for that row
 * and is reported with reason OVERRIDE. Rows that cannot be applied (unknown
 * id, pathfinder target, bad status) are reported as problems and ignored,
 * never silently dropped.
 */

export const OVERRIDES_FILENAME = "overrides.csv";
const REQUIRED_COLUMNS = ["acme_project_id", "pulley_project_id", "status"] as const;

export interface Override {
  readonly acmeId: string;
  readonly pulleyId: string | null;
  readonly status: Extract<OutputStatus, "matched" | "no_match">;
  readonly note: string;
  /** Who decided; optional but recorded in run.json when present. */
  readonly author: string;
  /** ISO date of the decision; optional, validated when present. */
  readonly decidedAt: string | null;
}

export interface LoadedOverrides {
  readonly overrides: readonly Override[];
  readonly problems: readonly string[];
  /** Where the decisions came from and what exactly they said, for the run record. */
  readonly source: { readonly path: string; readonly sha256: string | null; readonly rows: number };
}

/** Read and validate the overrides file. A missing file is an empty list. */
export async function loadOverrides(path: string): Promise<LoadedOverrides> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return { overrides: [], problems: [], source: { path, sha256: null, rows: 0 } };
    }
    throw new SchemaError(`Could not read ${path}`, { cause: error });
  }
  const parsed = parseOverrides(text, path);
  return {
    ...parsed,
    source: {
      path,
      sha256: createHash("sha256").update(text).digest("hex"),
      rows: parsed.overrides.length + parsed.problems.length,
    },
  };
}

export function parseOverrides(
  text: string,
  source = OVERRIDES_FILENAME,
): Pick<LoadedOverrides, "overrides" | "problems"> {
  let rows: Record<string, string>[];
  try {
    rows = parseCsv(text, {
      bom: true,
      columns: true,
      skip_empty_lines: true,
      trim: true,
    }) as Record<string, string>[];
  } catch (error) {
    throw new SchemaError(`${source}: could not parse CSV`, { cause: error });
  }
  const problems: string[] = [];
  const header = rows[0] ? Object.keys(rows[0]) : [];
  if (rows.length > 0) {
    const missing = REQUIRED_COLUMNS.filter((column) => !header.includes(column));
    if (missing.length > 0) {
      throw new SchemaError(`${source}: missing column(s) ${missing.join(", ")}`, {
        details: { expected: [...REQUIRED_COLUMNS, "note"], found: header },
      });
    }
  }

  const overrides: Override[] = [];
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    const parsed = parseOverrideRow(row, index + 2, source);
    if (typeof parsed === "string") {
      problems.push(parsed);
      return;
    }
    if (seen.has(parsed.acmeId)) {
      problems.push(
        `${source} line ${index + 2}: duplicate acme_project_id ${parsed.acmeId}; first entry wins`,
      );
      return;
    }
    seen.add(parsed.acmeId);
    overrides.push(parsed);
  });
  return { overrides, problems };
}

/** One CSV row to an Override, or the problem with it. */
function parseOverrideRow(
  row: Record<string, string>,
  line: number,
  source: string,
): Override | string {
  const acmeId = row["acme_project_id"] ?? "";
  const pulleyId = row["pulley_project_id"] || null;
  const status = row["status"] ?? "";
  const decidedAt = row["decided_at"] ?? "";
  if (!/^\d{4}\.\d{4}$/.test(acmeId)) {
    return `${source} line ${line}: acme_project_id "${acmeId}" is not store.sequence`;
  }
  if (status !== "matched" && status !== "no_match") {
    return `${source} line ${line}: status must be matched or no_match, got "${status}"`;
  }
  if (status === "matched" && !pulleyId) {
    return `${source} line ${line}: matched requires a pulley_project_id`;
  }
  if (status === "no_match" && pulleyId) {
    return `${source} line ${line}: no_match must not carry a pulley_project_id`;
  }
  if (decidedAt && !/^\d{4}-\d{2}-\d{2}(T[0-9:.]+Z?)?$/.test(decidedAt)) {
    return `${source} line ${line}: decided_at "${decidedAt}" is not an ISO date`;
  }
  return {
    acmeId,
    pulleyId: status === "matched" ? pulleyId : null,
    status,
    note: row["note"] ?? "",
    author: row["author"] ?? "",
    decidedAt: decidedAt || null,
  };
}

export interface OverriddenDecision {
  readonly acmeId: string;
  /** What the matcher decided before the human decision replaced it. */
  readonly matcher: {
    readonly status: OutputStatus;
    readonly pulleyId: string | null;
    readonly reason: string;
  };
  readonly override: Override;
}

export interface AppliedOverrides {
  readonly report: MatchReport;
  readonly applied: number;
  readonly problems: readonly string[];
  readonly overridden: readonly OverriddenDecision[];
}

/** Replace matcher decisions with human ones, validating targets against the candidate pool. */
export function applyOverrides(
  report: MatchReport,
  loaded: Pick<LoadedOverrides, "overrides" | "problems">,
  inputs: { readonly acme: readonly AcmeProject[]; readonly pulley: readonly PulleyRecord[] },
): AppliedOverrides {
  const { pulley } = inputs;
  const problems = [...loaded.problems];
  const byAcme = new Map(report.decisions.map((d) => [d.acmeId, d]));
  const acmeById = new Map(inputs.acme.map((a) => [a.id, a]));
  const pulleyById = new Map(pulley.map((p) => [p.id, p]));
  const overridden: OverriddenDecision[] = [];
  let applied = 0;

  for (const override of loaded.overrides) {
    const current = byAcme.get(override.acmeId);
    if (!current) {
      problems.push(`override for ${override.acmeId} ignored: not in the Project Register`);
      continue;
    }
    const problem = targetProblem(override, acmeById.get(override.acmeId), pulleyById);
    if (problem) {
      problems.push(problem);
      continue;
    }
    const who = override.author ? ` by ${override.author}` : "";
    const when = override.decidedAt ? ` on ${override.decidedAt}` : "";
    overridden.push({
      acmeId: override.acmeId,
      matcher: { status: current.status, pulleyId: current.pulleyId, reason: current.reason },
      override,
    });
    byAcme.set(override.acmeId, {
      ...current,
      status: override.status,
      pulleyId: override.pulleyId,
      reason: ReasonCode.Override,
      tier: null,
      note: `override${who}${when}${override.note ? `: ${override.note}` : ""}`,
      statusDrift: null,
    });
    applied++;
  }

  // Human decisions are combined with automatic ones, so the shared-permit
  // rule (one building, one year) must hold over the combined result.
  const rejected = rejectConflictingOverrides(byAcme, report.decisions, acmeById, overridden);
  for (const r of rejected) {
    problems.push(
      `override for ${r.acmeId} needs reconfirmation: ${r.reason}; the matcher's decision was kept`,
    );
    applied--;
  }
  const kept = overridden.filter((o) => !rejected.some((r) => r.acmeId === o.acmeId));

  const decisions = report.decisions.map((d) => byAcme.get(d.acmeId) ?? d);
  return { report: withDecisions(report, decisions, pulley), applied, problems, overridden: kept };
}

/**
 * After overrides are applied, any Pulley project claimed by lines from
 * different sites or program years is an invalid assignment. Overrides in
 * such a group are withdrawn (the matcher's own decision is restored) until
 * the assignment is consistent; automatic claims are never changed here
 * because the matcher already resolved them.
 */
function rejectConflictingOverrides(
  byAcme: Map<string, MatchDecision>,
  original: readonly MatchDecision[],
  acmeById: ReadonlyMap<string, AcmeProject>,
  overridden: readonly OverriddenDecision[],
): Array<{ acmeId: string; reason: string }> {
  const rejected: Array<{ acmeId: string; reason: string }> = [];
  const originalById = new Map(original.map((d) => [d.acmeId, d]));
  const overriddenIds = new Set(overridden.map((o) => o.acmeId));
  const keyOf = (acmeId: string): string => {
    const a = acmeById.get(acmeId);
    return `${a?.siteId}|${a?.programYear}`;
  };
  // Withdrawing an override restores a matcher decision that may itself join
  // another group, so iterate to a fixed point (bounded; each pass withdraws
  // at least one override or stops).
  for (let pass = 0; pass < 10; pass++) {
    const offending = conflictingOverrides(byAcme, keyOf, overriddenIds, rejected);
    if (offending.length === 0) break;
    for (const { decision, pulleyId, others } of offending) {
      rejected.push({
        acmeId: decision.acmeId,
        reason: `${pulleyId} is also assigned to ${others}; one permit covers one building and one year`,
      });
      const restored = originalById.get(decision.acmeId);
      if (restored) byAcme.set(decision.acmeId, restored);
    }
  }
  return rejected;
}

/** Overrides sitting in a shared-permit group whose claims span more than one building or year. */
function conflictingOverrides(
  byAcme: ReadonlyMap<string, MatchDecision>,
  keyOf: (acmeId: string) => string,
  overriddenIds: ReadonlySet<string>,
  alreadyRejected: ReadonlyArray<{ acmeId: string }>,
): Array<{ decision: MatchDecision; pulleyId: string; others: string }> {
  const groups = new Map<string, MatchDecision[]>();
  for (const d of byAcme.values()) {
    if (d.status !== "matched" || d.pulleyId === null) continue;
    groups.set(d.pulleyId, [...(groups.get(d.pulleyId) ?? []), d]);
  }
  const out: Array<{ decision: MatchDecision; pulleyId: string; others: string }> = [];
  for (const [pulleyId, group] of groups) {
    if (new Set(group.map((d) => keyOf(d.acmeId))).size < 2) continue;
    for (const decision of group) {
      const isOverride = overriddenIds.has(decision.acmeId);
      const done = alreadyRejected.some((r) => r.acmeId === decision.acmeId);
      if (!isOverride || done) continue;
      const others = group
        .filter((o) => o !== decision)
        .map((o) => `${o.acmeId} (${keyOf(o.acmeId).split("|")[1]})`)
        .join(", ");
      out.push({ decision, pulleyId, others });
    }
  }
  return out;
}

/** Why a matched override's target cannot be applied, or null when it can. */
function targetProblem(
  override: Override,
  acme: AcmeProject | undefined,
  pulleyById: ReadonlyMap<string, PulleyRecord>,
): string | null {
  if (override.pulleyId === null) return null;
  const target = pulleyById.get(override.pulleyId);
  if (!target) {
    return `override for ${override.acmeId} ignored: ${override.pulleyId} is not a Pulley project`;
  }
  if (target.isPathfinder || target.isSignage) {
    return `override for ${override.acmeId} ignored: ${override.pulleyId} is ${target.isPathfinder ? "pathfinder" : "signage"}, excluded by the brief`;
  }
  // The brief's non-negotiable rules still apply to human decisions, and
  // upstream facts can change after a decision was recorded.
  const blocker = acme ? reconfirmationNeeded(acme, target) : null;
  if (blocker) {
    return `override for ${override.acmeId} needs reconfirmation: ${blocker}; the matcher's decision was kept`;
  }
  return null;
}

/** Why a recorded match can no longer be applied as-is, or null when it still holds. */
function reconfirmationNeeded(acme: AcmeProject, target: PulleyRecord): string | null {
  if (!isInScope(acme, target)) {
    const state = acmeState(acme);
    return target.banner !== acme.banner
      ? `${target.id} is ${target.organization}, the Acme site is ${acme.banner ?? "unknown banner"}`
      : `${target.id} is in ${target.state}, the Acme site is in ${state ?? "an unknown state"}`;
  }
  if (temporalVerdict(acme, target) === Temporal.Conflict) {
    return `${target.id} belongs to another program year than ${acme.id} (${acme.programYear}); one permit covers one year`;
  }
  const verdict = statusVerdict(acme.status, target.status);
  if (verdict === StatusVerdict.Conflict) {
    return `Acme is now ${acme.status} and ${target.id} is ${target.status}; canceled only counts on both sides`;
  }
  if (verdict === StatusVerdict.Unknown) {
    return `status "${target.status}" or "${acme.status}" has no known meaning`;
  }
  return null;
}

/** Rebuild the derived parts of a report after decisions change. */
export function withDecisions(
  report: MatchReport,
  decisions: readonly MatchDecision[],
  pulley: readonly PulleyRecord[],
): MatchReport {
  const counts = { matched: 0, needs_review: 0, no_match: 0 };
  const reasons: Record<string, number> = {};
  let statusDrift = 0;
  for (const d of decisions) {
    counts[d.status]++;
    reasons[d.reason] = (reasons[d.reason] ?? 0) + 1;
    if (d.statusDrift !== null) statusDrift++;
  }
  const claimed = new Set(
    decisions.map((d) => d.pulleyId).filter((id): id is string => id !== null),
  );
  const unmatchedPulley = pulley
    .filter((p) => !p.isPathfinder && !p.isSignage && !claimed.has(p.id))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((p) => ({ id: p.id, name: p.name, status: p.status }));
  return { ...report, decisions, counts, reasons, unmatchedPulley, statusDrift };
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
