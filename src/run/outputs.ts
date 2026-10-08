import { access, mkdir, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { MatchDecision } from "../domain/match/types.ts";
import { IoError } from "../errors.ts";
import type { PreviousDecision } from "../output/diff.ts";
import { RUN_ID_PATTERN } from "./archive.ts";

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
  if (await exists(final)) {
    throw new IoError(
      `Output directory ${final} already exists; refusing to overwrite a previous run`,
    );
  }
  try {
    await rm(partial, { recursive: true, force: true });
    await mkdir(partial, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(partial, name), content);
    }
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

// ---------- Retention ----------

const RUN_DIR = RUN_ID_PATTERN;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Keep the newest `keep` run directories under data/raw and data/out and
 * remove the rest. The run `latest.json` points at is never removed.
 * Returns the removed directory names.
 */
export async function pruneRuns(dataDir: string, keep: number): Promise<string[]> {
  const removed: string[] = [];
  const latest = await currentLatestRunId(dataDir);
  const outRoot = join(dataDir, OUT_DIRNAME);
  const rawRoot = join(dataDir, "raw");

  const outputs = await runDirectories(outRoot);
  const keptOutputs = new Set(outputs.slice(Math.max(0, outputs.length - keep)));
  if (latest) keptOutputs.add(latest);
  // Every retained output must keep the archive it was computed from, so a
  // replayed result (new output id, old archive) stays reproducible.
  const protectedArchives = new Set<string>();
  for (const runId of keptOutputs) {
    const archive = await referencedArchive(join(outRoot, runId));
    if (archive) protectedArchives.add(archive);
  }

  const archives = await runDirectories(rawRoot);
  const excessArchives = archives
    .slice(0, Math.max(0, archives.length - keep))
    .filter((name) => name !== latest && !protectedArchives.has(name));
  const excessOutputs = outputs.filter((name) => !keptOutputs.has(name));

  const plan: ReadonlyArray<readonly [string, readonly string[]]> = [
    [rawRoot, excessArchives],
    [outRoot, excessOutputs],
  ];
  for (const [root, names] of plan) {
    for (const name of names) {
      try {
        await rm(join(root, name), { recursive: true, force: true });
        removed.push(join(root, name));
      } catch (error) {
        throw new IoError(`Could not remove old run ${join(root, name)}`, { cause: error });
      }
    }
  }
  return removed;
}

async function runDirectories(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && RUN_DIR.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** The archive run id an output's run.json points at, or null. */
async function referencedArchive(outputDirectory: string): Promise<string | null> {
  try {
    const record = z
      .looseObject({ inputs: z.looseObject({ archiveDirectory: z.string() }).optional() })
      .safeParse(JSON.parse(await readFile(join(outputDirectory, RUN_RECORD), "utf8")));
    const directory = record.success ? record.data.inputs?.archiveDirectory : undefined;
    if (!directory) return null;
    const name = directory.split(/[\\/]/).filter(Boolean).pop() ?? null;
    return name && RUN_DIR.test(name) ? name : null;
  } catch {
    return null;
  }
}

async function currentLatestRunId(dataDir: string): Promise<string | null> {
  try {
    const pointer = latestPointerSchema.safeParse(
      JSON.parse(await readFile(join(dataDir, OUT_DIRNAME, LATEST_POINTER), "utf8")),
    );
    return pointer.success ? pointer.data.runId : null;
  } catch {
    return null;
  }
}

// ---------- Run record ----------

const latestPointerSchema = z.object({ runId: z.string().min(1) });

const previousDecisionSchema = z.looseObject({
  acmeId: z.string().min(1),
  status: z.enum(["matched", "needs_review", "no_match"]),
  pulleyId: z.string().nullable(),
});

const inputCountsSchema = z.object({
  acmeProjects: z.number().int(),
  acmeSites: z.number().int(),
  acmeKeyDates: z.number().int(),
  pulleyProjects: z.number().int(),
});

const runRecordSchema = z.looseObject({
  version: z.union([z.literal(1), z.literal(2)]),
  runId: z.string().min(1),
  decisions: z.array(previousDecisionSchema),
  counts: z.object({ matched: z.number().int() }).loose().optional(),
  inputs: z.object({ counts: inputCountsSchema }).loose().optional(),
});

/**
 * Everything needed to attribute and reproduce a run: which rules, which
 * tool version, which input bytes, which configuration, which human
 * decisions, and what the matcher decided before those decisions applied.
 */
export interface RunRecordInput {
  readonly runId: string;
  readonly createdAt: string;
  readonly publishedAt: string;
  /** When the upstream bytes were fetched; for a replay, the original archive's time. */
  readonly sourceAcquiredAt: string;
  readonly source: "live" | "archive";
  readonly toolVersion: string;
  readonly rulesVersion: string;
  readonly inputs: {
    readonly archiveDirectory: string;
    readonly files: readonly unknown[];
    readonly counts: {
      acmeProjects: number;
      acmeSites: number;
      acmeKeyDates: number;
      pulleyProjects: number;
    };
  };
  /** Non-secret configuration that influences decisions. */
  readonly config: Readonly<Record<string, string | number | boolean>>;
  readonly quality: { blockers: readonly string[]; warnings: readonly string[]; accepted: boolean };
  readonly overrides: {
    readonly path: string;
    readonly sha256: string | null;
    readonly applied: number;
    readonly problems: readonly string[];
    /** The matcher's decision for every row a human decision replaced. */
    readonly overridden: readonly unknown[];
  };
  readonly counts: Readonly<Record<string, number>>;
  readonly reasons: Readonly<Record<string, number>>;
  readonly decisions: readonly MatchDecision[];
  readonly warnings: readonly string[];
}

export function renderRunRecord(input: RunRecordInput): string {
  return `${JSON.stringify({ version: 2, ...input }, null, 2)}\n`;
}

export interface PreviousRun {
  readonly runId: string;
  readonly decisions: readonly PreviousDecision[];
  readonly inputCounts: {
    acmeProjects: number;
    acmeSites: number;
    acmeKeyDates: number;
    pulleyProjects: number;
  } | null;
  readonly matched: number | null;
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
      inputCounts: record.data.inputs?.counts ?? null,
      matched: record.data.counts?.matched ?? null,
    };
  } catch {
    return null;
  }
}
