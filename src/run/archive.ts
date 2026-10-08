import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { IoError, SchemaError } from "../errors.ts";

/**
 * Raw input archive: the exact bytes fetched during a run, plus a manifest.
 *
 * Every run writes to `data/raw/<runId>/`. `--dry-run` replays the newest
 * archive so matching logic can be iterated offline and reproduced exactly.
 */

export const ARCHIVE_FILE_KINDS = [
  "project-register",
  "site-directory",
  "key-dates",
  "pulley-page",
] as const;
export type ArchiveFileKind = (typeof ARCHIVE_FILE_KINDS)[number];

const manifestFileSchema = z.object({
  name: z.string().min(1),
  originalName: z.string().optional(),
  kind: z.enum(ARCHIVE_FILE_KINDS),
  bytes: z.number().int().nonnegative(),
  /** Page order for pulley-page files; absent otherwise. */
  page: z.number().int().positive().optional(),
  /** Hex SHA-256 of the file content; absent only in archives written before provenance was recorded. */
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});

export const manifestSchema = z.object({
  version: z.literal(1),
  runId: z.string().min(1),
  createdAt: z.iso.datetime(),
  files: z.array(manifestFileSchema),
});

export type ArchiveManifest = z.output<typeof manifestSchema>;
export type ArchiveManifestFile = z.output<typeof manifestFileSchema>;

export const MANIFEST_FILENAME = "manifest.json";

/** Filesystem-safe, sortable run id derived from a UTC timestamp. */
export function createRunId(now: Date = new Date()): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

/** Matches run directory names, current (with milliseconds) and legacy (without). */
export const RUN_ID_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d{3})?Z$/;

export class RawArchive {
  readonly directory: string;
  readonly runId: string;
  readonly #files: ArchiveManifestFile[] = [];

  constructor(dataDir: string, runId: string) {
    if (!RUN_ID_PATTERN.test(runId)) throw new SchemaError(`Invalid archive run id: ${runId}`);
    this.runId = runId;
    this.directory = join(dataDir, "raw", runId);
  }

  /** Creates the run directory exclusively: an existing one is a run-id collision, never reused. */
  async init(): Promise<void> {
    try {
      await mkdir(join(this.directory, ".."), { recursive: true });
      await mkdir(this.directory);
    } catch (error) {
      const collision =
        typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
      throw new IoError(
        collision
          ? `Archive directory ${this.directory} already exists; refusing to overwrite a previous run`
          : `Could not create archive directory ${this.directory}`,
        { cause: error },
      );
    }
  }

  async write(
    name: string,
    kind: ArchiveFileKind,
    content: Uint8Array | string,
    page?: number,
    originalName?: string,
  ): Promise<string> {
    if (!safeArchiveName(name))
      throw new SchemaError(`Unsafe or reserved archive filename: ${name}`);
    const safeName = name;
    const path = join(this.directory, safeName);
    try {
      await writeFile(path, content, { flag: "wx" });
    } catch (error) {
      throw new IoError(`Could not write ${path}`, { cause: error });
    }
    const bytes = typeof content === "string" ? Buffer.byteLength(content) : content.byteLength;
    const sha256 = sha256Hex(content);
    this.#files.push(
      page === undefined
        ? {
            name: safeName,
            kind,
            bytes,
            sha256,
            ...(originalName === undefined ? {} : { originalName }),
          }
        : {
            name: safeName,
            kind,
            bytes,
            page,
            sha256,
            ...(originalName === undefined ? {} : { originalName }),
          },
    );
    return path;
  }

  async finalize(createdAt: Date = new Date()): Promise<ArchiveManifest> {
    const manifest: ArchiveManifest = {
      version: 1,
      runId: this.runId,
      createdAt: createdAt.toISOString(),
      files: [...this.#files].sort((a, b) => a.name.localeCompare(b.name)),
    };
    const path = join(this.directory, MANIFEST_FILENAME);
    try {
      await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    } catch (error) {
      throw new IoError(`Could not write ${path}`, { cause: error });
    }
    return manifest;
  }
}

export interface LoadedArchive {
  readonly directory: string;
  readonly manifest: ArchiveManifest;
  readonly read: (file: ArchiveManifestFile) => Promise<Uint8Array>;
}

export function sha256Hex(content: Uint8Array | string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Find the newest run directory under `data/raw` that has a valid manifest. */
export async function loadLatestArchive(dataDir: string): Promise<LoadedArchive | null> {
  const rawDir = join(dataDir, "raw");
  let entries: string[];
  try {
    entries = (await readdir(rawDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && RUN_ID_PATTERN.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch (error) {
    if (isMissing(error)) return null;
    throw new IoError(`Could not list archive directory ${rawDir}`, { cause: error });
  }
  for (const runId of entries) {
    const archive = await loadArchive(dataDir, runId);
    if (archive) return archive;
  }
  return null;
}

/**
 * Load one archived run by id. Null when that run has no manifest. Files are
 * verified against the manifest's content hash when read, so a tampered or
 * damaged archive is reported rather than silently replayed.
 */
export async function loadArchive(dataDir: string, runId: string): Promise<LoadedArchive | null> {
  if (!RUN_ID_PATTERN.test(runId)) throw new SchemaError(`Invalid archive run id: ${runId}`);
  const directory = join(dataDir, "raw", runId);
  let text: string;
  try {
    text = await readFile(join(directory, MANIFEST_FILENAME), "utf8");
  } catch (error) {
    if (isMissing(error)) return null;
    throw new IoError(`Could not read archive manifest in ${directory}`, { cause: error });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new SchemaError(`Archive ${directory} has malformed manifest JSON`, { cause: error });
  }
  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) {
    throw new SchemaError(`Archive ${directory} has an invalid manifest`, {
      details: { issues: parsed.error.issues.map((issue) => issue.message) },
    });
  }
  const names = parsed.data.files.map((file) => file.name);
  if (
    parsed.data.runId !== runId ||
    names.some((name) => !safeArchiveName(name)) ||
    new Set(names).size !== names.length
  ) {
    throw new SchemaError(
      `Archive ${directory} has mismatched identity, unsafe paths, or duplicate filenames`,
    );
  }
  return {
    directory,
    manifest: parsed.data,
    read: async (file) => {
      if (!safeArchiveName(file.name))
        throw new SchemaError(`Unsafe archive filename: ${file.name}`);
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await readFile(join(directory, file.name)));
      } catch (error) {
        throw new IoError(`Could not read archived file ${file.name}`, { cause: error });
      }
      if (file.sha256 !== undefined && sha256Hex(bytes) !== file.sha256) {
        throw new SchemaError(
          `Archived file ${file.name} in ${runId} does not match its recorded hash; the archive was altered`,
        );
      }
      if (bytes.byteLength !== file.bytes)
        throw new SchemaError(`Archived file ${file.name} has an unexpected byte length`);
      return bytes;
    },
  };
}

function safeArchiveName(name: string): boolean {
  return (
    name.length > 0 &&
    name !== "." &&
    name !== ".." &&
    !/[\\/\0]/.test(name) &&
    name.toLowerCase() !== MANIFEST_FILENAME
  );
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
