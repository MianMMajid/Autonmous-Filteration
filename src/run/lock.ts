import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { IoError, LockedError } from "../errors.ts";

/**
 * Single-run lock. Two concurrent syncs would race on `latest` and the
 * archive, so the second one exits with a clear message instead.
 *
 * The lock file holds the owner's pid; a lock whose pid is no longer alive
 * (crash, kill -9) is reclaimed automatically.
 */

export const LOCK_FILENAME = ".lock";

interface LockContent {
  readonly pid: number;
  readonly startedAt: string;
}

export interface RunLock {
  readonly path: string;
  release(): Promise<void>;
}

export async function acquireLock(
  dataDir: string,
  options: { readonly pid?: number; readonly isAlive?: (pid: number) => boolean } = {},
): Promise<RunLock> {
  const pid = options.pid ?? process.pid;
  const isAlive = options.isAlive ?? processIsAlive;
  const path = join(dataDir, LOCK_FILENAME);
  await mkdir(dataDir, { recursive: true }).catch((error: unknown) => {
    throw new IoError(`Could not create ${dataDir}`, { cause: error });
  });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const content: LockContent = { pid, startedAt: new Date().toISOString() };
      await writeFile(path, JSON.stringify(content), { flag: "wx" });
      return { path, release: () => releaseLock(path, pid) };
    } catch (error) {
      if (!isErrno(error, "EEXIST"))
        throw new IoError(`Could not create lock ${path}`, { cause: error });
    }
    const existing = await readLock(path);
    if (existing && isAlive(existing.pid)) {
      throw new LockedError(
        `Another sync (pid ${existing.pid}, started ${existing.startedAt}) is running. Wait for it or remove ${path} if it is stale.`,
        { details: { path, pid: existing.pid, startedAt: existing.startedAt } },
      );
    }
    // Stale or unreadable lock: reclaim it and retry once.
    await rm(path, { force: true });
  }
  throw new LockedError(`Could not acquire lock ${path}`, { details: { path } });
}

async function releaseLock(path: string, pid: number): Promise<void> {
  const existing = await readLock(path);
  if (existing && existing.pid !== pid) return; // not ours any more
  await rm(path, { force: true });
}

async function readLock(path: string): Promise<LockContent | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (parsed && typeof parsed === "object" && "pid" in parsed && typeof parsed.pid === "number") {
      const startedAt =
        "startedAt" in parsed && typeof parsed.startedAt === "string"
          ? parsed.startedAt
          : "unknown";
      return { pid: parsed.pid, startedAt };
    }
    return null;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrno(error, "EPERM"); // exists but owned by someone else
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
