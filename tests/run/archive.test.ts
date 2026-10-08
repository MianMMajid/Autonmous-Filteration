import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRunId, loadLatestArchive, RawArchive } from "../../src/run/archive.ts";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "siteledger-sync-"));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("createRunId", () => {
  it("is filesystem safe and sortable", () => {
    expect(createRunId(new Date("2026-10-08T15:30:00.123Z"))).toBe("2026-10-08T15-30-00Z");
  });
});

describe("RawArchive", () => {
  it("writes files and a manifest, and the newest archive is loadable", async () => {
    const older = new RawArchive(dataDir, "2026-10-08T10-00-00Z");
    await older.init();
    await older.write("old.csv", "key-dates", "a,b\n");
    await older.finalize(new Date("2026-10-08T10:00:00Z"));

    const newer = new RawArchive(dataDir, "2026-10-08T12-00-00Z");
    await newer.init();
    await newer.write("register.xls", "project-register", new Uint8Array([1, 2]));
    await newer.write("page-1.json", "pulley-page", "{}", 1);
    await newer.write("../escape.json", "pulley-page", "{}", 2);
    const manifest = await newer.finalize(new Date("2026-10-08T12:00:00Z"));

    expect(manifest.files.map((f) => f.name)).toEqual([
      "register.xls",
      "page-1.json",
      ".._escape.json",
    ]);
    expect(manifest.files[0]).toEqual({ name: "register.xls", kind: "project-register", bytes: 2 });
    expect(manifest.files[1]?.page).toBe(1);

    const written = JSON.parse(await readFile(join(newer.directory, "manifest.json"), "utf8"));
    expect(written.runId).toBe("2026-10-08T12-00-00Z");

    const loaded = await loadLatestArchive(dataDir);
    expect(loaded?.manifest.runId).toBe("2026-10-08T12-00-00Z");
    const bytes = await loaded?.read(manifest.files[0] as NonNullable<(typeof manifest.files)[0]>);
    expect([...(bytes ?? [])]).toEqual([1, 2]);
  });

  it("returns null when nothing has been archived", async () => {
    expect(await loadLatestArchive(dataDir)).toBeNull();
  });

  it("skips run directories without a manifest", async () => {
    const partial = new RawArchive(dataDir, "2026-10-08T13-00-00Z");
    await partial.init();
    await partial.write("x.csv", "key-dates", "x");
    const complete = new RawArchive(dataDir, "2026-10-08T11-00-00Z");
    await complete.init();
    await complete.finalize();
    expect((await loadLatestArchive(dataDir))?.manifest.runId).toBe("2026-10-08T11-00-00Z");
  });
});
