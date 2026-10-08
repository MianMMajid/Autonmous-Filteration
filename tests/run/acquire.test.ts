import { readFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../../src/config.ts";
import { SchemaError } from "../../src/errors.ts";
import { createLogger } from "../../src/logger.ts";
import { acquireInputs } from "../../src/run/acquire.ts";
import { HttpClient } from "../../src/sources/http.ts";
import { json, mockFetch, noSleep } from "../helpers/mock-fetch.ts";

const fixture = (path: string): Buffer =>
  readFileSync(new URL(`../fixtures/${path}`, import.meta.url));

let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "acquire-"));
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
  };
}

/** Serves the real fixtures from fake SiteLedger and Pulley hosts. */
function fakeUpstreams() {
  const page1 = JSON.parse(fixture("pulley/page-1.json").toString("utf8")) as {
    projects: unknown[];
  };
  const half = Math.floor(page1.projects.length / 2);
  return mockFetch((url) => {
    if (url.endsWith("/api/auth/login"))
      return json({ token: "tok", expiresAt: "2099-01-01T00:00:00Z" });
    if (url.endsWith("/api/reports/project-register")) {
      return new Response(fixture("siteledger/project-register.xls"), {
        headers: { "content-disposition": 'attachment; filename="Register.xls"' },
      });
    }
    if (url.endsWith("/api/reports/site-directory")) {
      return new Response(fixture("siteledger/site-directory.xlsx"), {
        headers: { "content-disposition": 'attachment; filename="Sites.xlsx"' },
      });
    }
    if (url.endsWith("/api/reports/key-dates")) {
      return new Response(fixture("siteledger/key-dates.csv"), {
        headers: { "content-disposition": 'attachment; filename="Dates.csv"' },
      });
    }
    if (url.includes("/api/pulley/v1/projects")) {
      const second = url.includes("cursor=");
      return json({
        projects: second ? page1.projects.slice(half) : page1.projects.slice(0, half),
        next_cursor: second ? null : "next",
      });
    }
    throw new Error(`unexpected url ${url}`);
  });
}

describe("acquireInputs", () => {
  it("fetches live, archives raw bytes, and parses everything", async () => {
    const fetch = fakeUpstreams();
    const http = new HttpClient({ fetch: fetch.fetch, retries: 0, sleep: noSleep });
    const now = () => new Date("2026-10-08T15:00:00Z");
    const log = createLogger("error", false);

    const inputs = await acquireInputs({ config: config(), log, dryRun: false, http, now });

    expect(inputs.source).toBe("live");
    expect(inputs.runId).toBe("2026-10-08T15-00-00-000Z");
    expect(inputs.acme.projects).toHaveLength(400);
    expect(inputs.acme.sites).toHaveLength(363);
    expect(inputs.acme.keyDates).toHaveLength(400);
    expect(inputs.pulley).toHaveLength(100);
    expect(inputs.vocabulary).toEqual([]);
    expect(inputs.warnings).toEqual([]);

    const archived = (await readdir(inputs.archiveDirectory)).sort();
    expect(archived).toEqual([
      "Dates.csv",
      "Register.xls",
      "Sites.xlsx",
      "manifest.json",
      "pulley-projects.page-001.json",
      "pulley-projects.page-002.json",
    ]);
  });

  it("replays the newest archive in dry-run mode without network", async () => {
    const fetch = fakeUpstreams();
    const http = new HttpClient({ fetch: fetch.fetch, retries: 0, sleep: noSleep });
    const log = createLogger("error", false);
    await acquireInputs({ config: config(), log, dryRun: false, http });
    const liveCalls = fetch.calls.length;

    const replay = await acquireInputs({ config: config(), log, dryRun: true, http });
    expect(fetch.calls.length).toBe(liveCalls);
    expect(replay.source).toBe("archive");
    expect(replay.acme.projects).toHaveLength(400);
    expect(replay.pulley).toHaveLength(100);
  });

  it("explains when dry-run has nothing to replay", async () => {
    const log = createLogger("error", false);
    await expect(acquireInputs({ config: config(), log, dryRun: true })).rejects.toBeInstanceOf(
      SchemaError,
    );
  });

  it("reports vocabulary drift instead of failing", async () => {
    const base = fakeUpstreams();
    const fetch = mockFetch(async (url, init) => {
      const response = await base.fetch(url, init);
      if (!url.includes("/api/pulley/v1/projects") || url.includes("cursor=")) return response;
      const body = (await response.json()) as {
        projects: Record<string, unknown>[];
        next_cursor: string | null;
      };
      const first = body.projects[0];
      if (first) first["status"] = "Paused";
      return json(body);
    });
    const http = new HttpClient({ fetch: fetch.fetch, retries: 0, sleep: noSleep });
    const log = createLogger("error", false);
    const inputs = await acquireInputs({ config: config(), log, dryRun: false, http });
    const drift = inputs.vocabulary.find((v) => v.field === "status");
    expect(drift).toMatchObject({ source: "pulley", value: "Paused", count: 1 });
  });
});
