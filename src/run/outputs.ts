import { mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { MatchDecision } from "../domain/match/types.ts";
import { IoError } from "../errors.ts";
import type { PreviousDecision } from "../output/diff.ts";

/**
 * Output directory handling.
 *
 * Files are written to `data/out/<runId>.partial/` and the directory is
 * renamed to `data/out/<runId>/` only when every file is in place, so a
 * failed run never leaves a half-written output. `data/out/latest.json`
 * (and a `latest` symlink where the platform allows it) move only after
 * that rename.
 */

export const OUT_DIRNAME = "out";
export const LATEST_POINTER = "latest.json";
export const RUN_RECORD = "run.json";

export interface OutputFiles {
  readonly [filename: string]: string;
}

export async function writeOutputs(
  dataDir: string,
  runId: string,
  files: OutputFiles,
): Promise<string> {
  const outRoot = join(dataDir, OUT_DIRNAME);
  const partial = join(outRoot, `${runId}.partial`);
  const final = join(outRoot, runId);
  try {
    await rm(partial, { recursive: true, force: true });
    await mkdir(partial, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(partial, name), content);
    }
    await rm(final, { recursive: true, force: true });
    await rename(partial, final);
  } catch (error) {
    await rm(partial, { recursive: true, force: true }).catch(() => undefined);
    throw new IoError(`Could not write outputs under ${outRoot}`, { cause: error });
  }
  return final;
}

export async function updateLatest(dataDir: string, runId: string): Promise<void> {
  const outRoot = join(dataDir, OUT_DIRNAME);
  const pointer = join(outRoot, LATEST_POINTER);
  const tmp = `${pointer}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify({ runId }, null, 2)}\n`);
    await rename(tmp, pointer);
  } catch (error) {
    throw new IoError(`Could not update ${pointer}`, { cause: error });
  }
  // Convenience symlink; not all filesystems allow it, so failure is not fatal.
  const link = join(outRoot, "latest");
  const tmpLink = `${link}.tmp`;
  try {
    await rm(tmpLink, { force: true });
    await symlink(runId, tmpLink, "dir");
    await rename(tmpLink, link);
  } catch {
    await rm(tmpLink, { force: true }).catch(() => undefined);
  }
}

// ---------- Run record ----------

const latestPointerSchema = z.object({ runId: z.string().min(1) });

const previousDecisionSchema = z.looseObject({
  acmeId: z.string().min(1),
  status: z.enum(["matched", "needs_review", "no_match"]),
  pulleyId: z.string().nullable(),
});

const runRecordSchema = z.looseObject({
  version: z.literal(1),
  runId: z.string().min(1),
  decisions: z.array(previousDecisionSchema),
});

export interface RunRecordInput {
  readonly runId: string;
  readonly createdAt: string;
  readonly source: "live" | "archive";
  readonly archiveDirectory: string;
  readonly counts: Readonly<Record<string, number>>;
  readonly reasons: Readonly<Record<string, number>>;
  readonly decisions: readonly MatchDecision[];
  readonly warnings: readonly string[];
}

export function renderRunRecord(input: RunRecordInput): string {
  return `${JSON.stringify({ version: 1, ...input }, null, 2)}\n`;
}

export interface PreviousRun {
  readonly runId: string;
  readonly decisions: readonly PreviousDecision[];
}

/** The last successful run, via `latest.json`; null when there is none or it is unreadable. */
export async function loadPreviousRun(dataDir: string): Promise<PreviousRun | null> {
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
  try {
    const record = runRecordSchema.safeParse(
      JSON.parse(await readFile(join(outRoot, runId, RUN_RECORD), "utf8")),
    );
    if (!record.success) return null;
    return {
      runId: record.data.runId,
      decisions: record.data.decisions.map((d) => ({
        acmeId: d.acmeId,
        status: d.status,
        pulleyId: d.pulleyId,
      })),
    };
  } catch {
    return null;
  }
}
