import { randomBytes } from "node:crypto";
import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { IoError, LockedError } from "../errors.ts";

/**
 * Single-run lock. Two concurrent syncs would race on `latest` and the
 * archive, so the second one exits with a clear message instead.
 *
 * Protocol (no window in which two owners can both hold the lock):
 * - Acquire: write the owner record to a private temp file, then `link` it
 *   to the lock path. `link` is atomic and fails with EEXIST if the lock
 *   exists, and the lock file is never observed empty or half-written.
 * - Stale recovery: a lock whose owner pid is no longer alive is *claimed*
 *   by renaming it to a private name. `rename` succeeds for exactly one
 *   contender; everyone else sees ENOENT and simply retries the acquire. A
 *   contender can therefore never delete a replacement owner's live lock.
 * - Release: remove the lock only if it still records our pid.
 */

export const LOCK_FILENAME = ".lock";
const MAX_ATTEMPTS = 6;

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

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (await tryCreate(path, { pid, startedAt: new Date().toISOString() })) {
      return { path, release: () => releaseLock(path, pid) };
    }
    const existing = await readLock(path);
    if (existing === "missing") continue; // released between our attempts; retry
    if (existing !== "corrupt" && isAlive(existing.pid)) {
      throw new LockedError(
        `Another sync (pid ${existing.pid}, started ${existing.startedAt}) is running. Wait for it or remove ${path} if it is stale.`,
        { details: { path, pid: existing.pid, startedAt: existing.startedAt } },
      );
    }
    await claimStale(path); // whoever wins the rename removes it; everyone retries
  }
  throw new LockedError(`Could not acquire lock ${path} after ${MAX_ATTEMPTS} attempts`, {
    details: { path },
  });
}

/** Atomically create the lock with its content in place. False if it already exists. */
async function tryCreate(path: string, content: LockContent): Promise<boolean> {
  const temp = `${path}.${content.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const payload = JSON.stringify(content);
  try {
    await writeFile(temp, payload, { flag: "wx" });
    try {
      await link(temp, path);
      return true;
    } catch (error) {
      if (isErrno(error, "EEXIST")) return false;
      if (isErrno(error, "EPERM") || isErrno(error, "ENOSYS") || isErrno(error, "EXDEV")) {
        // Filesystems without hard links: fall back to exclusive create.
        return exclusiveWrite(path, payload);
      }
      throw new IoError(`Could not create lock ${path}`, { cause: error });
    } finally {
      await rm(temp, { force: true }).catch(() => undefined);
    }
  } catch (error) {
    if (error instanceof IoError) throw error;
    throw new IoError(`Could not create lock ${path}`, { cause: error });
  }
}

async function exclusiveWrite(path: string, payload: string): Promise<boolean> {
  try {
    await writeFile(path, payload, { flag: "wx" });
    return true;
  } catch (error) {
    if (isErrno(error, "EEXIST")) return false;
    throw new IoError(`Could not create lock ${path}`, { cause: error });
  }
}

/** Rename the stale lock to a private name; only one contender can succeed. */
async function claimStale(path: string): Promise<void> {
  const claimed = `${path}.stale.${randomBytes(4).toString("hex")}`;
  try {
    await rename(path, claimed);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return; // someone else claimed or released it
    throw new IoError(`Could not reclaim stale lock ${path}`, { cause: error });
  }
  await rm(claimed, { force: true }).catch(() => undefined);
}

async function releaseLock(path: string, pid: number): Promise<void> {
  const existing = await readLock(path);
  if (existing === "missing") return;
  if (existing !== "corrupt" && existing.pid !== pid) return; // not ours any more
  await rm(path, { force: true });
}

async function readLock(path: string): Promise<LockContent | "missing" | "corrupt"> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    return isErrno(error, "ENOENT") ? "missing" : "corrupt";
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && "pid" in parsed && typeof parsed.pid === "number") {
      const startedAt =
        "startedAt" in parsed && typeof parsed.startedAt === "string"
          ? parsed.startedAt
          : "unknown";
      return { pid: parsed.pid, startedAt };
    }
  } catch {
    // fall through
  }
  return "corrupt";
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
