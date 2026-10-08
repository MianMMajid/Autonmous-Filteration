import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LockedError } from "../../src/errors.ts";
import { acquireLock, LOCK_FILENAME } from "../../src/run/lock.ts";

let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "lock-"));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("acquireLock", () => {
  it("creates and releases the lock file", async () => {
    const lock = await acquireLock(dataDir, { pid: 111, isAlive: () => true });
    expect(JSON.parse(await readFile(lock.path, "utf8")).pid).toBe(111);
    await lock.release();
    await expect(readFile(lock.path, "utf8")).rejects.toThrow();
  });

  it("refuses while a live run holds it", async () => {
    await acquireLock(dataDir, { pid: 111, isAlive: () => true });
    await expect(acquireLock(dataDir, { pid: 222, isAlive: () => true })).rejects.toBeInstanceOf(
      LockedError,
    );
  });

  it("reclaims a lock whose owner is dead", async () => {
    await acquireLock(dataDir, { pid: 111, isAlive: () => true });
    const lock = await acquireLock(dataDir, { pid: 222, isAlive: (pid) => pid === 222 });
    expect(JSON.parse(await readFile(lock.path, "utf8")).pid).toBe(222);
  });

  it("reclaims an unreadable lock", async () => {
    await writeFile(join(dataDir, LOCK_FILENAME), "garbage");
    const lock = await acquireLock(dataDir, { pid: 333, isAlive: () => true });
    expect(JSON.parse(await readFile(lock.path, "utf8")).pid).toBe(333);
  });

  it("does not remove a lock that now belongs to someone else", async () => {
    const mine = await acquireLock(dataDir, { pid: 111, isAlive: () => true });
    await writeFile(mine.path, JSON.stringify({ pid: 999, startedAt: "x" }));
    await mine.release();
    expect(JSON.parse(await readFile(mine.path, "utf8")).pid).toBe(999);
  });
});
