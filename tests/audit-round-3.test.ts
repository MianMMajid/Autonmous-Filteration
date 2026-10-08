import { once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { matchProjects, RULES_VERSION } from "../src/domain/match/matcher.ts";
import { normalizeInputs } from "../src/domain/normalize/build.ts";
import { IoError, LockedError, NetworkError, SchemaError } from "../src/errors.ts";
import { createLogger } from "../src/logger.ts";
import { acquireInputs } from "../src/run/acquire.ts";
import { loadArchive, RawArchive } from "../src/run/archive.ts";
import { assertPublicationInvariants } from "../src/run/invariants.ts";
import * as lockModule from "../src/run/lock.ts";
import { acquireLock } from "../src/run/lock.ts";
import { applyOverrides, type Override } from "../src/run/overrides.ts";
import { runSync } from "../src/run/sync.ts";
import { HttpClient } from "../src/sources/http.ts";
import { dedupeProjects, PulleyClient } from "../src/sources/pulley/client.ts";
import type { PulleyProject } from "../src/sources/pulley/schema.ts";
import type { ProjectRegisterRow, SiteDirectoryRow } from "../src/sources/siteledger/schemas.ts";
import { implementationSha256, TOOL_VERSION } from "../src/version.ts";
import { acme, inputs, pulley } from "./domain/match/fixtures.ts";

const dirs: string[] = [];
async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pulley-r3-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const row: ProjectRegisterRow = {
  projectId: "1556.1002",
  siteId: "ST-1556",
  projectName: "1556.1002-RENO-NV-SUP-RM-2027",
  programYear: 2027,
  projectType: "Remodel",
  status: "Active",
};
const site: SiteDirectoryRow = {
  siteId: "ST-1556",
  banner: "Acme Market",
  locationNumber: 1556,
  formerLocationNumber: null,
  streetAddress: "100 Main St",
  mailingCity: "Reno",
  state: "NV",
  zip: "89501",
  county: "",
};
const target: PulleyProject = {
  id: "prj_x",
  name: "#1556 Remodel 2027",
  organization: "Acme Market",
  accountPlan: "full_service",
  status: "In Progress",
  projectType: "Remodel",
  jurisdictionCity: "Reno",
  state: "NV",
  streetAddress: null,
  permitSubmitted: null,
  permitApproved: null,
  constructionStart: null,
  createdAt: "2026-10-01T00:00:00Z",
};
function normalized(projects: ProjectRegisterRow[], sites = [site]) {
  return normalizeInputs({ acme: { projects, sites, keyDates: [] }, pulley: [target] });
}
const override = (acmeId: string, pulleyId: string): Override => ({
  acmeId,
  pulleyId,
  status: "matched",
  note: "synthetic decision",
  author: "",
  decidedAt: null,
});

describe("disputed identity and override closure", () => {
  it("keeps conflicting Key Dates in review instead of dropping contrary evidence", () => {
    const d = {
      projectId: row.projectId,
      designStart: null,
      permitSubmittedProjected: null,
      permitSubmittedActual: null,
      permitApproved: null,
      constructionStart: "2027-01-01",
    };
    for (const keyDates of [
      [d, { ...d, constructionStart: "2028-01-01" }],
      [{ ...d, constructionStart: "2028-01-01" }, d],
    ]) {
      const n = normalizeInputs({
        acme: { projects: [row], sites: [site], keyDates },
        pulley: [target],
      });
      expect(matchProjects(n).decisions[0]).toMatchObject({
        status: "needs_review",
        reason: "IDENTITY_DISPUTED",
      });
    }
  });
  it("holds a contradictory site join without borrowing its store number", () => {
    const n = normalized(
      [{ ...row, siteId: "ST-9999" }],
      [{ ...site, siteId: "ST-9999", locationNumber: 9999 }],
    );
    expect(n.acme[0]?.site).toBeNull();
    expect(n.acme[0]?.identityDisputed).toMatch(/neither/);
    const report = matchProjects({ ...n, pulley: [pulley({ name: "#9999 Remodel 2027" })] });
    expect(report.decisions[0]).toMatchObject({
      status: "needs_review",
      reason: "IDENTITY_DISPUTED",
      pulleyId: null,
    });
    expect(() => assertPublicationInvariants(report.decisions, n.acme, n.pulley)).not.toThrow();
  });
  it("allows a verified former location number", () => {
    const n = normalized([row], [{ ...site, locationNumber: 9999, formerLocationNumber: 1556 }]);
    expect(n.acme[0]?.identityDisputed).toBeNull();
    expect(matchProjects(n).decisions[0]?.status).toBe("matched");
  });
  it.each(["programYear", "projectType", "siteId", "status"] as const)(
    "keeps disputed %s rows in review in both orders",
    (field) => {
      const changed = {
        ...row,
        [field]: {
          programYear: 2028,
          projectType: "EV Charging",
          siteId: "ST-9999",
          status: "Closed",
        }[field],
      } as ProjectRegisterRow;
      for (const records of [
        [row, changed],
        [changed, row],
      ]) {
        const n = normalized(records);
        const report = matchProjects(n);
        expect(report.decisions[0]).toMatchObject({
          status: "needs_review",
          reason: "IDENTITY_DISPUTED",
          pulleyId: null,
        });
        expect(() => assertPublicationInvariants(report.decisions, n.acme, n.pulley)).not.toThrow();
      }
    },
  );
  it("withdraws a saved matched override on disputed identity before publication", () => {
    const a = { ...acme(), identityDisputed: "conflicting source identity" };
    const p = pulley({ id: "prj_one", name: `${a.id} Remodel` });
    const result = applyOverrides(
      matchProjects(inputs([a], [p])),
      { problems: [], overrides: [override(a.id, p.id)] },
      { acme: [a], pulley: [p] },
    );
    expect(result.applied).toBe(0);
    expect(result.problems.join("\n")).toMatch(/resolve the source identity/);
    expect(result.report.decisions[0]?.status).toBe("needs_review");
    expect(() => assertPublicationInvariants(result.report.decisions, [a], [p])).not.toThrow();
  });
  it.each([13, 32])("resolves a dependency chain across %i projects", (size) => {
    const aa = Array.from({ length: size }, (_, i) => acme({ store: 3000 + i }));
    const pp = aa.map((a, i) => pulley({ id: `prj_${i}`, name: `${a.id} Remodel` }));
    const original = matchProjects(inputs(aa, pp));
    const overrides = aa.slice(0, -1).map((a, i) => override(a.id, pp[i + 1]?.id ?? "missing"));
    const result = applyOverrides(original, { overrides, problems: [] }, { acme: aa, pulley: pp });
    expect(result.applied).toBe(0);
    expect(result.problems).toHaveLength(size - 1);
    expect(result.report.decisions).toEqual(original.decisions);
    expect(() => assertPublicationInvariants(result.report.decisions, aa, pp)).not.toThrow();
  });
});

describe("conflicting Pulley snapshots", () => {
  it("collapses identical records with different property insertion order", () => {
    const { status, ...rest } = target;
    expect(dedupeProjects([target, { status, ...rest }]).projects).toEqual([target]);
  });
  it.each([
    { status: "Canceled" },
    { accountPlan: "pathfinder" },
    { organization: "Other Company" },
    { streetAddress: "999 Other St" },
    { constructionStart: "2028-01-01" },
  ])("rejects inconsistent duplicate content in both orders: %j", (change) => {
    const other = { ...target, ...change };
    for (const records of [
      [target, other],
      [other, target],
    ]) {
      expect(() => dedupeProjects(records)).toThrow(SchemaError);
      expect(() => dedupeProjects(records)).toThrow(/conflicting duplicate/);
    }
  });
});

describe("recovery ownership", () => {
  it("reports filesystem failures without treating an unreadable lock as a dead owner", async () => {
    const dir = await temp();
    await mkdir(join(dir, ".lock"));
    await expect(acquireLock(dir)).rejects.toBeInstanceOf(IoError);
    expect((await stat(join(dir, ".lock"))).isDirectory()).toBe(true);
    const file = join(dir, "not-a-directory");
    await writeFile(file, "preserve");
    await expect(acquireLock(file)).rejects.toBeInstanceOf(IoError);
    expect(await readFile(file, "utf8")).toBe("preserve");
  });
  it("never steals an expired recovery mutex from a paused reclaimer", async () => {
    const dir = await temp();
    const control = new SharedArrayBuffer(4);
    await writeFile(join(dir, ".lock"), JSON.stringify({ pid: 999999, startedAt: "old" }));
    const worker = new Worker(
      `import {parentPort,workerData} from 'node:worker_threads';
      const {acquireLock}=await import(workerData.moduleUrl);let checks=0;
      const lock=await acquireLock(workerData.dir,{pid:2001,isAlive:(pid)=>{
        if(pid!==999999)return true;
        if(++checks===2){parentPort.postMessage('paused');Atomics.wait(new Int32Array(workerData.control),0,0);}
        return false;
      }});parentPort.postMessage('acquired');parentPort.once('message',async()=>{await lock.release();parentPort.close();});`,
      {
        eval: true,
        execArgv: [],
        workerData: {
          dir,
          control,
          moduleUrl: new URL("../src/run/lock.ts", import.meta.url).href,
        },
      },
    );
    try {
      expect((await once(worker, "message", { signal: AbortSignal.timeout(5000) }))[0]).toBe(
        "paused",
      );
      const old = new Date(Date.now() - 61000);
      await utimes(join(dir, ".lock.reclaim"), old, old);
      await expect(
        acquireLock(dir, {
          pid: 2002,
          isAlive: (pid) => pid !== 999999,
          sleep: async () => undefined,
        }),
      ).rejects.toBeInstanceOf(LockedError);
      expect(JSON.parse(await readFile(join(dir, ".lock"), "utf8")).pid).toBe(999999);
      const acquired = once(worker, "message", { signal: AbortSignal.timeout(5000) });
      Atomics.store(new Int32Array(control), 0, 1);
      Atomics.notify(new Int32Array(control), 0);
      expect((await acquired)[0]).toBe("acquired");
      expect(JSON.parse(await readFile(join(dir, ".lock"), "utf8")).pid).toBe(2001);
      const exited = once(worker, "exit");
      worker.postMessage("release");
      await exited;
    } finally {
      await worker.terminate();
    }
  });
  it("release is idempotent and cannot remove a newer owner with the same PID", async () => {
    const dir = await temp();
    const first = await acquireLock(dir);
    await first.release();
    const next = await acquireLock(dir);
    await first.release();
    expect(JSON.parse(await readFile(next.path, "utf8")).pid).toBe(process.pid);
    await next.release();
  });
  it("does not unlink a replacement token even with the same PID", async () => {
    const lock = await acquireLock(await temp());
    const replacement = { pid: process.pid, token: "replacement", startedAt: "now" };
    await writeFile(lock.path, JSON.stringify(replacement));
    await lock.release();
    expect(JSON.parse(await readFile(lock.path, "utf8"))).toEqual(replacement);
  });
});

const context = { system: "pulley", what: "test" } as const;
describe("HTTP boundaries", () => {
  it("refuses redirects even when canceling their response body fails", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            cancel() {
              throw new Error("cancel failed");
            },
          }),
          { status: 302 },
        ),
    );
    await expect(
      new HttpClient({ fetch }).request("https://test.invalid", {}, context),
    ).rejects.toThrow(/redirect refused/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("forwards caller cancellation into an in-flight attempt and does not retry it", async () => {
    const abort = new AbortController();
    const fetch = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
          setImmediate(() => abort.abort());
        }),
    );
    await expect(
      new HttpClient({ fetch }).request("https://test.invalid", { signal: abort.signal }, context),
    ).rejects.toThrow(/canceled/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("refuses a real cross-origin redirect before sending a key to its destination", async () => {
    let requests = 0;
    const sink = createServer((_req, res) => {
      requests++;
      res.end("unexpected");
    });
    sink.listen(0, "127.0.0.1");
    await once(sink, "listening");
    const port = (sink.address() as AddressInfo).port;
    const source = createServer((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${port}/redirect` });
      res.end();
    });
    source.listen(0, "127.0.0.1");
    await once(source, "listening");
    try {
      const client = new PulleyClient({
        baseUrl: `http://127.0.0.1:${(source.address() as AddressInfo).port}`,
        apiKey: "synthetic",
        http: new HttpClient(),
      });
      await expect(client.fetchAllProjects()).rejects.toThrow(/redirect refused/);
      expect(requests).toBe(0);
    } finally {
      await Promise.all([
        new Promise<void>((resolve) => source.close(() => resolve())),
        new Promise<void>((resolve) => sink.close(() => resolve())),
      ]);
    }
  });
  it.each([301, 302, 303, 307, 308])(
    "does not retry HTTP %i, even when caller requests redirect following",
    async (status) => {
      const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
        expect(init?.redirect).toBe("manual");
        return new Response(null, { status });
      });
      await expect(
        new HttpClient({ fetch }).request("https://test.invalid", { redirect: "follow" }, context),
      ).rejects.toBeInstanceOf(SchemaError);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["120", "Thu, 08 Oct 2026 00:02:00 GMT"])(
    "honors a long cooldown %s and recovers",
    async (retryAfter) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-08T00:00:00Z"));
      let elapsed = 0;
      const waits: number[] = [];
      const http = new HttpClient({
        fetch: async () =>
          elapsed < 120000
            ? new Response(null, { status: 429, headers: { "retry-after": retryAfter } })
            : Response.json({ ok: true }),
        sleep: async (ms) => {
          waits.push(ms);
          elapsed += ms;
        },
      });
      expect((await http.request("https://test.invalid", {}, context)).ok).toBe(true);
      expect(waits).toEqual([120000]);
    },
  );
  it("fails explicitly when a cooldown exceeds the remaining total wait budget", async () => {
    const fetch = vi.fn(
      async () => new Response(null, { status: 503, headers: { "retry-after": "120" } }),
    );
    const sleep = vi.fn(async () => undefined);
    await expect(
      new HttpClient({ fetch, sleep, maxRetryWaitMs: 180000 }).request(
        "https://test.invalid",
        {},
        context,
      ),
    ).rejects.toThrow(/exceeds remaining wait budget/);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });
  it.each(["nonsense", "-1"])("uses backoff for malformed Retry-After %s", async (header) => {
    let calls = 0;
    const waits: number[] = [];
    const http = new HttpClient({
      fetch: async () =>
        ++calls === 1
          ? new Response(null, { status: 429, headers: { "retry-after": header } })
          : Response.json({ ok: true }),
      sleep: async (ms) => {
        waits.push(ms);
      },
      baseDelayMs: 10,
    });
    await http.request("https://test.invalid", {}, context);
    expect(waits[0]).toBeGreaterThanOrEqual(5);
    expect(waits[0]).toBeLessThanOrEqual(10);
  });
  it("cancels a pending retry wait without issuing another request", async () => {
    const abort = new AbortController();
    const fetch = vi.fn(async () => {
      setImmediate(() => abort.abort());
      return new Response(null, { status: 429, headers: { "retry-after": "120" } });
    });
    await expect(
      new HttpClient({ fetch }).request("https://test.invalid", { signal: abort.signal }, context),
    ).rejects.toThrow(/canceled/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("does not retry pre-canceled requests or swallow failures of the wait function", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 503 }));
    await expect(
      new HttpClient({ fetch }).request(
        "https://test.invalid",
        { signal: AbortSignal.abort() },
        context,
      ),
    ).rejects.toThrow(/canceled/);
    expect(fetch).not.toHaveBeenCalled();
    await expect(
      new HttpClient({
        fetch,
        sleep: async () => {
          throw new Error("wait failed");
        },
      }).request("https://test.invalid", {}, context),
    ).rejects.toBeInstanceOf(NetworkError);
  });
  it("rejects invalid retry configuration", () => {
    expect(() => new HttpClient({ retries: -1 })).toThrow(RangeError);
    expect(() => new HttpClient({ timeoutMs: 0 })).toThrow(RangeError);
    expect(() => new HttpClient({ maxRetryWaitMs: Number.POSITIVE_INFINITY })).toThrow(RangeError);
  });
});

describe("archive and provenance", () => {
  it("reports malformed archived Pulley JSON as a schema error", async () => {
    const dataDir = await temp();
    const archive = new RawArchive(dataDir, "2026-10-08T00-00-00-000Z");
    await archive.init();
    for (const [name, kind] of [
      ["register", "project-register"],
      ["sites", "site-directory"],
      ["dates", "key-dates"],
      ["page", "pulley-page"],
    ] as const)
      await archive.write(name, kind, "{");
    await archive.finalize();
    await expect(
      acquireInputs({
        config: {
          siteLedger: { baseUrl: "https://sl.test", username: "synthetic", password: "synthetic" },
          pulley: { baseUrl: "https://p.test", apiKey: "synthetic" },
          logLevel: "error",
          dataDir,
          retainRuns: 60,
          overridesFile: join(dataDir, "overrides.csv"),
        },
        log: createLogger("error", false),
        dryRun: true,
      }),
    ).rejects.toThrow(/Archived Pulley page 1 is not valid JSON/);
  });
  it("rejects reserved/path filenames and duplicate writes without overwriting bytes", async () => {
    const archive = new RawArchive(await temp(), "2026-10-08T00-00-00-000Z");
    await archive.init();
    for (const name of ["manifest.json", "../outside", ".", "..", "a/b", "a\\b", ""]) {
      await expect(archive.write(name, "key-dates", "x")).rejects.toBeInstanceOf(SchemaError);
    }
    await archive.write("dates.csv", "key-dates", "original");
    await expect(archive.write("dates.csv", "key-dates", "replacement")).rejects.toBeInstanceOf(
      IoError,
    );
    expect(await readFile(join(archive.directory, "dates.csv"), "utf8")).toBe("original");
    await archive.finalize();
    await expect(archive.finalize()).rejects.toBeInstanceOf(IoError);
  });
  it("reports malformed manifests and invalid replay ids with typed errors", async () => {
    const dir = await temp();
    const id = "2026-10-08T00-00-00-000Z";
    const archive = new RawArchive(dir, id);
    await archive.init();
    await writeFile(join(archive.directory, "manifest.json"), "{");
    await expect(loadArchive(dir, id)).rejects.toBeInstanceOf(SchemaError);
    await expect(loadArchive(dir, "../../outside")).rejects.toBeInstanceOf(SchemaError);
  });
  it.each(["duplicate", "traversal", "identity", "length"])(
    "refuses a corrupt archive: %s",
    async (kind) => {
      const dir = await temp();
      const id = "2026-10-08T00-00-00-000Z";
      const archive = new RawArchive(dir, id);
      await archive.init();
      await archive.write("dates.csv", "key-dates", "data");
      const manifest = await archive.finalize();
      const file = manifest.files[0];
      if (!file) throw new Error("missing test file");
      const changed = {
        ...manifest,
        runId: kind === "identity" ? "other" : id,
        files:
          kind === "duplicate"
            ? [file, file]
            : [
                {
                  ...file,
                  name: kind === "traversal" ? "../outside" : file.name,
                  bytes: kind === "length" ? 999 : file.bytes,
                },
              ],
      };
      await writeFile(join(archive.directory, "manifest.json"), JSON.stringify(changed));
      if (kind === "length") {
        const loaded = await loadArchive(dir, id);
        await expect(loaded?.read(changed.files[0] ?? file)).rejects.toBeInstanceOf(SchemaError);
      } else await expect(loadArchive(dir, id)).rejects.toBeInstanceOf(SchemaError);
    },
  );
  it("publishes collision-free archives, replays them, and preserves latest on source conflicts", async () => {
    const dataDir = await temp();
    const fixture = (path: string) => readFileSync(new URL(`./fixtures/${path}`, import.meta.url));
    let conflicting = false;
    const http = new HttpClient({
      retries: 0,
      fetch: async (url) => {
        if (url.endsWith("/api/auth/login"))
          return Response.json({ token: "synthetic", expiresAt: "2099-01-01T00:00:00Z" });
        for (const [route, file] of [
          ["project-register", "project-register.xls"],
          ["site-directory", "site-directory.xlsx"],
          ["key-dates", "key-dates.csv"],
        ]) {
          if (url.endsWith(`/api/reports/${route}`))
            return new Response(fixture(`siteledger/${file}`), {
              headers: { "content-disposition": 'attachment; filename="manifest.json"' },
            });
        }
        const projects = JSON.parse(fixture("pulley/projects-all.json").toString()) as Record<
          string,
          unknown
        >[];
        if (conflicting) projects.push({ ...projects[0], status: "a conflicting new lifecycle" });
        return Response.json({ projects, next_cursor: null });
      },
    });
    const config = {
      siteLedger: { baseUrl: "https://sl.test", username: "synthetic", password: "synthetic" },
      pulley: { baseUrl: "https://p.test", apiKey: "synthetic" },
      logLevel: "error" as const,
      dataDir,
      retainRuns: 60,
      overridesFile: join(dataDir, "overrides.csv"),
    };
    const options = { config, log: createLogger("error", false), http };
    const live = await runSync({
      ...options,
      dryRun: false,
      now: () => new Date("2026-10-08T00:00:00Z"),
    });
    const manifest = await loadArchive(dataDir, live.runId);
    expect(manifest?.manifest.files.filter((f) => f.originalName === "manifest.json")).toHaveLength(
      3,
    );
    const replay = await runSync({
      ...options,
      dryRun: true,
      now: () => new Date("2026-10-08T00:00:01Z"),
    });
    expect(replay.report.decisions).toEqual(live.report.decisions);
    const record = JSON.parse(await readFile(join(replay.outputDirectory, "run.json"), "utf8"));
    expect(record.implementationSha256).toBe(await implementationSha256());
    expect(record.rulesVersion).toBe(RULES_VERSION);
    expect(record.toolVersion).toBe(TOOL_VERSION);
    conflicting = true;
    await expect(
      runSync({ ...options, dryRun: false, now: () => new Date("2026-10-08T00:00:02Z") }),
    ).rejects.toThrow(/conflicting duplicate/);
    expect(JSON.parse(await readFile(join(dataDir, "out", "latest.json"), "utf8")).runId).toBe(
      replay.runId,
    );
    vi.spyOn(lockModule, "acquireLock").mockResolvedValue({
      path: join(dataDir, ".lock"),
      release: async () => {
        throw new IoError("synthetic cleanup failure");
      },
    });
    // Cleanup must not replace the meaningful source error.
    await expect(
      runSync({ ...options, dryRun: false, now: () => new Date("2026-10-08T00:00:03Z") }),
    ).rejects.toThrow(/conflicting duplicate/);
    // Nor may it report a failed run after publication has already committed.
    conflicting = false;
    await expect(
      runSync({ ...options, dryRun: true, now: () => new Date("2026-10-08T00:00:04Z") }),
    ).resolves.toMatchObject({ runId: "2026-10-08T00-00-04-000Z" });
  });
  it("records a content fingerprint and distinct release versions", async () => {
    expect(RULES_VERSION).not.toBe("2026-10-08.4");
    expect(TOOL_VERSION).not.toBe("0.1.0");
    const hash = await implementationSha256();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await implementationSha256()).toBe(hash);
  });
});
