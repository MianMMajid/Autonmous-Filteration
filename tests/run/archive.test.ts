import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IoError, SchemaError } from "../../src/errors.ts";
import { createRunId, loadArchive, loadLatestArchive, RawArchive } from "../../src/run/archive.ts";
import { pruneRuns, updateLatest, writeOutputs } from "../../src/run/outputs.ts";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "siteledger-sync-"));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("pruneRuns", () => {
  it("keeps the newest N runs in raw and out, never the latest, and ignores other folders", async () => {
    const ids = [
      "2026-10-01T00-00-00Z",
      "2026-10-02T00-00-00Z",
      "2026-10-03T00-00-00Z",
      "2026-10-04T00-00-00Z",
    ];
    for (const id of ids) {
      const a = new RawArchive(dataDir, id);
      await a.init();
      await a.finalize();
      await writeOutputs(dataDir, id, { "mapping.csv": "x" });
    }
    await updateLatest(dataDir, "2026-10-02T00-00-00Z"); // pretend an older run is the latest good one
    await mkdir(join(dataDir, "out", "keep-me"), { recursive: true });
    const removed = await pruneRuns(dataDir, 2);
    expect(removed.map((p) => p.split("/").slice(-2).join("/"))).toEqual([
      "raw/2026-10-01T00-00-00Z",
      "out/2026-10-01T00-00-00Z",
    ]);
    expect((await readdir(join(dataDir, "out"))).sort()).toEqual([
      "2026-10-02T00-00-00Z",
      "2026-10-03T00-00-00Z",
      "2026-10-04T00-00-00Z",
      "keep-me",
      "latest",
      "latest.json",
    ]);
  });
});

describe("createRunId", () => {
  it("is filesystem safe and sortable", () => {
    expect(createRunId(new Date("2026-10-08T15:30:00.123Z"))).toBe("2026-10-08T15-30-00-123Z");
    expect(createRunId(new Date("2026-10-08T15:30:00.900Z"))).not.toBe(
      createRunId(new Date("2026-10-08T15:30:00.100Z")),
    );
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
    await expect(newer.write("../escape.json", "pulley-page", "{}", 2)).rejects.toThrow(/Unsafe/);
    const manifest = await newer.finalize(new Date("2026-10-08T12:00:00Z"));

    expect(manifest.files.map((f) => f.name)).toEqual(["page-1.json", "register.xls"]);
    expect(manifest.files[1]).toMatchObject({
      name: "register.xls",
      kind: "project-register",
      bytes: 2,
    });
    expect(manifest.files[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.files[0]?.page).toBe(1);

    const written = JSON.parse(await readFile(join(newer.directory, "manifest.json"), "utf8"));
    expect(written.runId).toBe("2026-10-08T12-00-00Z");

    const loaded = await loadLatestArchive(dataDir);
    expect(loaded?.manifest.runId).toBe("2026-10-08T12-00-00Z");
    const bytes = await loaded?.read(manifest.files[1] as NonNullable<(typeof manifest.files)[0]>);
    expect([...(bytes ?? [])]).toEqual([1, 2]);
  });

  it("refuses to reuse an existing archive directory or overwrite an existing output run", async () => {
    const a = new RawArchive(dataDir, "2026-10-08T12-00-00-000Z");
    await a.init();
    await expect(new RawArchive(dataDir, "2026-10-08T12-00-00-000Z").init()).rejects.toBeInstanceOf(
      IoError,
    );
    await writeOutputs(dataDir, "2026-10-08T12-00-00-000Z", { "mapping.csv": "first" });
    await expect(
      writeOutputs(dataDir, "2026-10-08T12-00-00-000Z", { "mapping.csv": "second" }),
    ).rejects.toBeInstanceOf(IoError);
    expect(
      await readFile(join(dataDir, "out", "2026-10-08T12-00-00-000Z", "mapping.csv"), "utf8"),
    ).toBe("first");
  });

  it("detects an archived file that no longer matches its recorded hash", async () => {
    const a = new RawArchive(dataDir, "2026-10-08T14-00-00-000Z");
    await a.init();
    await a.write("dates.csv", "key-dates", "a,b\n1,2\n");
    const manifest = await a.finalize();
    await writeFile(join(a.directory, "dates.csv"), "a,b\n9,9\n");
    const loaded = await loadArchive(dataDir, "2026-10-08T14-00-00-000Z");
    await expect(
      loaded?.read(manifest.files[0] as NonNullable<(typeof manifest.files)[0]>),
    ).rejects.toBeInstanceOf(SchemaError);
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
