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
  kind: z.enum(ARCHIVE_FILE_KINDS),
  bytes: z.number().int().nonnegative(),
  /** Page order for pulley-page files; absent otherwise. */
  page: z.number().int().positive().optional(),
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
  ): Promise<string> {
    const safeName = name.replace(/[\\/]/g, "_");
    const path = join(this.directory, safeName);
    try {
      await writeFile(path, content);
    } catch (error) {
      throw new IoError(`Could not write ${path}`, { cause: error });
    }
    const bytes = typeof content === "string" ? Buffer.byteLength(content) : content.byteLength;
    this.#files.push(
      page === undefined ? { name: safeName, kind, bytes } : { name: safeName, kind, bytes, page },
    );
    return path;
  }

  async finalize(createdAt: Date = new Date()): Promise<ArchiveManifest> {
    const manifest: ArchiveManifest = {
      version: 1,
      runId: this.runId,
      createdAt: createdAt.toISOString(),
      files: [...this.#files],
    };
    const path = join(this.directory, MANIFEST_FILENAME);
    try {
      await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
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

/** Find the newest run directory under `data/raw` that has a valid manifest. */
export async function loadLatestArchive(dataDir: string): Promise<LoadedArchive | null> {
  const rawDir = join(dataDir, "raw");
  let entries: string[];
  try {
    entries = (await readdir(rawDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch {
    return null;
  }
  for (const runId of entries) {
    const directory = join(rawDir, runId);
    let text: string;
    try {
      text = await readFile(join(directory, MANIFEST_FILENAME), "utf8");
    } catch {
      continue;
    }
    const parsed = manifestSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      throw new SchemaError(`Archive ${directory} has an invalid manifest`, {
        details: { issues: parsed.error.issues.map((issue) => issue.message) },
      });
    }
    return {
      directory,
      manifest: parsed.data,
      read: async (file) => {
        try {
          return new Uint8Array(await readFile(join(directory, file.name)));
        } catch (error) {
          throw new IoError(`Could not read archived file ${file.name}`, { cause: error });
        }
      },
    };
  }
  return null;
}
