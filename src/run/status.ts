import { join } from "node:path";
import { z } from "zod";
import { SchemaError } from "../errors.ts";
import { latestRunId, OUT_DIRNAME, readRunRecord } from "./outputs.ts";

/**
 * Freshness of the last published result. Used by `cli status`, which a
 * scheduler or a person can run to tell "the tool is failing" from "the
 * result is simply old".
 */

const recordSchema = z.looseObject({
  runId: z.string().min(1),
  publishedAt: z.iso.datetime().optional(),
  createdAt: z.iso.datetime().optional(),
  sourceAcquiredAt: z.iso.datetime().optional(),
  source: z.string().optional(),
  counts: z
    .object({ matched: z.number(), needs_review: z.number(), no_match: z.number() })
    .optional(),
});

export interface PublishedStatus {
  readonly runId: string;
  readonly publishedAt: string;
  readonly ageHours: number;
  /** When the upstream data was fetched; null for records written before this was recorded. */
  readonly sourceAcquiredAt: string | null;
  readonly sourceAgeHours: number | null;
  readonly source: string;
  readonly counts: { matched: number; needs_review: number; no_match: number } | null;
  readonly outputDirectory: string;
}

/** Null when nothing has ever been published or the pointer is unreadable. */
export async function readPublishedStatus(
  dataDir: string,
  now: Date = new Date(),
): Promise<PublishedStatus | null> {
  const runId = await latestRunId(dataDir);
  if (runId === null) return null;
  const outputDirectory = join(dataDir, OUT_DIRNAME, runId);
  const parsed = recordSchema.safeParse(await readRunRecord(dataDir, runId));
  if (!parsed.success) throw new SchemaError("Published run has invalid freshness metadata");
  const record = parsed.data;
  const publishedAt = record.publishedAt ?? record.createdAt;
  if (!publishedAt) throw new SchemaError("Publication time is missing");
  for (const timestamp of [publishedAt, record.sourceAcquiredAt]) {
    if (timestamp && Date.parse(timestamp) > now.getTime() + 300_000)
      throw new SchemaError(
        "Publication or source timestamp is in the future; check clock and metadata",
      );
  }
  const hoursSince = (iso: string): number =>
    Math.max(0, (now.getTime() - Date.parse(iso)) / 3_600_000);
  const ageHours = hoursSince(publishedAt);
  const sourceAcquiredAt = record.sourceAcquiredAt ?? null;
  return {
    runId,
    publishedAt,
    ageHours,
    sourceAcquiredAt,
    sourceAgeHours: sourceAcquiredAt ? hoursSince(sourceAcquiredAt) : null,
    source: record.source ?? "unknown",
    counts: record.counts ?? null,
    outputDirectory,
  };
}

function formatAge(hours: number): string {
  return hours < 1 ? `${Math.round(hours * 60)} min` : `${hours.toFixed(1)} h`;
}

export function renderStatus(
  status: PublishedStatus | null,
  maxAgeHours: number | null,
  maxSourceAgeHours: number | null = null,
): string {
  if (!status) return "No published result yet. Run `pnpm sync`.";
  const lines = [
    `Last published run: ${status.runId} (${status.source})`,
    `Published: ${status.publishedAt} (${formatAge(status.ageHours)} ago)`,
    status.sourceAcquiredAt && status.sourceAgeHours !== null
      ? `Source data acquired: ${status.sourceAcquiredAt} (${formatAge(status.sourceAgeHours)} ago)`
      : "Source data acquired: not recorded for this run",
  ];
  if (status.counts) {
    lines.push(
      `Results: matched ${status.counts.matched}, needs_review ${status.counts.needs_review}, no_match ${status.counts.no_match}`,
    );
  }
  lines.push(`Files: ${status.outputDirectory}`);
  if (maxAgeHours !== null) {
    lines.push(
      status.ageHours > maxAgeHours
        ? `STALE: published more than ${maxAgeHours} h ago`
        : `Fresh: published within ${maxAgeHours} h`,
    );
  }
  if (maxSourceAgeHours !== null) {
    lines.push(
      status.sourceAgeHours === null
        ? "STALE: source age unknown for this run"
        : status.sourceAgeHours > maxSourceAgeHours
          ? `STALE: source data fetched more than ${maxSourceAgeHours} h ago`
          : `Fresh: source data fetched within ${maxSourceAgeHours} h`,
    );
  }
  return `${lines.join("\n")}\n`;
}
