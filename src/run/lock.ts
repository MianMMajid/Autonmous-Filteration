import { randomBytes } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { IoError, LockedError } from "../errors.ts";

/**
 * Single-run lock. Two concurrent syncs would race on `latest` and the
 * archive, so the second one exits with a clear message instead.
 *
 * Protocol:
 * - Acquire: write the owner record to a private temp file, then `link` it
 *   to the lock path. `link` is atomic and fails with EEXIST if the lock
 *   exists, and the lock file is never observed empty or half-written.
 * - Stale recovery: removing a dead owner's lock is itself serialized by a
 *   second exclusive file, the reclaim mutex. Only its holder may remove a
 *   lock, and it re-reads and re-checks liveness *while holding the mutex*,
 *   so a live owner that acquired after a contender's first read is seen
 *   and never displaced. Recovery mutexes never expire: a paused owner may
 *   resume. An abandoned mutex requires offline operator cleanup.
 * - Release: remove the lock only if it still records our pid and token;
 *   repeated release calls share the same promise and cannot remove a successor.
 *
 * Any removal of the lock path outside the owner's own release happens only
 * under the reclaim mutex, which is what makes the dead-owner check and the
 * removal a single step.
 */

export const LOCK_FILENAME = ".lock";
const RECLAIM_FILENAME = ".lock.reclaim";
const MAX_ATTEMPTS = 8;

interface LockContent {
  readonly pid: number;
  readonly startedAt: string;
  readonly token: string;
}

export interface RunLock {
  readonly path: string;
  release(): Promise<void>;
}

export interface LockOptions {
  readonly pid?: number;
  readonly isAlive?: (pid: number) => boolean;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Test hook: runs after a stale owner was observed and before reclaim begins. */
  readonly beforeReclaim?: () => Promise<void>;
}

export async function acquireLock(dataDir: string, options: LockOptions = {}): Promise<RunLock> {
  const pid = options.pid ?? process.pid;
  const isAlive = options.isAlive ?? processIsAlive;
  const sleep = options.sleep ?? defaultSleep;
  const path = join(dataDir, LOCK_FILENAME);
  await mkdir(dataDir, { recursive: true, mode: 0o700 }).catch((error: unknown) => {
    throw new IoError(`Could not create ${dataDir}`, { cause: error });
  });

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const content: LockContent = { pid, startedAt: new Date().toISOString(), token: newToken() };
    if (await createExclusive(path, content)) {
      let release: Promise<void> | undefined;
      return { path, release: () => (release ??= releaseLock(path, content)) };
    }
    const existing = await readRecord(path);
    if (existing === "missing") continue; // released between our steps; retry
    if (existing !== "corrupt" && isAlive(existing.pid)) throw locked(path, existing);
    if (options.beforeReclaim) await options.beforeReclaim();
    await reclaimDeadOwner(path, join(dataDir, RECLAIM_FILENAME), isAlive, sleep);
  }
  throw new LockedError(`Could not acquire lock ${path} after ${MAX_ATTEMPTS} attempts`, {
    details: { path },
  });
}

/**
 * Remove the lock only if, while holding the reclaim mutex, its owner is
 * still dead. A live owner found here (someone acquired after our first
 * read) is left alone and reported as holding the lock.
 */
async function reclaimDeadOwner(
  path: string,
  mutexPath: string,
  isAlive: (pid: number) => boolean,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  const mutex = await acquireReclaimMutex(mutexPath, sleep);
  try {
    const current = await readRecord(path);
    if (current === "missing") return;
    if (current !== "corrupt" && isAlive(current.pid)) throw locked(path, current);
    await removeLockFile(path);
  } finally {
    await removeLockFile(mutex);
  }
}

async function acquireReclaimMutex(
  mutexPath: string,
  sleep: (ms: number) => Promise<void>,
): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const content: LockContent = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      token: newToken(),
    };
    if (await createExclusive(mutexPath, content)) return mutexPath;
    // Never steal a recovery mutex, even if its owner appears dead. Without
    // an OS compare-and-delete primitive, recursive stale recovery races too.
    await sleep(5 + Math.floor(Math.random() * 10));
  }
  throw new LockedError(
    `Recovery mutex ${mutexPath} stays busy. Stop all sync processes and verify none can resume before removing this file; then retry. Age alone does not prove it is abandoned.`,
    { details: { path: mutexPath } },
  );
}

/** Atomically create `path` with its content in place. False if it already exists. */
async function createExclusive(path: string, content: LockContent): Promise<boolean> {
  const temp = `${path}.${content.pid}.${content.token}.tmp`;
  const payload = JSON.stringify(content);
  try {
    await writeFile(temp, payload, { flag: "wx" });
    try {
      await link(temp, path);
      return true;
    } catch (error) {
      if (isErrno(error, "EEXIST")) return false;
      if (isErrno(error, "EPERM") || isErrno(error, "ENOSYS") || isErrno(error, "EXDEV")) {
        throw new IoError(
          `Filesystem does not support atomic hard-link locking at ${path}; use a local filesystem with hard-link support`,
          { cause: error },
        );
      }
      throw new IoError(`Could not create ${path}`, { cause: error });
    } finally {
      await rm(temp, { force: true }).catch(() => undefined);
    }
  } catch (error) {
    if (error instanceof IoError) throw error;
    throw new IoError(`Could not create ${path}`, { cause: error });
  }
}

async function releaseLock(path: string, owner: LockContent): Promise<void> {
  const existing = await readRecord(path);
  if (existing === "missing" || existing === "corrupt") return;
  if (existing.pid !== owner.pid || existing.token !== owner.token) return;
  await removeLockFile(path);
}

async function removeLockFile(path: string): Promise<void> {
  try {
    await rm(path, { force: true });
  } catch (error) {
    throw new IoError(
      `Could not remove lock file ${path}; verify ownership before manual recovery`,
      { cause: error },
    );
  }
}

async function readRecord(path: string): Promise<LockContent | "missing" | "corrupt"> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return "missing";
    throw new IoError(`Could not read lock file ${path}`, { cause: error });
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      parsed &&
      typeof parsed === "object" &&
      "pid" in parsed &&
      typeof parsed.pid === "number" &&
      Number.isSafeInteger(parsed.pid) &&
      parsed.pid > 0
    ) {
      const startedAt =
        "startedAt" in parsed && typeof parsed.startedAt === "string"
          ? parsed.startedAt
          : "unknown";
      const token = "token" in parsed && typeof parsed.token === "string" ? parsed.token : "";
      return { pid: parsed.pid, startedAt, token };
    }
  } catch {
    // fall through
  }
  return "corrupt";
}

function locked(path: string, owner: LockContent): LockedError {
  return new LockedError(
    `Another sync (pid ${owner.pid}, started ${owner.startedAt}) is running. Wait for it or remove ${path} if it is stale.`,
    { details: { path, pid: owner.pid, startedAt: owner.startedAt } },
  );
}

function newToken(): string {
  return randomBytes(4).toString("hex");
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isErrno(error, "ESRCH")) return false;
    return true; // EPERM or an unexpected liveness failure cannot prove death
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
