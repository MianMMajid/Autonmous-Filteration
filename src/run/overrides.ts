import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseCsv } from "csv-parse/sync";
import { acmeState, StatusVerdict, statusVerdict } from "../domain/match/compat.ts";
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
}

export interface LoadedOverrides {
  readonly overrides: readonly Override[];
  readonly problems: readonly string[];
}

/** Read and validate the overrides file. A missing file is an empty list. */
export async function loadOverrides(dataDir: string): Promise<LoadedOverrides> {
  const path = join(dataDir, OVERRIDES_FILENAME);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { overrides: [], problems: [] };
    throw new SchemaError(`Could not read ${path}`, { cause: error });
  }
  return parseOverrides(text, path);
}

export function parseOverrides(text: string, source = OVERRIDES_FILENAME): LoadedOverrides {
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
    const line = index + 2;
    const acmeId = row["acme_project_id"] ?? "";
    const pulleyId = row["pulley_project_id"] || null;
    const status = row["status"] ?? "";
    const note = row["note"] ?? "";
    if (!/^\d{4}\.\d{4}$/.test(acmeId)) {
      problems.push(`${source} line ${line}: acme_project_id "${acmeId}" is not store.sequence`);
      return;
    }
    if (seen.has(acmeId)) {
      problems.push(
        `${source} line ${line}: duplicate acme_project_id ${acmeId}; first entry wins`,
      );
      return;
    }
    if (status !== "matched" && status !== "no_match") {
      problems.push(`${source} line ${line}: status must be matched or no_match, got "${status}"`);
      return;
    }
    if (status === "matched" && !pulleyId) {
      problems.push(`${source} line ${line}: matched requires a pulley_project_id`);
      return;
    }
    if (status === "no_match" && pulleyId) {
      problems.push(`${source} line ${line}: no_match must not carry a pulley_project_id`);
      return;
    }
    seen.add(acmeId);
    overrides.push({ acmeId, pulleyId: status === "matched" ? pulleyId : null, status, note });
  });
  return { overrides, problems };
}

export interface AppliedOverrides {
  readonly report: MatchReport;
  readonly applied: number;
  readonly problems: readonly string[];
}

/** Replace matcher decisions with human ones, validating targets against the candidate pool. */
export function applyOverrides(
  report: MatchReport,
  loaded: LoadedOverrides,
  inputs: { readonly acme: readonly AcmeProject[]; readonly pulley: readonly PulleyRecord[] },
): AppliedOverrides {
  const { pulley } = inputs;
  const problems = [...loaded.problems];
  const byAcme = new Map(report.decisions.map((d) => [d.acmeId, d]));
  const acmeById = new Map(inputs.acme.map((a) => [a.id, a]));
  const pulleyById = new Map(pulley.map((p) => [p.id, p]));
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
    byAcme.set(override.acmeId, {
      ...current,
      status: override.status,
      pulleyId: override.pulleyId,
      reason: ReasonCode.Override,
      tier: null,
      note: override.note ? `override: ${override.note}` : "override",
      statusDrift: null,
    });
    applied++;
  }

  const decisions = report.decisions.map((d) => byAcme.get(d.acmeId) ?? d);
  return { report: withDecisions(report, decisions, pulley), applied, problems };
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
  if (acme.banner !== null && target.banner !== acme.banner) {
    return `${target.id} is ${target.organization}, the Acme site is ${acme.banner}`;
  }
  const state = acmeState(acme);
  if (state !== null && target.state !== state) {
    return `${target.id} is in ${target.state}, the Acme site is in ${state}`;
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
