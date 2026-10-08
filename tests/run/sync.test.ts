import { readFileSync } from "node:fs";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../../src/config.ts";
import { IoError, LockedError, QualityError } from "../../src/errors.ts";
import { createLogger } from "../../src/logger.ts";
import { acquireLock } from "../../src/run/lock.ts";
import { loadPreviousRun } from "../../src/run/outputs.ts";
import { readPublishedStatus, renderStatus } from "../../src/run/status.ts";
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
    retainRuns: 60,
    overridesFile: join(dataDir, "overrides.csv"),
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
  it("publishes a review delta without hiding the unresolved backlog", async () => {
    const first = await run(upstreams(), "2026-10-08T10:00:00Z");
    expect(await readFile(join(first.outputDirectory, "review-changes.csv"), "utf8")).toBe(
      await readFile(join(first.outputDirectory, "review.csv"), "utf8"),
    );
    const second = await run(upstreams(), "2026-10-08T11:00:00Z");
    expect(
      (await readFile(join(second.outputDirectory, "review-changes.csv"), "utf8"))
        .trim()
        .split("\n"),
    ).toHaveLength(1);
    expect(second.report.counts.needs_review).toBe(first.report.counts.needs_review);
    expect(second.summary).toContain(`${first.report.counts.needs_review} unchanged`);
    const changed = await run(
      upstreams((projects) => {
        const p = projects.find((p) => p["id"] === "prj_ae5zai");
        if (!p) throw new Error("missing fixture");
        p["status"] = "In Progress";
      }),
      "2026-10-08T12:00:00Z",
    );
    const delta = await readFile(join(changed.outputDirectory, "review-changes.csv"), "utf8");
    expect(delta).toContain("3716.1005");
    expect(changed.summary).toContain("1 changed or lacking a comparison baseline");
  });
  it("writes every output file, the run record, and the latest pointer", async () => {
    const outcome = await run(upstreams(), "2026-10-08T10:00:00Z");
    expect(outcome.runId).toBe("2026-10-08T10-00-00-000Z");
    expect((await readdir(outcome.outputDirectory)).sort()).toEqual([
      "decisions.csv",
      "handoff.md",
      "mapping.csv",
      "output-manifest.json",
      "overrides.snapshot.csv",
      "pulley-unmatched.csv",
      "review-changes.csv",
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
    expect((await loadPreviousRun(dataDir))?.runId).toBe("2026-10-08T10-00-00-000Z");
    expect(JSON.parse(await readFile(join(dataDir, "out", "latest.json"), "utf8"))).toEqual({
      runId: "2026-10-08T10-00-00-000Z",
    });
    expect(await readdir(join(dataDir, "out"))).not.toContain("2026-10-08T10-00-00-000Z.partial");
  });

  it("is byte-identical across two runs over the same inputs and reports no changes", async () => {
    const first = await run(upstreams(), "2026-10-08T10:00:00Z");
    const second = await run(upstreams(), "2026-10-08T11:00:00Z");
    const a = await readFile(join(first.outputDirectory, "mapping.csv"), "utf8");
    const b = await readFile(join(second.outputDirectory, "mapping.csv"), "utf8");
    expect(a).toBe(b);
    expect(second.diff.previousRunId).toBe("2026-10-08T10-00-00-000Z");
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

  it("replays an archive whose pages repeat a project exactly like the live run", async () => {
    const all = JSON.parse(fixture("pulley/projects-all.json").toString("utf8")) as Record<
      string,
      unknown
    >[];
    const fetch = mockFetch((url) => {
      if (url.endsWith("/api/auth/login"))
        return json({ token: "tok", expiresAt: "2099-01-01T00:00:00Z" });
      if (url.endsWith("/api/reports/project-register"))
        return new Response(fixture("siteledger/project-register.xls"));
      if (url.endsWith("/api/reports/site-directory"))
        return new Response(fixture("siteledger/site-directory.xlsx"));
      if (url.endsWith("/api/reports/key-dates"))
        return new Response(fixture("siteledger/key-dates.csv"));
      if (url.includes("cursor=")) return json({ projects: all.slice(0, 3), next_cursor: null }); // repeats
      return json({ projects: all, next_cursor: "again" });
    });
    const live = await run(fetch, "2026-10-08T10:00:00Z");
    const replay = await run(fetch, "2026-10-08T11:00:00Z", true);
    expect(replay.report.counts).toEqual(live.report.counts);
    expect(replay.report.decisions.map((d) => [d.acmeId, d.status, d.pulleyId])).toEqual(
      live.report.decisions.map((d) => [d.acmeId, d.status, d.pulleyId]),
    );
    expect(replay.summary).toMatch(/3 duplicate project id/);
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

  it("applies overrides and reports the ones it cannot apply", async () => {
    const first = await run(upstreams(), "2026-10-08T10:00:00Z");
    const review = first.report.decisions.find((d) => d.reason === "AMBIGUOUS");
    const target = review?.candidates[0]?.pulleyId;
    if (!review || !target) throw new Error("expected a review row with a candidate");
    await writeFile(
      join(dataDir, "overrides.csv"),
      `acme_project_id,pulley_project_id,status,note\n${review.acmeId},${target},matched,settled\n9999.1000,,no_match,unknown id\n`,
    );
    const second = await run(upstreams(), "2026-10-08T11:00:00Z");
    const decision = second.report.decisions.find((d) => d.acmeId === review.acmeId);
    expect(decision).toMatchObject({ status: "matched", pulleyId: target, reason: "OVERRIDE" });
    expect(second.summary).toMatch(/Overrides: 1 applied/);
    expect(second.summary).toMatch(/9999\.1000 ignored: not in the Project Register/);
    expect(second.diff.changes.find((c) => c.acmeId === review.acmeId)?.kind).toBe("newly_matched");
  });

  it("refuses to publish when the inputs collapse, and publishes when the operator accepts", async () => {
    await run(upstreams(), "2026-10-08T10:00:00Z");
    const collapsed = upstreams((projects) => {
      projects.length = 10;
    });
    await expect(run(collapsed, "2026-10-08T11:00:00Z")).rejects.toBeInstanceOf(QualityError);
    expect((await loadPreviousRun(dataDir))?.runId).toBe("2026-10-08T10-00-00-000Z");
    expect(await readdir(join(dataDir, "out"))).not.toContain("2026-10-08T11-00-00-000Z");

    const forced = await runSync({
      config: config(),
      log: createLogger("error", false),
      dryRun: false,
      acceptInputChange: true,
      http: new HttpClient({ fetch: collapsed.fetch, retries: 0, sleep: noSleep }),
      now: () => new Date("2026-10-08T12:00:00Z"),
    });
    expect(forced.quality.blockers.length).toBeGreaterThan(0);
    expect(forced.summary).toMatch(/publication was forced with --accept-input-change/);
    expect((await loadPreviousRun(dataDir))?.runId).toBe("2026-10-08T12-00-00-000Z");
  });

  it("records provenance in run.json and can replay a chosen historical run", async () => {
    const first = await run(upstreams(), "2026-10-08T10:00:00Z");
    const record = JSON.parse(await readFile(join(first.outputDirectory, "run.json"), "utf8"));
    expect(record.version).toBe(3);
    expect(record.rulesVersion).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
    expect(record.toolVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(record.inputs.counts).toEqual({
      acmeProjects: 400,
      acmeSites: 363,
      acmeKeyDates: 400,
      pulleyProjects: 449,
    });
    expect(
      record.inputs.files.every((f: { sha256?: string }) => /^[0-9a-f]{64}$/.test(f.sha256 ?? "")),
    ).toBe(true);
    expect(record.overrides.path).toBe(join(dataDir, "overrides.csv"));
    expect(record.config.acceptInputChange).toBe(false);
    expect(record.publishedAt).toBe("2026-10-08T10:00:00.000Z");

    await run(
      upstreams((projects) => {
        projects.splice(0, 5);
      }),
      "2026-10-08T11:00:00Z",
    );
    const replay = await runSync({
      config: config(),
      log: createLogger("error", false),
      dryRun: true,
      replayRunId: "2026-10-08T10-00-00-000Z",
      now: () => new Date("2026-10-08T12:00:00Z"),
    });
    expect(replay.report.counts).toEqual(first.report.counts);
    expect(replay.summary).toMatch(/replayed archive/);
  });

  it("reports review workload against the previous run", async () => {
    const first = await run(upstreams(), "2026-10-08T10:00:00Z");
    const review = first.report.decisions.find((d) => d.reason === "AMBIGUOUS");
    const target = review?.candidates[0]?.pulleyId;
    if (!review || !target) throw new Error("expected a review row with a candidate");
    await writeFile(
      join(dataDir, "overrides.csv"),
      `acme_project_id,pulley_project_id,status,note,author,decided_at\n${review.acmeId},${target},matched,settled,J. Lee,2026-10-09\n`,
    );
    const second = await run(upstreams(), "2026-10-08T11:00:00Z");
    expect(second.summary).toMatch(/Review workload: 0 new, 1 resolved since the previous run/);
    expect(second.report.decisions.find((d) => d.acmeId === review.acmeId)?.note).toBe(
      "override by J. Lee on 2026-10-09: settled",
    );
    const status = await readPublishedStatus(dataDir, new Date("2026-10-08T13:00:00Z"));
    expect(status?.runId).toBe("2026-10-08T11-00-00-000Z");
    expect(status?.ageHours).toBeCloseTo(2, 5);
    expect(renderStatus(status, 1)).toMatch(/STALE/);
    expect(renderStatus(status, 3)).toMatch(/Fresh/);
    expect(status?.sourceAcquiredAt).toBe("2026-10-08T11:00:00.000Z");
    const replay = await run(upstreams(), "2026-10-08T14:00:00Z", true);
    const replayed = await readPublishedStatus(dataDir, new Date("2026-10-08T14:00:00Z"));
    expect(replay.runId).toBe(replayed?.runId);
    expect(replayed?.ageHours).toBeCloseTo(0, 5);
    expect(replayed?.sourceAgeHours).toBeCloseTo(3, 5);
    expect(renderStatus(replayed, 24, 1)).toMatch(/STALE: source data fetched more than 1 h ago/);
  });

  it("refuses to run while another sync holds the lock, and leaves latest alone", async () => {
    await run(upstreams(), "2026-10-08T10:00:00Z");
    const held = await acquireLock(dataDir, { pid: process.pid });
    await expect(run(upstreams(), "2026-10-08T11:00:00Z")).rejects.toBeInstanceOf(LockedError);
    await held.release();
    expect((await loadPreviousRun(dataDir))?.runId).toBe("2026-10-08T10-00-00-000Z");
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
    expect((await loadPreviousRun(dataDir))?.runId).toBe("2026-10-08T10-00-00-000Z");
    expect(await readdir(outRoot)).not.toContain("2026-10-08T11-00-00-000Z");
  });
});
