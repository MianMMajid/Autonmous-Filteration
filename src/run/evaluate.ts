import { parse } from "csv-parse/sync";
import { z } from "zod";
import { SchemaError } from "../errors.ts";
import { RUN_ID_PATTERN, sha256Hex } from "./archive.ts";
import { readRegularFile } from "./integrity.ts";
import { readRunRecord } from "./outputs.ts";

const labelSchema = z.object({
  acme_project_id: z.string().regex(/^\d{4}\.\d{4}$/),
  expected_status: z.enum(["matched", "no_match", "unresolved"]),
  allowed_pulley_ids: z.string(),
  reviewer: z.string().min(1),
  decided_at: z.iso.date(),
  source_run_id: z.string().regex(RUN_ID_PATTERN),
  rationale: z.string().min(1),
});
const columns = Object.keys(labelSchema.shape);
type Label = z.output<typeof labelSchema>;
type Decision = Awaited<ReturnType<typeof readRunRecord>>["decisions"][number];
export interface EvaluationCounts {
  labeled: number;
  resolved: number;
  unresolved: number;
  autoMatched: number;
  correctAutoMatches: number;
  falseAutoMatches: number;
  predictedNoMatch: number;
  falseNoMatches: number;
  needsReview: number;
  overridesExcluded: number;
}
const empty = (): EvaluationCounts => ({
  labeled: 0,
  resolved: 0,
  unresolved: 0,
  autoMatched: 0,
  correctAutoMatches: 0,
  falseAutoMatches: 0,
  predictedNoMatch: 0,
  falseNoMatches: 0,
  needsReview: 0,
  overridesExcluded: 0,
});
const rates = (counts: EvaluationCounts) => ({
  ...counts,
  precision: counts.autoMatched ? counts.correctAutoMatches / counts.autoMatched : null,
  falseNoMatchRate: counts.predictedNoMatch
    ? counts.falseNoMatches / counts.predictedNoMatch
    : null,
});

/** Independent labels are read-only and never become overrides. No labels means no accuracy claim. */
export async function evaluateRun(dataDir: string, runId: string, labelsPath: string) {
  const record = await readRunRecord(dataDir, runId);
  const bytes = await readRegularFile(labelsPath, 8 * 1024 * 1024);
  const raw = parseLabels(bytes);
  const inputs = record.inputs as typeof record.inputs & { archiveDirectory?: unknown };
  const archiveId =
    typeof inputs?.archiveDirectory === "string"
      ? inputs.archiveDirectory.split(/[\\/]/).pop()
      : undefined;
  if (!archiveId) throw new SchemaError("Run does not identify its source snapshot");
  const decisions = new Map(record.decisions.map((d) => [d.acmeId, d]));
  const seen = new Set<string>();
  const stores = new Set<string>();
  const overall = empty();
  const groups = new Map<string, EvaluationCounts>();
  const disagreements: Array<{
    acmeId: string;
    expected: string;
    actual: string;
    pulleyId: string | null;
  }> = [];
  for (const row of raw) {
    const label = labelSchema.safeParse(row);
    if (!label.success)
      throw new SchemaError(
        "Label requires a valid project, status, reviewer, date, source run and rationale",
      );
    const truth = label.data;
    if (seen.has(truth.acme_project_id)) throw new SchemaError("Duplicate adjudicated project");
    seen.add(truth.acme_project_id);
    stores.add(truth.acme_project_id.split(".")[0] ?? "");
    if (truth.source_run_id !== archiveId)
      throw new SchemaError("Labels refer to a different input snapshot");
    const decision = decisions.get(truth.acme_project_id);
    if (!decision) throw new SchemaError("Label references a project absent from this run");
    const allowed = allowedTargets(truth);
    const keys = [
      `tier:${String(decision["tier"] ?? "none")}`,
      `reason:${String(decision["reason"] ?? "unknown")}`,
    ];
    const buckets = [
      overall,
      ...keys.map((key) => {
        const value = groups.get(key) ?? empty();
        groups.set(key, value);
        return value;
      }),
    ];
    for (const bucket of buckets) countDecision(bucket, decision, truth, allowed);
    if (isDisagreement(decision, truth, allowed))
      disagreements.push({
        acmeId: decision.acmeId,
        expected: truth.expected_status,
        actual: decision.status,
        pulleyId: decision.pulleyId,
      });
  }
  return {
    runId,
    sourceRunId: archiveId,
    labelsSha256: sha256Hex(bytes),
    population: record.decisions.length,
    labeledStoreGroups: stores.size,
    labelCoverage: overall.labeled / record.decisions.length,
    overall: rates(overall),
    byGroup: Object.fromEntries(
      [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, count]) => [key, rates(count)]),
    ),
    disagreements,
    limitations:
      "Descriptive results on adjudicated rows only. Overrides and unresolved truth excluded from accuracy. Sampling and store correlations must be reviewed before generalizing; no independent holdout or production accuracy is implied.",
  };
}

function allowedTargets(truth: Label): string[] {
  const allowed = truth.allowed_pulley_ids
    ? truth.allowed_pulley_ids.split(";").map((id) => id.trim())
    : [];
  if (
    allowed.some((id) => id.length === 0 || id.length > 256 || /[\r\n\0]/.test(id)) ||
    new Set(allowed).size !== allowed.length ||
    (truth.expected_status === "matched" && allowed.length === 0) ||
    (truth.expected_status === "no_match" && allowed.length > 0)
  )
    throw new SchemaError("Invalid allowed targets for adjudicated status");
  return allowed;
}
function countDecision(
  bucket: EvaluationCounts,
  decision: Decision,
  truth: Label,
  allowed: string[],
): void {
  bucket.labeled++;
  if (decision["reason"] === "OVERRIDE") {
    bucket.overridesExcluded++;
    return;
  }
  if (truth.expected_status === "unresolved") {
    bucket.unresolved++;
    return;
  }
  bucket.resolved++;
  if (decision.status === "matched") {
    bucket.autoMatched++;
    if (truth.expected_status === "matched" && allowed.includes(decision.pulleyId ?? ""))
      bucket.correctAutoMatches++;
    else bucket.falseAutoMatches++;
  } else if (decision.status === "no_match") {
    bucket.predictedNoMatch++;
    if (truth.expected_status === "matched") bucket.falseNoMatches++;
  } else bucket.needsReview++;
}
function isDisagreement(decision: Decision, truth: Label, allowed: string[]): boolean {
  if (
    decision["reason"] === "OVERRIDE" ||
    truth.expected_status === "unresolved" ||
    decision.status === "needs_review"
  )
    return false;
  return (
    decision.status !== truth.expected_status ||
    (decision.status === "matched" && !allowed.includes(decision.pulleyId ?? ""))
  );
}

function parseLabels(bytes: Buffer): unknown[] {
  let raw: unknown[];
  try {
    raw = parse(bytes, {
      bom: true,
      skip_empty_lines: true,
      trim: true,
      max_record_size: 65536,
      columns: (header: string[]) => {
        if (
          header.length !== columns.length ||
          header.some((name, index) => name !== columns[index])
        )
          throw new Error("Incorrect label header");
        return header;
      },
    }) as unknown[];
  } catch (error) {
    throw new SchemaError("Invalid adjudication CSV or header", { cause: error });
  }
  if (raw.length === 0 || raw.length > 20_000)
    throw new SchemaError("Evaluation requires 1–20000 adjudicated rows");
  return raw;
}
