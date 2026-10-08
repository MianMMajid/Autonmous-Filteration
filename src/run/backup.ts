import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { IoError, SchemaError } from "../errors.ts";
import { implementationSha256 } from "../version.ts";
import { loadArchive, RUN_ID_PATTERN, sha256Hex } from "./archive.ts";
import { readRegularFile, verifyOutputDirectory } from "./integrity.ts";
import { acquireLock } from "./lock.ts";
import { latestRunId, readRunRecord } from "./outputs.ts";

const schema = z.object({
  version: z.literal(1),
  runtime: z.enum(["src", "dist"]),
  runId: z.string().regex(RUN_ID_PATTERN),
  archiveId: z.string().regex(RUN_ID_PATTERN),
  files: z
    .array(
      z.object({
        path: z.string().min(1),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        bytes: z
          .number()
          .int()
          .nonnegative()
          .max(128 * 1024 * 1024),
      }),
    )
    .min(1)
    .max(4096),
});

/** A portable snapshot; destination belongs on separately backed-up, access-controlled storage. */
export async function backupState(dataDir: string, destination: string): Promise<string> {
  const lock = await acquireLock(dataDir);
  const stage = join(resolve(destination), `.partial-${randomUUID()}`);
  try {
    const runId = await latestRunId(dataDir);
    if (!runId) throw new SchemaError("No published state to back up");
    const record = await readRunRecord(dataDir, runId);
    await verifyOutputDirectory(join(dataDir, "out", runId), runId);
    if (record["implementationSha256"] !== (await implementationSha256()))
      throw new SchemaError(
        "Run was produced by a different implementation; back up using that exact source/dependency revision",
      );
    const archiveId = archiveFromRecord(record);
    const archive = await loadArchive(dataDir, archiveId);
    if (!archive || archive.manifest.files.some((file) => !file.sha256))
      throw new SchemaError("Backup requires a hashed input archive");
    for (const file of archive.manifest.files) await archive.read(file);
    const final = join(resolve(destination), runId);
    await mkdir(stage, { recursive: true, mode: 0o700 });
    const files: Array<{ path: string; sha256: string; bytes: number }> = [];
    const save = async (path: string, bytes: Buffer): Promise<void> => {
      await mkdir(dirname(join(stage, path)), { recursive: true, mode: 0o700 });
      await writeFile(join(stage, path), bytes, { flag: "wx", mode: 0o600, flush: true });
      files.push({ path, sha256: sha256Hex(bytes), bytes: bytes.length });
    };
    for (const folder of [`out/${runId}`, `raw/${archiveId}`]) {
      for (const name of await readdir(join(dataDir, folder)))
        await save(`data/${folder}/${name}`, await readRegularFile(join(dataDir, folder, name)));
    }
    await save("data/out/latest.json", Buffer.from(`${JSON.stringify({ runId })}\n`));
    const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
    const copySource = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await copySource(path);
        else if (entry.isFile() && /\.(ts|js)$/.test(entry.name))
          await save(
            `implementation/${relative(projectRoot, path).replaceAll("\\", "/")}`,
            await readRegularFile(path),
          );
      }
    };
    const runtimeRoot = fileURLToPath(new URL("../", import.meta.url));
    const runtime = basename(runtimeRoot.replace(/[\\/]$/, ""));
    await copySource(runtimeRoot);
    for (const path of ["package.json", "pnpm-lock.yaml", "vendor/xlsx-0.20.3.tgz"])
      await save(`implementation/${path}`, await readRegularFile(join(projectRoot, path)));
    await writeFile(
      join(stage, "backup.json"),
      `${JSON.stringify(schema.parse({ version: 1, runtime, runId, archiveId, files }), null, 2)}\n`,
      { flag: "wx", mode: 0o600, flush: true },
    );
    await verifyBackup(stage);
    // Reserve the destination exclusively. Never replace a previous snapshot.
    await mkdir(final, { mode: 0o700 });
    try {
      await rename(stage, final);
    } catch (error) {
      await rm(final, { recursive: true, force: true });
      throw error;
    }
    return final;
  } catch (error) {
    if (error instanceof SchemaError || error instanceof IoError) throw error;
    throw new IoError("Could not create immutable state backup", { cause: error });
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
    await lock.release().catch(() => {
      process.stderr.write(
        "Warning: backup lock cleanup failed; inspect the lock before retrying\n",
      );
    });
  }
}

export async function verifyBackup(directory: string) {
  const raw = await readRegularFile(join(directory, "backup.json"), 1024 * 1024);
  let json: unknown;
  try {
    json = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    throw new SchemaError("Malformed backup manifest", { cause: error });
  }
  const result = schema.safeParse(json);
  if (!result.success) throw new SchemaError("Invalid backup manifest");
  const manifest = result.data;
  const names = new Set<string>();
  let total = 0;
  for (const file of manifest.files) {
    if (!safePath(file.path) || names.has(file.path))
      throw new SchemaError("Unsafe or duplicate backup path");
    names.add(file.path);
    total += file.bytes;
    if (total > 512 * 1024 * 1024) throw new SchemaError("Backup exceeds 512 MiB limit");
    await verifyParentDirectories(directory, file.path);
    const bytes = await readRegularFile(join(directory, file.path));
    if (bytes.length !== file.bytes || sha256Hex(bytes) !== file.sha256)
      throw new SchemaError(`Backup integrity failed for ${file.path}`);
  }
  const state = join(directory, "data");
  if ((await latestRunId(state)) !== manifest.runId)
    throw new SchemaError("Backup pointer does not match manifest");
  const record = await readRunRecord(state, manifest.runId);
  if (
    record["implementationSha256"] !==
    (await implementationSha256(join(directory, "implementation", manifest.runtime)))
  )
    throw new SchemaError("Backup implementation does not match the published run fingerprint");
  await verifyOutputDirectory(join(state, "out", manifest.runId), manifest.runId);
  if (archiveFromRecord(record) !== manifest.archiveId)
    throw new SchemaError("Backup archive identity mismatch");
  const archive = await loadArchive(state, manifest.archiveId);
  if (!archive || archive.manifest.files.some((file) => !file.sha256))
    throw new SchemaError("Missing hashed backup archive");
  for (const file of archive.manifest.files) await archive.read(file);
  const required = [
    "data/out/latest.json",
    `data/out/${manifest.runId}/output-manifest.json`,
    `data/raw/${manifest.archiveId}/manifest.json`,
    "implementation/package.json",
    "implementation/pnpm-lock.yaml",
    "implementation/vendor/xlsx-0.20.3.tgz",
  ];
  for (const name of await readdir(join(state, "out", manifest.runId)))
    required.push(`data/out/${manifest.runId}/${name}`);
  for (const file of archive.manifest.files)
    required.push(`data/raw/${manifest.archiveId}/${file.name}`);
  if (required.some((name) => !names.has(name)))
    throw new SchemaError("Backup manifest omits required files");
  return manifest;
}

/** Restore into a NEW data directory. Never merge into or overwrite existing state. */
export async function restoreState(snapshot: string, destination: string): Promise<void> {
  const manifest = await verifyBackup(snapshot);
  const target = resolve(destination);
  const stage = `${target}.restore-${randomUUID()}`;
  try {
    await mkdir(stage, { recursive: true, mode: 0o700 });
    for (const file of manifest.files.filter((file) => file.path.startsWith("data/"))) {
      const path = join(stage, file.path.slice(5));
      const bytes = await readRegularFile(join(snapshot, file.path));
      if (sha256Hex(bytes) !== file.sha256) throw new SchemaError("Backup changed during restore");
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, bytes, { flag: "wx", mode: 0o600, flush: true });
    }
    await readRunRecord(stage, manifest.runId);
    await mkdir(target, { mode: 0o700 });
    try {
      await rename(stage, target);
    } catch (error) {
      await rm(target, { recursive: true, force: true });
      throw error;
    }
  } catch (error) {
    if (error instanceof SchemaError || error instanceof IoError) throw error;
    throw new IoError("Restore requires a new destination and valid snapshot", { cause: error });
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function verifyParentDirectories(directory: string, path: string): Promise<void> {
  let parent = directory;
  if (!(await lstat(parent)).isDirectory())
    throw new SchemaError("Backup root is not a regular directory");
  for (const part of path.split("/").slice(0, -1)) {
    parent = join(parent, part);
    if (!(await lstat(parent)).isDirectory())
      throw new SchemaError("Backup contains a linked directory");
  }
}

function safePath(path: string): boolean {
  return (
    /^(data|implementation)\/[a-zA-Z0-9_./-]+$/.test(path) &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}
function archiveFromRecord(record: Record<string, unknown>): string {
  const input = record["inputs"] as { archiveDirectory?: unknown } | undefined;
  const name =
    typeof input?.archiveDirectory === "string"
      ? input.archiveDirectory.split(/[\\/]/).pop()
      : undefined;
  if (!name || !RUN_ID_PATTERN.test(name))
    throw new SchemaError("Run does not identify a valid input archive");
  return name;
}
