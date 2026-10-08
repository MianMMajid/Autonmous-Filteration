/**
 * Semantic input-quality checks.
 *
 * Schemas prove that an export has the right columns and types. They do not
 * prove it is complete. A valid Project Register with zero rows would
 * otherwise publish a mapping that "removes" every project. These checks
 * compare the current inputs and outcome against the previous successful
 * run and block publication on collapses, unless the operator explicitly
 * accepts the change.
 */

export interface InputCounts {
  readonly acmeProjects: number;
  readonly acmeSites: number;
  readonly acmeKeyDates: number;
  readonly pulleyProjects: number;
}

export interface QualityInput {
  readonly counts: InputCounts;
  readonly matched: number;
  readonly previous: {
    readonly runId: string;
    readonly inputCounts: InputCounts | null;
    readonly matched: number | null;
  } | null;
}

export interface QualityAssessment {
  /** Publication is refused while any of these stand (unless accepted). */
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
}

/** A drop larger than this fraction versus the previous run blocks publication. */
export const COLLAPSE_FRACTION = 0.5;
/** A drop larger than this fraction is reported but allowed. */
export const NOTABLE_FRACTION = 0.2;

export function assessInputQuality(input: QualityInput): QualityAssessment {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const { counts, previous } = input;

  const required: ReadonlyArray<readonly [keyof InputCounts, string]> = [
    ["acmeProjects", "Project Register"],
    ["acmeSites", "Site Directory"],
    ["acmeKeyDates", "Key Dates"],
    ["pulleyProjects", "Pulley projects"],
  ];
  for (const [key, label] of required) {
    if (counts[key] === 0) blockers.push(`${label} has zero rows`);
  }
  if (!previous) return { blockers, warnings };

  const compare = (label: string, before: number | null, now: number, unit: string): void => {
    const verdict = compareCounts(before, now);
    if (verdict === "ok") return;
    const message = `${label} fell from ${before} to ${now}${unit ? ` ${unit}` : ""} since ${previous.runId}`;
    if (verdict === "collapse") blockers.push(message);
    else warnings.push(message);
  };
  for (const [key, label] of required) {
    compare(label, previous.inputCounts?.[key] ?? null, counts[key], "rows");
  }
  compare("matched rows", previous.matched, input.matched, "");

  return { blockers, warnings };
}

function compareCounts(before: number | null, now: number): "ok" | "notable" | "collapse" {
  if (before === null || before === 0) return "ok";
  const drop = (before - now) / before;
  if (drop > COLLAPSE_FRACTION) return "collapse";
  if (drop > NOTABLE_FRACTION) return "notable";
  return "ok";
}
