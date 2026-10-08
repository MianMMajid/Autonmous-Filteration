/**
 * Regression tests for the round-two audit (docs/BUG_AUDIT_ROUND_2.md).
 * Each case reproduces the audited scenario and asserts the required
 * behavior, replacing the audit's probe script which asserted the defects.
 */
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { matchProjects } from "../src/domain/match/matcher.ts";
import { ReasonCode } from "../src/domain/match/types.ts";
import { Banner, type PulleyRecord } from "../src/domain/model.ts";
import { normalizeInputs } from "../src/domain/normalize/build.ts";
import { LockedError } from "../src/errors.ts";
import { RawArchive } from "../src/run/archive.ts";
import { assertPublicationInvariants, InvariantError } from "../src/run/invariants.ts";
import { acquireLock, LOCK_FILENAME, type RunLock } from "../src/run/lock.ts";
import { pruneRuns, updateLatest, writeOutputs } from "../src/run/outputs.ts";
import { applyOverrides, parseOverrides } from "../src/run/overrides.ts";
import { pulleyProjectSchema } from "../src/sources/pulley/schema.ts";
import {
  parseKeyDates,
  parseProjectRegister,
  parseSiteDirectory,
} from "../src/sources/siteledger/parse.ts";
import { acme, inputs, pulley } from "./domain/match/fixtures.ts";

const HEADER = "acme_project_id,pulley_project_id,status,note\n";

describe("R2-01 conflicting strong anchors never allow a cross-year assignment", () => {
  it("two exact ids on one project from different years both go to review", () => {
    const both = pulley({ id: "prj_both", name: "1556.1002 / 1556.1003 - Reno, NV" });
    const report = matchProjects(
      inputs(
        [acme({ sequence: 1002, programYear: 2027 }), acme({ sequence: 1003, programYear: 2028 })],
        [both],
      ),
    );
    expect(report.decisions.map((d) => [d.status, d.reason])).toEqual([
      ["needs_review", ReasonCode.YearConflict],
      ["needs_review", ReasonCode.YearConflict],
    ]);
  });

  it("two exact-date anchors from different years both go to review", () => {
    const dates = { constructionStart: "2027-06-01" };
    const store = pulley({
      id: "prj_store",
      name: "#1556 Reno, NV",
      constructionStart: "2027-06-01",
    });
    const report = matchProjects(
      inputs(
        [
          acme({ sequence: 1002, programYear: 2027, dates }),
          acme({ sequence: 1003, programYear: 2028, dates }),
        ],
        [store],
      ),
    );
    expect(report.decisions.every((d) => d.status === "needs_review")).toBe(true);
  });
});

describe("R2-02 stale recovery cannot displace a live owner", () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "lock-r2-"));
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("the audited interleaving ends with exactly one owner", async () => {
    await writeFile(join(dataDir, LOCK_FILENAME), JSON.stringify({ pid: 1, startedAt: "x" }));
    const isAlive = (pid: number): boolean => pid !== 1;
    let b: RunLock | undefined;
    // A observes the stale lock, pauses; B reclaims it and acquires; A resumes.
    const a = acquireLock(dataDir, {
      pid: 2001,
      isAlive,
      beforeReclaim: async () => {
        b = await acquireLock(dataDir, { pid: 2002, isAlive });
      },
    });
    await expect(a).rejects.toBeInstanceOf(LockedError);
    expect(b).toBeDefined();
    const owner = JSON.parse(await readFile(join(dataDir, LOCK_FILENAME), "utf8")).pid;
    expect(owner).toBe(2002);
    await b?.release();
    await expect(readFile(join(dataDir, LOCK_FILENAME))).rejects.toThrow();
  });
});

describe("R2-04 and R2-06 disputed identity never raises confidence", () => {
  const fixture = (path: string): Uint8Array =>
    new Uint8Array(readFileSync(new URL(`./fixtures/${path}`, import.meta.url)));
  const real = () => ({
    acme: {
      projects: parseProjectRegister(fixture("siteledger/project-register.xls")).rows,
      sites: parseSiteDirectory(fixture("siteledger/site-directory.xlsx")).rows,
      keyDates: parseKeyDates(fixture("siteledger/key-dates.csv")).rows,
    },
    pulley: (
      JSON.parse(
        readFileSync(new URL("./fixtures/pulley/projects-all.json", import.meta.url), "utf8"),
      ) as unknown[]
    ).map((p) => pulleyProjectSchema.parse(p)),
  });

  it("a project whose site rows conflict is held for review instead of auto-matched", () => {
    const disputed = {
      ...acme({ site: null, name: "1556.1002-RENO-NV-SUP-RM-2027" }),
      identityDisputed: "Site ST-1556 appears in the Site Directory with conflicting content",
    };
    const d = matchProjects(
      inputs([disputed], [pulley({ id: "prj_nv", name: "1556.1002 - Reno, NV" })]),
    ).decisions[0];
    expect(d).toMatchObject({
      status: "needs_review",
      reason: ReasonCode.IdentityDisputed,
      pulleyId: null,
    });
    expect(d?.note).toMatch(/would otherwise match prj_nv/);
  });

  it("conflicting Site Directory rows mark the project disputed in normalization", () => {
    const base = real();
    const site = base.acme.sites[0] as (typeof base.acme.sites)[number];
    const result = normalizeInputs({
      ...base,
      acme: { ...base.acme, sites: [...base.acme.sites, { ...site, streetAddress: "1 Other St" }] },
    });
    for (const p of result.acme.filter((p) => p.siteId === site.siteId)) {
      expect(p.identityDisputed).toMatch(/conflicting content/);
    }
  });

  it("conflicting register rows produce the same review decision in either order", () => {
    const base = real();
    const row = base.acme.projects[0] as (typeof base.acme.projects)[number];
    const twin = { ...row, status: row.status === "Active" ? "Closed" : "Active" };
    const forward = matchProjects(
      normalizeInputs({
        ...base,
        acme: { ...base.acme, projects: [row, twin, ...base.acme.projects.slice(1)] },
      }),
    );
    const backward = matchProjects(
      normalizeInputs({
        ...base,
        acme: { ...base.acme, projects: [twin, row, ...base.acme.projects.slice(1)] },
      }),
    );
    const f = forward.decisions.find((d) => d.acmeId === row.projectId);
    const b = backward.decisions.find((d) => d.acmeId === row.projectId);
    expect(f?.status).not.toBe("matched");
    expect([f?.status, f?.pulleyId]).toEqual([b?.status, b?.pulleyId]);
  });
});

describe("R2-05 overrides cannot bypass assignment or temporal constraints", () => {
  it("rejects an override that points another year at a permit the matcher assigned", () => {
    const permit = pulley({
      id: "prj_2027",
      name: "1556.1002 Remodel 2027",
      projectType: "Remodel",
    });
    const register = [
      acme({ sequence: 1002, programYear: 2027, projectType: "Remodel" }),
      acme({ sequence: 1003, programYear: 2028, projectType: "Remodel" }),
    ];
    const report = matchProjects(inputs(register, [permit]));
    expect(report.decisions.map((d) => d.status)).toEqual(["matched", "no_match"]);
    const loaded = parseOverrides(`${HEADER}1556.1003,prj_2027,matched,looks right to me\n`);
    const result = applyOverrides(report, loaded, { acme: register, pulley: [permit] });
    expect(result.applied).toBe(0);
    expect(result.problems[0]).toMatch(/another program year/);
    expect(result.report.decisions.map((d) => d.status)).toEqual(["matched", "no_match"]);
  });

  it("withdraws an override that would share a permit across years with an automatic match", () => {
    const permit = pulley({ id: "prj_store", name: "#1556 Reno, NV", projectType: "Remodel" });
    const register = [
      acme({ sequence: 1002, programYear: 2027, projectType: "Remodel" }),
      acme({ sequence: 1003, programYear: 2028, projectType: "EV Charging" }),
    ];
    const report = matchProjects(inputs(register, [permit]));
    expect(report.decisions.map((d) => d.status)).toEqual(["matched", "needs_review"]);
    const loaded = parseOverrides(`${HEADER}1556.1003,prj_store,matched,\n`);
    const result = applyOverrides(report, loaded, { acme: register, pulley: [permit] });
    expect(result.applied).toBe(0);
    expect(result.problems.join("\n")).toMatch(
      /also assigned to 1556\.1002 \(2027\)|another program year/,
    );
    expect(() =>
      assertPublicationInvariants(result.report.decisions, register, [permit]),
    ).not.toThrow();
  });
});

describe("R2-07 acceptance uses the best decisive score, not the display order", () => {
  it("prefers exact address over same-city street-name plus a soft date", () => {
    const d = matchProjects(
      inputs(
        [acme({ street: "100 Main St", projectType: "Remodel", programYear: 2027 })],
        [
          pulley({
            id: "prj_a",
            name: "#1556 Reno, NV",
            projectType: "Remodel",
            street: "200 Main St",
            jurisdictionCity: "Reno",
            constructionStart: "2027-03-01",
          }),
          pulley({
            id: "prj_b",
            name: "Acme 1556 - Washoe County, NV",
            projectType: "Remodel",
            street: "100 Main St",
            jurisdictionCity: "Washoe County",
          }),
        ],
      ),
    ).decisions[0];
    expect(d).toMatchObject({ status: "matched", pulleyId: "prj_b" });
    expect(d?.candidates[0]?.pulleyId).toBe("prj_b");
  });
});

describe("R2-08 unknown organizations never compare equal", () => {
  it("holds a row for review when the banner is unknown on either side", () => {
    const unknownAcme = { ...acme({ site: null, name: "1556.1002 - Reno" }), banner: null };
    const unknownPulley: PulleyRecord = {
      ...pulley({ name: "1556.1002 - Reno, NV" }),
      banner: null,
      organization: "Other Company",
    };
    const both = matchProjects(inputs([unknownAcme], [unknownPulley])).decisions[0];
    expect(both?.status).not.toBe("matched");
    const oneSide = matchProjects(inputs([acme({ banner: Banner.Market })], [unknownPulley]))
      .decisions[0];
    expect(oneSide).toMatchObject({ status: "needs_review", reason: ReasonCode.IdOutsideScope });
  });
});

describe("R2-09 retention keeps the archive a retained output was computed from", () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "prune-r2-"));
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("protects a replayed result's source archive at the retention boundary", async () => {
    for (const id of [
      "2026-09-01T00-00-00-000Z",
      "2026-09-02T00-00-00-000Z",
      "2026-09-03T00-00-00-000Z",
    ]) {
      const a = new RawArchive(dataDir, id);
      await a.init();
      await a.finalize();
    }
    const replayId = "2026-10-08T00-00-00-000Z";
    await writeOutputs(dataDir, replayId, {
      "run.json": JSON.stringify({
        version: 2,
        runId: replayId,
        inputs: { archiveDirectory: join(dataDir, "raw", "2026-09-01T00-00-00-000Z") },
        decisions: [],
      }),
    });
    await updateLatest(dataDir, replayId);
    const removed = await pruneRuns(dataDir, 1);
    expect(removed.map((p) => p.split("/").pop())).toEqual(["2026-09-02T00-00-00-000Z"]);
    await expect(
      readFile(join(dataDir, "raw", "2026-09-01T00-00-00-000Z", "manifest.json")),
    ).resolves.toBeDefined();
  });
});

describe("R2-10 unrelated banner or state records cannot change a decision", () => {
  it("a Warehouse Club site in another state with a former number 1556 leaves the Market match alone", () => {
    const nv = acme({
      store: 1556,
      sequence: 1002,
      banner: Banner.Market,
      state: "NV",
      city: "Reno",
    });
    const project = pulley({
      id: "prj_nv",
      name: "1556.1002 - Reno, NV",
      jurisdictionCity: "Washoe County",
      street: null,
    });
    const before = matchProjects(inputs([nv], [project])).decisions[0];
    const ca = acme({
      store: 9999,
      sequence: 1000,
      banner: Banner.WarehouseClub,
      state: "CA",
      city: "Fresno",
      formerLocationNumber: 1556,
    });
    const after = matchProjects(inputs([nv, ca], [project])).decisions.find(
      (d) => d.acmeId === "1556.1002",
    );
    expect(before).toMatchObject({ status: "matched", pulleyId: "prj_nv" });
    expect([after?.status, after?.pulleyId]).toEqual([before?.status, before?.pulleyId]);
  });
});

describe("publication invariants", () => {
  it("refuses a result that breaks a hard rule", () => {
    const a = acme({ sequence: 1002, programYear: 2027 });
    const b = acme({ sequence: 1003, programYear: 2028 });
    const target = pulley({ id: "prj_x", name: "#1556 Reno, NV" });
    const good = matchProjects(inputs([a, b], [target]));
    expect(() => assertPublicationInvariants(good.decisions, [a, b], [target])).not.toThrow();
    const broken = good.decisions.map((d) => ({
      ...d,
      status: "matched" as const,
      pulleyId: "prj_x",
    }));
    expect(() => assertPublicationInvariants(broken, [a, b], [target])).toThrow(InvariantError);
  });
});
