import {
  access,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { MatchDecision } from "../domain/match/types.ts";
import { IoError, SchemaError } from "../errors.ts";
import type { PreviousDecision } from "../output/diff.ts";
import { reviewFingerprint } from "../output/review.ts";
import { RUN_ID_PATTERN } from "./archive.ts";
import {
  OUTPUT_MANIFEST,
  outputManifest,
  readRegularFile,
  verifyOutputDirectory,
} from "./integrity.ts";

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
  if (!RUN_ID_PATTERN.test(runId)) throw new SchemaError("Invalid output run id");
  const manifest = outputManifest(runId, files);
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
    await mkdir(partial, { recursive: true, mode: 0o700 });
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(partial, name), content, { mode: 0o600, flush: true });
    }
    await writeFile(join(partial, OUTPUT_MANIFEST), manifest, { mode: 0o600, flush: true });
    await rename(partial, final);
  } catch (error) {
    await rm(partial, { recursive: true, force: true }).catch(() => undefined);
    throw new IoError(`Could not write outputs under ${outRoot}`, { cause: error });
  }
  return final;
}

export async function updateLatest(dataDir: string, runId: string): Promise<string | null> {
  if (!RUN_ID_PATTERN.test(runId)) throw new SchemaError("Invalid output run id");
  const outRoot = join(dataDir, OUT_DIRNAME);
  const pointer = join(outRoot, LATEST_POINTER);
  const tmp = `${pointer}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify({ runId }, null, 2)}\n`, { mode: 0o600, flush: true });
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
    return null;
  } catch {
    await rm(tmpLink, { force: true }).catch(() => undefined);
    return "Published JSON pointer, but could not refresh convenience symlink; use the run directory from latest.json";
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
  const latest = await latestRunId(dataDir);
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
  } catch (error) {
    if (isMissing(error)) return [];
    throw new IoError("Could not inspect retention directories", { cause: error });
  }
}

/** The archive run id an output's run.json points at, or null. */
async function referencedArchive(outputDirectory: string): Promise<string | null> {
  try {
    const record = z
      .looseObject({ inputs: z.looseObject({ archiveDirectory: z.string() }).optional() })
      .safeParse(JSON.parse(await readFile(join(outputDirectory, RUN_RECORD), "utf8")));
    if (!record.success) throw new SchemaError("Invalid retained run record; refusing retention");
    const directory = record.data.inputs?.archiveDirectory;
    if (!directory) return outputDirectory.split(/[\\/]/).pop() ?? null;
    const name = directory.split(/[\\/]/).filter(Boolean).pop() ?? null;
    if (!name || !RUN_DIR.test(name)) throw new SchemaError("Invalid retained archive reference");
    return name;
  } catch (error) {
    throw new IoError("Could not verify retained archive references; refusing retention", {
      cause: error,
    });
  }
}

// ---------- Run record ----------

const latestPointerSchema = z.object({ runId: z.string().regex(RUN_ID_PATTERN) });

const previousDecisionSchema = z.looseObject({
  acmeId: z.string().min(1),
  status: z.enum(["matched", "needs_review", "no_match"]),
  pulleyId: z.string().nullable(),
  reviewFingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});

const inputCountsSchema = z.object({
  acmeProjects: z.number().int().nonnegative(),
  acmeSites: z.number().int().nonnegative(),
  acmeKeyDates: z.number().int().nonnegative(),
  pulleyProjects: z.number().int().nonnegative(),
});

const runRecordSchema = z.looseObject({
  version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  runId: z.string().regex(RUN_ID_PATTERN),
  decisions: z.array(previousDecisionSchema),
  counts: z.object({ matched: z.number().int().nonnegative() }).loose().optional(),
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
  readonly implementationSha256: string;
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
  const decisions = input.decisions.map((d) =>
    d.status === "needs_review" ? { ...d, reviewFingerprint: reviewFingerprint(d) } : d,
  );
  return `${JSON.stringify({ version: 3, ...input, decisions }, null, 2)}\n`;
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

/** Only an empty output history is a first run. Damaged state must be restored explicitly. */
export async function latestRunId(dataDir: string): Promise<string | null> {
  const root = join(dataDir, OUT_DIRNAME);
  let raw: string;
  try {
    const pointer = join(root, LATEST_POINTER);
    const stat = await lstat(pointer);
    if (!stat.isFile() || stat.size > 4096)
      throw new SchemaError("Invalid publication pointer file");
    raw = await readFile(pointer, "utf8");
  } catch (error) {
    if (!isMissing(error))
      throw new IoError("Could not read publication pointer", { cause: error });
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch (listError) {
      if (isMissing(listError)) return null;
      throw new IoError("Could not inspect output history", { cause: listError });
    }
    if (entries.some((name) => RUN_ID_PATTERN.test(name) || name === "latest"))
      throw new SchemaError(
        "Publication pointer missing despite existing output history; restore a verified snapshot, or follow docs/DEPLOYMENT.md first-run crash recovery if nothing was ever published",
      );
    return null;
  }
  try {
    const pointer = latestPointerSchema.safeParse(JSON.parse(raw));
    if (pointer.success) return pointer.data.runId;
  } catch {
    /* Invalid JSON is corrupted state, not first run. */
  }
  throw new SchemaError("Invalid publication pointer; restore a verified snapshot before syncing");
}

export async function readRunRecord(dataDir: string, runId: string) {
  if (!RUN_ID_PATTERN.test(runId)) throw new SchemaError("Invalid output run id");
  let raw: string;
  try {
    raw = (await readRegularFile(join(dataDir, OUT_DIRNAME, runId, RUN_RECORD))).toString("utf8");
  } catch (error) {
    throw new IoError("Could not read published run record; restore history before syncing", {
      cause: error,
    });
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new SchemaError("Malformed published run record", { cause: error });
  }
  const result = runRecordSchema.safeParse(json);
  if (!result.success || result.data.runId !== runId)
    throw new SchemaError("Invalid published run record or mismatched run identity");
  const record = result.data;
  if (record.version >= 3) await verifyOutputDirectory(join(dataDir, OUT_DIRNAME, runId), runId);
  const matched = record.decisions.filter((d) => d.status === "matched").length;
  if (
    new Set(record.decisions.map((d) => d.acmeId)).size !== record.decisions.length ||
    record.decisions.some(
      (d) => (d.status === "matched") !== (d.pulleyId !== null && d.pulleyId !== ""),
    ) ||
    (record.counts && record.counts.matched !== matched) ||
    (record.version >= 2 && (!record.counts || !record.inputs))
  )
    throw new SchemaError("Published run record has missing or inconsistent comparison fields");
  return record;
}

export async function loadPreviousRun(dataDir: string): Promise<PreviousRun | null> {
  const runId = await latestRunId(dataDir);
  if (runId === null) return null;
  const record = await readRunRecord(dataDir, runId);
  return {
    runId,
    decisions: record.decisions.map((d) => ({
      acmeId: d.acmeId,
      status: d.status,
      pulleyId: d.pulleyId,
      ...(d.reviewFingerprint ? { reviewFingerprint: d.reviewFingerprint } : {}),
    })),
    inputCounts: record.inputs?.counts ?? null,
    matched:
      record.counts?.matched ?? record.decisions.filter((d) => d.status === "matched").length,
  };
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
