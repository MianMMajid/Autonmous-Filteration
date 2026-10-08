import { readFileSync } from "node:fs";
import { chmod, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../../src/config.ts";
import { IoError, LockedError } from "../../src/errors.ts";
import { createLogger } from "../../src/logger.ts";
import { acquireLock } from "../../src/run/lock.ts";
import { loadPreviousRun } from "../../src/run/outputs.ts";
import { runSync } from "../../src/run/sync.ts";
import { HttpClient } from "../../src/sources/http.ts";
import { json, mockFetch, noSleep } from "../helpers/mock-fetch.ts";

const fixture = (path: string): Buffer =>
  readFileSync(new URL(`../fixtures/${path}`, import.meta.url));

let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "sync-"));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function config(): Config {
  return {
    siteLedger: { baseUrl: "https://sl.test", username: "u", password: "p" },
    pulley: { baseUrl: "https://p.test", apiKey: "k" },
    logLevel: "error",
    dataDir,
  };
}

/** Real fixtures served from fake hosts. `mutate` can alter the Pulley page before it is returned. */
function upstreams(mutate: (projects: Record<string, unknown>[]) => void = () => undefined) {
  const all = JSON.parse(fixture("pulley/projects-all.json").toString("utf8")) as Record<
    string,
    unknown
  >[];
  return mockFetch((url) => {
    if (url.endsWith("/api/auth/login"))
      return json({ token: "tok", expiresAt: "2099-01-01T00:00:00Z" });
    if (url.endsWith("/api/reports/project-register"))
      return new Response(fixture("siteledger/project-register.xls"));
    if (url.endsWith("/api/reports/site-directory"))
      return new Response(fixture("siteledger/site-directory.xlsx"));
    if (url.endsWith("/api/reports/key-dates"))
      return new Response(fixture("siteledger/key-dates.csv"));
    if (url.includes("/api/pulley/v1/projects")) {
      const projects = structuredClone(all);
      mutate(projects);
      return json({ projects, next_cursor: null });
    }
    throw new Error(`unexpected url ${url}`);
  });
}

function run(fetch: ReturnType<typeof mockFetch>, now: string, dryRun = false) {
  return runSync({
    config: config(),
    log: createLogger("error", false),
    dryRun,
    http: new HttpClient({ fetch: fetch.fetch, retries: 0, sleep: noSleep }),
    now: () => new Date(now),
  });
}

describe("runSync end to end", () => {
  it("writes every output file, the run record, and the latest pointer", async () => {
    const outcome = await run(upstreams(), "2026-10-08T10:00:00Z");
    expect(outcome.runId).toBe("2026-10-08T10-00-00Z");
    expect((await readdir(outcome.outputDirectory)).sort()).toEqual([
      "decisions.csv",
      "mapping.csv",
      "pulley-unmatched.csv",
      "review.csv",
      "run.json",
      "summary.txt",
    ]);

    const mapping = (await readFile(join(outcome.outputDirectory, "mapping.csv"), "utf8")).split(
      "\n",
    );
    expect(mapping[0]).toBe("acme_pcroject_id,pulley_project_id,status");
    expect(mapping.filter((line) => line !== "")).toHaveLength(401);
    expect(
      mapping
        .slice(1)
        .every(
          (line) =>
            line === "" ||
            /^\d{4}\.\d{4},(prj_[a-z0-9]+)?,(matched|needs_review|no_match)$/.test(line),
        ),
    ).toBe(true);

    expect(outcome.summary).toMatch(/Results: matched \d+ \(\d+\.\d%\)/);
    expect(outcome.summary).toMatch(/first run/);
    expect((await loadPreviousRun(dataDir))?.runId).toBe("2026-10-08T10-00-00Z");
    expect(JSON.parse(await readFile(join(dataDir, "out", "latest.json"), "utf8"))).toEqual({
      runId: "2026-10-08T10-00-00Z",
    });
    expect(await readdir(join(dataDir, "out"))).not.toContain("2026-10-08T10-00-00Z.partial");
  });

  it("is byte-identical across two runs over the same inputs and reports no changes", async () => {
    const first = await run(upstreams(), "2026-10-08T10:00:00Z");
    const second = await run(upstreams(), "2026-10-08T11:00:00Z");
    const a = await readFile(join(first.outputDirectory, "mapping.csv"), "utf8");
    const b = await readFile(join(second.outputDirectory, "mapping.csv"), "utf8");
    expect(a).toBe(b);
    expect(second.diff.previousRunId).toBe("2026-10-08T10-00-00Z");
    expect(second.diff.changes).toEqual([]);
    expect(second.summary).toMatch(/0 newly matched, 0 lost match/);
  });

  it("reports what changed when a Pulley project is canceled upstream", async () => {
    const first = await run(upstreams(), "2026-10-08T10:00:00Z");
    const victim = first.report.decisions.find(
      (d) => d.status === "matched" && d.acmeStatus === "Active",
    );
    if (!victim?.pulleyId) throw new Error("expected a live matched row");
    const second = await run(
      upstreams((projects) => {
        const p = projects.find((x) => x["id"] === victim.pulleyId);
        if (p) p["status"] = "Canceled";
      }),
      "2026-10-08T11:00:00Z",
    );
    const change = second.diff.changes.find((c) => c.acmeId === victim.acmeId);
    expect(change?.kind).toBe("lost_match");
    expect(second.summary).toContain(
      `${victim.acmeId}: matched (${victim.pulleyId}) -> needs_review`,
    );
  });

  it("replays the archive in dry-run mode and still writes outputs", async () => {
    const fetch = upstreams();
    await run(fetch, "2026-10-08T10:00:00Z");
    const calls = fetch.calls.length;
    const replay = await run(fetch, "2026-10-08T12:00:00Z", true);
    expect(fetch.calls.length).toBe(calls);
    expect(replay.summary).toMatch(/replayed archive/);
    expect(replay.diff.changes).toEqual([]);
  });

  it("refuses to run while another sync holds the lock, and leaves latest alone", async () => {
    await run(upstreams(), "2026-10-08T10:00:00Z");
    const held = await acquireLock(dataDir, { pid: process.pid });
    await expect(run(upstreams(), "2026-10-08T11:00:00Z")).rejects.toBeInstanceOf(LockedError);
    await held.release();
    expect((await loadPreviousRun(dataDir))?.runId).toBe("2026-10-08T10-00-00Z");
  });

  it("does not move latest when writing outputs fails", async () => {
    await run(upstreams(), "2026-10-08T10:00:00Z");
    const outRoot = join(dataDir, "out");
    await chmod(outRoot, 0o555); // read-only: the partial directory cannot be created
    try {
      await expect(run(upstreams(), "2026-10-08T11:00:00Z")).rejects.toBeInstanceOf(IoError);
    } finally {
      await chmod(outRoot, 0o755);
    }
    expect((await loadPreviousRun(dataDir))?.runId).toBe("2026-10-08T10-00-00Z");
    expect(await readdir(outRoot)).not.toContain("2026-10-08T11-00-00Z");
  });
});
