import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, loadLocalConfig } from "../src/config.ts";
import { IoError, QualityError, SchemaError } from "../src/errors.ts";
import { createLogger } from "../src/logger.ts";
import { backupState, restoreState, verifyBackup } from "../src/run/backup.ts";
import { evaluateRun } from "../src/run/evaluate.ts";
import { outputManifest, verifyOutputDirectory } from "../src/run/integrity.ts";
import { monitorPublication, publicationDue } from "../src/run/monitor.ts";
import { latestRunId, loadPreviousRun, updateLatest } from "../src/run/outputs.ts";
import { readPublishedStatus } from "../src/run/status.ts";
import { runSync } from "../src/run/sync.ts";
import { HttpClient } from "../src/sources/http.ts";
import { checkWorkbookExpansion, MAX_INPUT_BYTES, MAX_ROWS } from "../src/sources/limits.ts";
import { parseKeyDates } from "../src/sources/siteledger/parse.ts";
import { fixture, pipeline } from "./helpers/pipeline.ts";

const execute = promisify(execFile);
const cli = new URL("../src/cli.ts", import.meta.url).pathname;
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pulley-r4-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const invoke = (dataDir: string, args: string[]) =>
  execute(process.execPath, [cli, ...args], {
    env: {
      PATH: process.env["PATH"] ?? "",
      DATA_DIR: dataDir,
      OVERRIDES_FILE: join(dataDir, "overrides.csv"),
      LOG_LEVEL: "error",
    },
  });

async function reseal(directory: string) {
  const manifest = JSON.parse(await readFile(join(directory, "output-manifest.json"), "utf8")) as {
    files: { name: string }[];
    runId: string;
  };
  const files: Record<string, string> = {};
  for (const file of manifest.files)
    files[file.name] = await readFile(join(directory, file.name), "utf8");
  await writeFile(join(directory, "output-manifest.json"), outputManifest(manifest.runId, files));
}

describe("R4 publication boundaries", () => {
  it.each([
    "json",
    "schema",
    "missing",
    "identity",
    "counts",
    "duplicate",
    "pointer",
    "pointer-missing",
  ])("refuses %s history without fetching or moving latest", async (variant) => {
    const p = pipeline(root);
    const first = await p.run();
    p.collapse();
    await expect(p.run("2026-10-08T11:00:00Z")).rejects.toBeInstanceOf(QualityError);
    const file = join(first.outputDirectory, "run.json");
    const record = JSON.parse(await readFile(file, "utf8"));
    const pointer = join(root, "out/latest.json");
    if (variant === "json") await writeFile(file, "{");
    else if (variant === "missing") await rm(file);
    else if (variant === "pointer") await writeFile(pointer, '{"runId":"../escape"}');
    else if (variant === "pointer-missing") await rm(pointer);
    else {
      switch (variant) {
        case "schema":
          record.decisions = null;
          break;
        case "identity":
          record.runId = "2026-10-08T00-00-00-000Z";
          break;
        case "counts":
          delete record.inputs.counts;
          break;
        case "duplicate":
          record.decisions.push(record.decisions[0]);
          break;
      }
      await writeFile(file, JSON.stringify(record));
      await reseal(first.outputDirectory);
    }
    const calls = p.calls();
    await expect(p.run("2026-10-08T12:00:00Z")).rejects.toThrow();
    expect(p.calls()).toBe(calls);
    if (variant !== "pointer" && variant !== "pointer-missing")
      expect(JSON.parse(await readFile(pointer, "utf8")).runId).toBe(first.runId);
  });
  it("rejects inaccessible history with a typed IO error", async () => {
    const p = pipeline(root);
    const first = await p.run();
    const path = join(first.outputDirectory, "run.json");
    await chmod(path, 0);
    try {
      if (process.getuid?.() !== 0)
        await expect(loadPreviousRun(root)).rejects.toBeInstanceOf(IoError);
    } finally {
      await chmod(path, 0o600);
    }
  });
  it("validates legacy records without pretending absent counts are a current baseline", async () => {
    const p = pipeline(root);
    const first = await p.run();
    const path = join(first.outputDirectory, "run.json");
    const record = JSON.parse(await readFile(path, "utf8"));
    record.version = 2;
    await writeFile(path, JSON.stringify(record));
    expect((await loadPreviousRun(root))?.matched).toBe(332);
    delete record.counts;
    await writeFile(path, JSON.stringify(record));
    await expect(loadPreviousRun(root)).rejects.toBeInstanceOf(SchemaError);
  });
  it("returns the current immutable path when the convenience link is stale", async () => {
    const p = pipeline(root);
    const first = await p.run();
    await mkdir(join(root, "out/latest.tmp"));
    const second = await p.run("2026-10-08T11:00:00Z");
    expect(await updateLatest(root, second.runId)).toMatch(/symlink/);
    expect(await readFile(join(root, "out/latest/run.json"), "utf8")).toContain(first.runId);
    const result = await invoke(root, ["published-path"]);
    expect(result.stdout.trim()).toBe(second.outputDirectory);
  });
  it("does not report a damaged mapping as a healthy publication", async () => {
    const p = pipeline(root);
    const first = await p.run();
    await writeFile(join(first.outputDirectory, "mapping.csv"), "damaged");
    await expect(readPublishedStatus(root)).rejects.toThrow(/integrity/);
    await expect(invoke(root, ["published-path"])).rejects.toMatchObject({ code: 5 });
  });
  it("rejects linked output files", async () => {
    const p = pipeline(root);
    const first = await p.run();
    const mapping = join(first.outputDirectory, "mapping.csv");
    await rm(mapping);
    await symlink(join(first.outputDirectory, "review.csv"), mapping);
    await expect(verifyOutputDirectory(first.outputDirectory, first.runId)).rejects.toBeInstanceOf(
      SchemaError,
    );
  });
  it.each([
    ["sync", "--dry-run", "--quiet"],
    ["sync", "--replay", "2026-10-08T10-00-00-000Z", "--quiet"],
  ])("runs offline CLI without live credentials: %s", async (...args) => {
    const p = pipeline(root);
    const first = await p.run();
    const original = await readFile(join(first.outputDirectory, "mapping.csv"), "utf8");
    await invoke(root, args);
    const id = await latestRunId(root);
    expect(id).not.toBe(first.runId);
    expect(await readFile(join(root, "out", id ?? "", "mapping.csv"), "utf8")).toBe(original);
  });
  it("reports missing archive rather than requesting credentials", async () => {
    await expect(invoke(root, ["sync", "--dry-run"])).rejects.toMatchObject({ code: 5 });
  });
});

describe("verified backups and restoration", () => {
  it("restores onto a clean host directory, then replays identical mappings without secrets", async () => {
    const dataDir = join(root, "data");
    const p = pipeline(dataDir);
    const first = await p.run();
    const backup = await backupState(dataDir, join(root, "backups"));
    expect((await verifyBackup(backup)).runId).toBe(first.runId);
    await expect(backupState(dataDir, join(root, "backups"))).rejects.toBeInstanceOf(IoError);
    const restored = join(root, "restored");
    await restoreState(backup, restored);
    expect((await loadPreviousRun(restored))?.runId).toBe(first.runId);
    const replay = await runSync({
      config: loadLocalConfig({
        DATA_DIR: restored,
        OVERRIDES_FILE: join(restored, "out", first.runId, "overrides.snapshot.csv"),
      }),
      log: createLogger("error", false),
      dryRun: true,
      replayRunId: first.runId,
      now: () => new Date("2026-10-08T11:00:00Z"),
    });
    expect(await readFile(join(replay.outputDirectory, "mapping.csv"), "utf8")).toBe(
      await readFile(join(first.outputDirectory, "mapping.csv"), "utf8"),
    );
    await expect(restoreState(backup, restored)).rejects.toBeInstanceOf(IoError);
  });
  it.each(["bytes", "path", "duplicate", "missing", "link"])(
    "refuses %s damage before creating a restore target",
    async (variant) => {
      const dataDir = join(root, "data");
      const p = pipeline(dataDir);
      const first = await p.run();
      const backup = await backupState(dataDir, join(root, "backups"));
      const manifestPath = join(backup, "backup.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      if (variant === "bytes")
        await writeFile(join(backup, "data/out", first.runId, "mapping.csv"), "changed");
      if (variant === "path") manifest.files[0].path = "data/../../escaped";
      if (variant === "duplicate") manifest.files.push(manifest.files[0]);
      if (variant === "missing")
        manifest.files = manifest.files.filter(
          (f: { path: string }) => !f.path.endsWith("mapping.csv"),
        );
      if (variant === "link") {
        const file = join(backup, "implementation/package.json");
        await rm(file);
        await symlink(join(root, "absent"), file);
      }
      await writeFile(manifestPath, JSON.stringify(manifest));
      await expect(restoreState(backup, join(root, "restored"))).rejects.toThrow();
      await expect(readFile(join(root, "restored/out/latest.json"))).rejects.toThrow();
    },
  );
});

describe("resource and credential boundaries", () => {
  it.each([true, false])(
    "bounds HTTP response bytes with content-length=%s, without retries",
    async (withLength) => {
      let calls = 0;
      const http = new HttpClient({
        retries: 3,
        maxResponseBytes: 4,
        fetch: async () => {
          calls++;
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(3));
                controller.enqueue(new Uint8Array(3));
                controller.close();
              },
            }),
            withLength ? { headers: { "content-length": "6" } } : {},
          );
        },
      });
      await expect(
        http.request("https://test.invalid", {}, { what: "test", system: "pulley" }),
      ).rejects.toBeInstanceOf(SchemaError);
      expect(calls).toBe(1);
    },
  );
  it.each(["response", "transport"])(
    "never reflects synthetic credentials in %s error messages",
    async (kind) => {
      const marker = "SYNTHETIC_DO_NOT_LOG_739";
      const http = new HttpClient({
        retries: 0,
        fetch: async () => {
          if (kind === "transport") throw new Error(marker);
          return Response.json({ message: marker }, { status: 401 });
        },
      });
      const error = await http
        .request("https://test.invalid/a?key=hidden", {}, { what: "test", system: "pulley" })
        .catch((e: unknown) => e);
      expect(String(error)).not.toContain(marker);
      expect(JSON.stringify(error)).not.toContain(marker);
    },
  );
  it.each([
    "http://example.test",
    "https://user:pass@example.test",
    "https://example.test/?key=x",
    "file:///tmp/a",
  ])("rejects unsafe production endpoint %s", (url) => {
    expect(() =>
      loadConfig({
        SITELEDGER_USERNAME: "fixture",
        SITELEDGER_PASSWORD: "fixture",
        PULLEY_API_KEY: "fixture",
        PULLEY_BASE_URL: url,
      }),
    ).toThrow();
  });
  it("bounds CSV bytes and row counts", () => {
    expect(() => parseKeyDates(new Uint8Array(MAX_INPUT_BYTES + 1))).toThrow(/byte limit/);
    const lines = fixture("siteledger/key-dates.csv").toString().trim().split(/\r?\n/);
    expect(() => parseKeyDates(`${lines[0]}\n${`${lines[1]}\n`.repeat(MAX_ROWS + 8)}`)).toThrow(
      /row or column/,
    );
  });
  it("validates fixture ZIP expansion and rejects a forged oversized entry", () => {
    const bytes = fixture("siteledger/site-directory.xlsx");
    expect(() => checkWorkbookExpansion(bytes)).not.toThrow();
    const position = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(position).toBeGreaterThan(0);
    bytes.writeUInt32LE(0xffffffff, position + 24);
    expect(() => checkWorkbookExpansion(bytes)).toThrow(/expansion/);
  });
});

describe("independent schedule monitoring and evaluation", () => {
  const schedule = {
    version: 1 as const,
    utcHours: [13, 17, 21],
    minute: 17,
    weekdays: [1, 2, 3, 4, 5],
    graceMinutes: 60,
  };
  it("checks the last due run through grace periods and weekends", () => {
    expect(publicationDue(schedule, new Date("2026-10-12T13:30:00Z")).toISOString()).toBe(
      "2026-10-09T21:17:00.000Z",
    );
    expect(publicationDue(schedule, new Date("2026-10-12T14:18:00Z")).toISOString()).toBe(
      "2026-10-12T13:17:00.000Z",
    );
  });
  it("detects a never-run, missed-run and stale-source replay", async () => {
    const path = join(root, "schedule.json");
    await writeFile(path, JSON.stringify(schedule));
    expect((await monitorPublication(root, path, new Date("2026-10-09T22:30:00Z"))).healthy).toBe(
      false,
    );
    const p = pipeline(root);
    await p.run("2026-10-09T21:20:00Z");
    expect((await monitorPublication(root, path, new Date("2026-10-11T12:00:00Z"))).healthy).toBe(
      true,
    );
    expect(
      (await monitorPublication(root, path, new Date("2026-10-12T14:30:00Z"))).problems,
    ).toContain("Missed publication deadline");
    await runSync({
      config: p.config,
      log: createLogger("error", false),
      dryRun: true,
      now: () => new Date("2026-10-12T13:20:00Z"),
    });
    const result = await monitorPublication(root, path, new Date("2026-10-12T14:30:00Z"));
    expect(result.problems).toEqual(["Source snapshot predates required run"]);
  });
  it("reports correct targets, false matches, missed matches and unresolved truth separately", async () => {
    const p = pipeline(root);
    const first = await p.run();
    const matched = first.report.decisions.filter((d) => d.status === "matched");
    const noMatch = first.report.decisions.find((d) => d.status === "no_match");
    if (!matched[0] || !matched[1] || !matched[2] || !noMatch)
      throw new Error("fixture decisions absent");
    const labels = join(root, "labels.csv");
    const header =
      "acme_project_id,expected_status,allowed_pulley_ids,reviewer,decided_at,source_run_id,rationale\n";
    await writeFile(
      labels,
      header +
        [
          `${matched[0].acmeId},matched,${matched[0].pulleyId};prj_alternative,fixture,2026-10-08,${first.runId},synthetic test`,
          `${matched[1].acmeId},no_match,,fixture,2026-10-08,${first.runId},synthetic test`,
          `${matched[2].acmeId},unresolved,,fixture,2026-10-08,${first.runId},synthetic test`,
          `${noMatch.acmeId},matched,prj_expected,fixture,2026-10-08,${first.runId},synthetic test`,
        ].join("\n"),
    );
    const report = await evaluateRun(root, first.runId, labels);
    expect(report.overall).toMatchObject({
      labeled: 4,
      resolved: 3,
      unresolved: 1,
      precision: 0.5,
      falseAutoMatches: 1,
      falseNoMatches: 1,
    });
    expect(report.disagreements).toHaveLength(2);
    const original = await readFile(labels, "utf8");
    await writeFile(labels, original.replaceAll(first.runId, "2026-10-01T00-00-00-000Z"));
    await expect(evaluateRun(root, first.runId, labels)).rejects.toThrow(
      /different input snapshot/,
    );
    await writeFile(labels, `${original}\n${original.split("\n")[1]}`);
    await expect(evaluateRun(root, first.runId, labels)).rejects.toThrow(/Duplicate/);
  });
});

describe("deployment integration and publication commit failures", () => {
  it("requires provisioned persistent state, a verified bootstrap and independent monitoring", async () => {
    const data = join(root, "data");
    const backup = join(root, "backup");
    const p = pipeline(data);
    await p.run();
    await mkdir(backup);
    const script = new URL("../scripts/deployment-preflight.mjs", import.meta.url).pathname;
    const env = {
      PATH: process.env["PATH"] ?? "",
      DATA_DIR: data,
      BACKUP_DIR: backup,
      SYNC_ENABLED: "true",
      SYNC_HEARTBEAT_URL: "https://monitor.invalid/synthetic",
      GITHUB_WORKSPACE: process.cwd(),
    };
    await expect(execute(process.execPath, [script], { env })).rejects.toThrow();
    for (const directory of [data, backup])
      await writeFile(join(directory, ".deployment-ready"), "pulley-state-v1\n");
    await expect(execute(process.execPath, [script], { env })).resolves.toMatchObject({
      stderr: "",
    });
    await expect(
      execute(process.execPath, [script], { env: { ...env, BACKUP_DIR: data } }),
    ).rejects.toThrow();
    await expect(
      execute(process.execPath, [script], { env: { ...env, SYNC_HEARTBEAT_URL: "" } }),
    ).rejects.toThrow();
  });
  it("does not expose the heartbeat endpoint on network failure", async () => {
    const marker = "SYNTHETIC_HEARTBEAT_TOKEN_62";
    const script = new URL("../scripts/heartbeat.mjs", import.meta.url).href;
    const code = `globalThis.fetch = async () => { throw new Error(process.env.SYNC_HEARTBEAT_URL); }; await import(${JSON.stringify(script)});`;
    const error = (await execute(process.execPath, ["--input-type=module", "-e", code], {
      env: { SYNC_HEARTBEAT_URL: `https://monitor.invalid/${marker}` },
    }).catch((e: unknown) => e)) as { code: number; stderr: string };
    expect(error.code).not.toBe(0);
    expect(error.stderr).not.toContain(marker);
    expect(error.stderr).toContain("heartbeat failed");
  });
  it("preserves the prior pointer if final pointer replacement cannot be staged", async () => {
    const p = pipeline(root);
    const first = await p.run();
    await mkdir(join(root, "out/latest.json.tmp"));
    await expect(p.run("2026-10-08T11:00:00Z")).rejects.toBeInstanceOf(IoError);
    expect(await latestRunId(root)).toBe(first.runId);
    expect((await loadPreviousRun(root))?.matched).toBe(332);
  });
  it("excludes human overrides and unresolved labels from automatic precision", async () => {
    const p = pipeline(root);
    const first = await p.run();
    const decision = first.report.decisions.find((d) => d.status === "matched");
    if (!decision) throw new Error("No matched fixture row");
    await writeFile(
      p.config.overridesFile,
      `acme_project_id,pulley_project_id,status,note\n${decision.acmeId},${decision.pulleyId},matched,synthetic\n`,
    );
    const second = await p.run("2026-10-08T11:00:00Z");
    const labels = join(root, "labels.csv");
    await writeFile(
      labels,
      `acme_project_id,expected_status,allowed_pulley_ids,reviewer,decided_at,source_run_id,rationale\n${decision.acmeId},matched,${decision.pulleyId},fixture,2026-10-08,${second.runId},synthetic\n`,
    );
    const report = await evaluateRun(root, second.runId, labels);
    expect(report.overall.overridesExcluded).toBe(1);
    expect(report.overall.precision).toBeNull();
    expect(report.overall.resolved).toBe(0);
  });
  it("detects implementation damage in a backup even if its file list is edited", async () => {
    const data = join(root, "data");
    const p = pipeline(data);
    await p.run();
    const snapshot = await backupState(data, join(root, "backup"));
    const manifestPath = join(snapshot, "backup.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const file = manifest.files.find((entry: { path: string }) =>
      entry.path.endsWith("/src/config.ts"),
    );
    if (!file) throw new Error("Source file missing");
    await rm(join(snapshot, file.path));
    manifest.files = manifest.files.filter((entry: { path: string }) => entry.path !== file.path);
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(verifyBackup(snapshot)).rejects.toThrow(/implementation/);
  });
});

it("refuses retention rather than deleting archives when a retained reference is unreadable", async () => {
  const { pruneRuns } = await import("../src/run/outputs.ts");
  const { readdir } = await import("node:fs/promises");
  const p = pipeline(root);
  const first = await p.run();
  await p.run("2026-10-08T11:00:00Z");
  await p.run("2026-10-08T12:00:00Z");
  await writeFile(join(first.outputDirectory, "run.json"), "{");
  const before = await readdir(join(root, "raw"));
  await expect(pruneRuns(root, 3)).rejects.toBeInstanceOf(IoError);
  expect(await readdir(join(root, "raw"))).toEqual(before);
});

it("verifies written bytes before advancing the publication pointer", async () => {
  const outputs = await import("../src/run/outputs.ts");
  const p = pipeline(root);
  const first = await p.run();
  const original = outputs.writeOutputs;
  const mocked = vi.spyOn(outputs, "writeOutputs").mockImplementation(async (...args) => {
    const directory = await original(...args);
    await writeFile(join(directory, "mapping.csv"), "synthetic write corruption");
    return directory;
  });
  try {
    await expect(p.run("2026-10-08T11:00:00Z")).rejects.toBeInstanceOf(SchemaError);
    expect(await latestRunId(root)).toBe(first.runId);
  } finally {
    mocked.mockRestore();
  }
});
