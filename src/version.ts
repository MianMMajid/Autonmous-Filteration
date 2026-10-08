import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { IoError } from "./errors.ts";

export const TOOL_VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

/** Content identity includes uncommitted code and dependencies; does not need Git at runtime. */
export async function implementationSha256(): Promise<string> {
  const root = fileURLToPath(new URL("./", import.meta.url));
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && /\.(ts|js)$/.test(entry.name)) files.push(path);
    }
  };
  try {
    await visit(root);
    const hash = createHash("sha256");
    for (const path of files.sort()) {
      hash.update(relative(root, path).replaceAll("\\", "/")).update("\0");
      hash.update(await readFile(path)).update("\0");
    }
    hash.update(await readFile(new URL("../package.json", import.meta.url)));
    hash.update(await readFile(new URL("../pnpm-lock.yaml", import.meta.url)));
    return hash.digest("hex");
  } catch (error) {
    throw new IoError("Could not fingerprint the implementation and dependency lockfile", {
      cause: error,
    });
  }
}
