import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { IoError, SchemaError } from "../errors.ts";
import { RUN_ID_PATTERN, sha256Hex } from "./archive.ts";

export const OUTPUT_MANIFEST = "output-manifest.json";
export const REQUIRED_OUTPUTS = [
  "mapping.csv",
  "review.csv",
  "decisions.csv",
  "pulley-unmatched.csv",
  "summary.txt",
  "run.json",
  "overrides.snapshot.csv",
] as const;
const fileSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9.-]*$/),
  bytes: z
    .number()
    .int()
    .nonnegative()
    .max(128 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const schema = z.object({
  version: z.literal(1),
  runId: z.string().regex(RUN_ID_PATTERN),
  files: z.array(fileSchema).min(1).max(32),
});

export function outputManifest(runId: string, files: Readonly<Record<string, string>>): string {
  const record = schema.parse({
    version: 1,
    runId,
    files: Object.entries(files).map(([name, bytes]) => ({
      name,
      bytes: Buffer.byteLength(bytes),
      sha256: sha256Hex(bytes),
    })),
  });
  if (record.files.some((file) => file.name === OUTPUT_MANIFEST))
    throw new SchemaError("Reserved output filename");
  return `${JSON.stringify(record, null, 2)}\n`;
}

/** Reject links and non-files before reading; hashes detect incomplete or changed bytes. */
export async function readRegularFile(path: string, maxBytes = 128 * 1024 * 1024): Promise<Buffer> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size > maxBytes)
      throw new SchemaError("Expected a regular file within the supported byte limit");
    const bytes = await readFile(path);
    if (bytes.byteLength > maxBytes) throw new SchemaError("File exceeds supported byte limit");
    return bytes;
  } catch (error) {
    if (error instanceof SchemaError) throw error;
    throw new IoError(`Could not read required file ${path}`, { cause: error });
  }
}

export async function verifyOutputDirectory(directory: string, runId: string): Promise<void> {
  try {
    if (!(await lstat(directory)).isDirectory())
      throw new SchemaError("Output directory must not be a symlink");
    const raw = await readRegularFile(join(directory, OUTPUT_MANIFEST), 65536);
    const manifest = schema.safeParse(JSON.parse(raw.toString("utf8")));
    if (!manifest.success || manifest.data.runId !== runId)
      throw new SchemaError("Invalid output manifest or mismatched run identity");
    const names = manifest.data.files.map((file) => file.name);
    if (
      new Set(names).size !== names.length ||
      names.includes(OUTPUT_MANIFEST) ||
      REQUIRED_OUTPUTS.some((name) => !names.includes(name))
    )
      throw new SchemaError("Output manifest is incomplete or has duplicate/reserved filenames");
    for (const file of manifest.data.files) {
      const bytes = await readRegularFile(join(directory, file.name));
      if (bytes.byteLength !== file.bytes || sha256Hex(bytes) !== file.sha256)
        throw new SchemaError(`Published output ${file.name} failed integrity verification`);
    }
  } catch (error) {
    if (error instanceof SchemaError || error instanceof IoError) throw error;
    throw new SchemaError("Could not verify output manifest", { cause: error });
  }
}
