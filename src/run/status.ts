import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { LATEST_POINTER, OUT_DIRNAME, RUN_RECORD } from "./outputs.ts";

/**
 * Freshness of the last published result. Used by `cli status`, which a
 * scheduler or a person can run to tell "the tool is failing" from "the
 * result is simply old".
 */

const latestPointerSchema = z.object({ runId: z.string().min(1) });
const recordSchema = z.looseObject({
  runId: z.string().min(1),
  publishedAt: z.iso.datetime().optional(),
  createdAt: z.iso.datetime().optional(),
  source: z.string().optional(),
  counts: z
    .object({ matched: z.number(), needs_review: z.number(), no_match: z.number() })
    .optional(),
});

export interface PublishedStatus {
  readonly runId: string;
  readonly publishedAt: string;
  readonly ageHours: number;
  readonly source: string;
  readonly counts: { matched: number; needs_review: number; no_match: number } | null;
  readonly outputDirectory: string;
}

/** Null when nothing has ever been published or the pointer is unreadable. */
export async function readPublishedStatus(
  dataDir: string,
  now: Date = new Date(),
): Promise<PublishedStatus | null> {
  const outRoot = join(dataDir, OUT_DIRNAME);
  let runId: string;
  try {
    const pointer = latestPointerSchema.safeParse(
      JSON.parse(await readFile(join(outRoot, LATEST_POINTER), "utf8")),
    );
    if (!pointer.success) return null;
    runId = pointer.data.runId;
  } catch {
    return null;
  }
  const outputDirectory = join(outRoot, runId);
  let record: z.output<typeof recordSchema>;
  try {
    const parsed = recordSchema.safeParse(
      JSON.parse(await readFile(join(outputDirectory, RUN_RECORD), "utf8")),
    );
    if (!parsed.success) return null;
    record = parsed.data;
  } catch {
    return null;
  }
  const publishedAt = record.publishedAt ?? record.createdAt;
  if (!publishedAt) return null;
  const ageHours = Math.max(0, (now.getTime() - Date.parse(publishedAt)) / 3_600_000);
  return {
    runId,
    publishedAt,
    ageHours,
    source: record.source ?? "unknown",
    counts: record.counts ?? null,
    outputDirectory,
  };
}

export function renderStatus(status: PublishedStatus | null, maxAgeHours: number | null): string {
  if (!status) return "No published result yet. Run `pnpm sync`.";
  const age =
    status.ageHours < 1
      ? `${Math.round(status.ageHours * 60)} min`
      : `${status.ageHours.toFixed(1)} h`;
  const lines = [
    `Last published run: ${status.runId} (${status.source})`,
    `Published: ${status.publishedAt} (${age} ago)`,
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
        ? `STALE: older than the ${maxAgeHours} h limit`
        : `Fresh: within the ${maxAgeHours} h limit`,
    );
  }
  return `${lines.join("\n")}\n`;
}
