import { stringify } from "csv-stringify/sync";
import type { MatchDecision, MatchReport } from "../domain/match/types.ts";

/**
 * CSV renderers. All output is sorted by Acme id so two runs over the same
 * inputs produce byte-identical files and diffs stay readable.
 */

/** Exactly the header the brief requires, including its spelling of "pcroject". */
export const MAPPING_COLUMNS = ["acme_pcroject_id", "pulley_project_id", "status"] as const;

export function sortDecisions(decisions: readonly MatchDecision[]): MatchDecision[] {
  return [...decisions].sort((a, b) => a.acmeId.localeCompare(b.acmeId));
}

/** The deliverable: one row per Acme project. */
export function renderMappingCsv(decisions: readonly MatchDecision[]): string {
  const rows = sortDecisions(decisions).map((d) => ({
    acme_pcroject_id: d.acmeId,
    pulley_project_id: d.pulleyId ?? "",
    status: d.status,
  }));
  return stringify(rows, { header: true, columns: [...MAPPING_COLUMNS] });
}

const CANDIDATE_SLOTS = 3;

const DECISION_COLUMNS = [
  "acme_project_id",
  "acme_name",
  "acme_type",
  "program_year",
  "acme_status",
  "status",
  "pulley_project_id",
  "reason",
  "tier",
  "note",
  "recommended_action",
  "status_drift",
  "acme_city",
  "acme_street",
  "acme_dates",
  ...Array.from({ length: CANDIDATE_SLOTS }, (_, i) => i + 1).flatMap((n) => [
    `candidate_${n}_id`,
    `candidate_${n}_name`,
    `candidate_${n}_status`,
    `candidate_${n}_type`,
    `candidate_${n}_city`,
    `candidate_${n}_street`,
    `candidate_${n}_dates`,
    `candidate_${n}_evidence`,
    `candidate_${n}_score`,
  ]),
] as const;

/** What a reviewer should do with a row, phrased for the person, derived from the reason. */
export function recommendedAction(d: MatchDecision): string {
  switch (d.reason) {
    case "EVIDENCE_CONFLICT":
      return d.reviewResolution === "human_confirmation"
        ? "Verify the street or milestone discrepancy against permit evidence; correct the source or record an explained decision in overrides.csv with reviewer and date"
        : "Verify the conflicting identity, year, or lifecycle evidence and correct the source before matching; an override cannot bypass this hard conflict";
    case "INSUFFICIENT_EVIDENCE":
      return "Confirm the permit's building and program year using independent evidence; correct the source or record a verified human decision in overrides.csv";
    case "IDENTITY_DISPUTED":
      return "Resolve the conflicting source rows or site identity in SiteLedger, then rerun; a matched override cannot resolve disputed identity";
    case "AMBIGUOUS":
      return "Two or more Pulley projects fit equally; pick the real one (the other is likely a duplicate) and record it in overrides.csv";
    case "STATUS_CONFLICT":
      return "One side is canceled or closed and the other is not; confirm the true status, fix it in the lagging system, or record no_match";
    case "TYPE_MISMATCH":
      return "The only project at this store is a different kind of work; confirm whether this line was folded into that permit";
    case "YEAR_CONFLICT":
      return "This permit is claimed by lines from different program years; decide which year it covers";
    case "ID_OUTSIDE_SCOPE":
      return "The Acme id is on a project filed under the other banner or state; correct the Pulley project or record no_match";
    case "STATUS_UNKNOWN":
      return "A status value is new; tell engineering what it means so the rule can be applied";
    case "WEAK_EVIDENCE":
      return "Only locality evidence; verify by site, and open a Pulley project if none exists";
    case "UNRELATED_ONLY":
    case "EXCLUDED_ONLY":
    case "NO_CANDIDATE":
      return "";
    default:
      return "";
  }
}

function decisionRow(d: MatchDecision): Record<string, string | number> {
  const row: Record<string, string | number> = {
    acme_project_id: d.acmeId,
    acme_name: d.acmeName,
    acme_type: d.acmeType,
    program_year: d.programYear,
    acme_status: d.acmeStatus,
    status: d.status,
    pulley_project_id: d.pulleyId ?? "",
    reason: d.reason,
    tier: d.tier ?? "",
    note: d.note,
    recommended_action: d.status === "needs_review" ? recommendedAction(d) : "",
    status_drift: d.statusDrift ?? "",
    acme_city: d.acmeCity,
    acme_street: d.acmeStreet,
    acme_dates: d.acmeDates,
  };
  for (let i = 0; i < CANDIDATE_SLOTS; i++) {
    const c = d.candidates[i];
    const n = i + 1;
    row[`candidate_${n}_id`] = c?.pulleyId ?? "";
    row[`candidate_${n}_name`] = c?.pulleyName ?? "";
    row[`candidate_${n}_status`] = c?.pulleyStatus ?? "";
    row[`candidate_${n}_type`] = c?.pulleyType ?? "";
    row[`candidate_${n}_city`] = c?.pulleyCity ?? "";
    row[`candidate_${n}_street`] = c?.pulleyStreet ?? "";
    row[`candidate_${n}_dates`] = c?.pulleyDates ?? "";
    row[`candidate_${n}_evidence`] = c?.evidenceSummary ?? "";
    row[`candidate_${n}_score`] = c?.score ?? "";
  }
  return row;
}

/** Every decision with its evidence, for audit. */
export function renderDecisionsCsv(decisions: readonly MatchDecision[]): string {
  return stringify(sortDecisions(decisions).map(decisionRow), {
    header: true,
    columns: [...DECISION_COLUMNS],
    // Names and notes are upstream free text; never let a cell start a formula.
    escape_formulas: true,
  });
}

/** Only the rows a human must look at. Same columns as the audit file. */
export function renderReviewCsv(decisions: readonly MatchDecision[]): string {
  return renderDecisionsCsv(decisions.filter((d) => d.status === "needs_review"));
}

/** Candidate-pool Pulley projects that no Acme project claimed. */
export function renderUnmatchedPulleyCsv(report: MatchReport): string {
  const rows = [...report.unmatchedPulley]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((p) => ({ pulley_project_id: p.id, pulley_name: p.name, pulley_status: p.status }));
  return stringify(rows, {
    header: true,
    columns: ["pulley_project_id", "pulley_name", "pulley_status"],
    escape_formulas: true,
  });
}
