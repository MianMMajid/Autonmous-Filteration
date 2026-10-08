import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { matchProjects } from "../../src/domain/match/matcher.ts";
import { Banner } from "../../src/domain/model.ts";
import { SchemaError } from "../../src/errors.ts";
import { applyOverrides, loadOverrides, parseOverrides } from "../../src/run/overrides.ts";
import { acme, inputs, pulley } from "../domain/match/fixtures.ts";

const HEADER = "acme_project_id,pulley_project_id,status,note\n";

describe("parseOverrides", () => {
  it("reads valid rows and reports every invalid one with its line", () => {
    const text = `${HEADER}1556.1002,prj_a,matched,confirmed
1556.1003,,no_match,never opened
bad-id,prj_a,matched,
1556.1004,prj_a,maybe,
1556.1005,,matched,
1556.1006,prj_b,no_match,
1556.1002,prj_a,matched,confirmed
`;
    const { overrides, problems } = parseOverrides(text, "test.csv");
    expect(overrides).toEqual([
      {
        acmeId: "1556.1002",
        pulleyId: "prj_a",
        status: "matched",
        note: "confirmed",
        author: "",
        decidedAt: null,
      },
      {
        acmeId: "1556.1003",
        pulleyId: null,
        status: "no_match",
        note: "never opened",
        author: "",
        decidedAt: null,
      },
    ]);
    expect(problems).toHaveLength(5);
    expect(problems[0]).toMatch(/line 4.*not store\.sequence/);
    expect(problems[1]).toMatch(/line 5.*status/);
    expect(problems[2]).toMatch(/line 6.*requires a pulley_project_id/);
    expect(problems[3]).toMatch(/line 7.*must not carry/);
    expect(problems[4]).toMatch(/line 8.*duplicate/);
  });

  it("rejects a file with the wrong columns", () => {
    expect(() => parseOverrides("acme,pulley\n1,2\n")).toThrow(SchemaError);
  });

  it("requires a header even when no decisions exist", () => {
    expect(() => parseOverrides("")).toThrow(SchemaError);
    expect(parseOverrides(HEADER)).toEqual({ overrides: [], problems: [] });
  });
});

describe("parseOverrides author and decided_at", () => {
  it("records who decided and when, and rejects a bad date", () => {
    const text =
      "acme_project_id,pulley_project_id,status,note,author,decided_at\n1556.1002,prj_a,matched,ok,J. Lee,2026-10-09\n1556.1003,,no_match,,,next tuesday\n";
    const { overrides, problems } = parseOverrides(text, "t.csv");
    expect(overrides).toEqual([
      {
        acmeId: "1556.1002",
        pulleyId: "prj_a",
        status: "matched",
        note: "ok",
        author: "J. Lee",
        decidedAt: "2026-10-09",
      },
    ]);
    expect(problems[0]).toMatch(/line 3.*decided_at/);
  });
});

describe("loadOverrides", () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "overrides-"));
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("treats a missing file as no overrides", async () => {
    const missing = await loadOverrides(join(dataDir, "overrides.csv"));
    expect(missing.overrides).toEqual([]);
    expect(missing.source.sha256).toBeNull();
  });

  it("reads the file when present", async () => {
    await writeFile(join(dataDir, "overrides.csv"), `${HEADER}1556.1002,prj_a,matched,ok\n`);
    const loaded = await loadOverrides(join(dataDir, "overrides.csv"));
    expect(loaded.overrides).toHaveLength(1);
    expect(loaded.source.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("applyOverrides", () => {
  const pool = [
    pulley({ id: "prj_a", name: "#1556 Reno, NV" }),
    pulley({ id: "prj_b", name: "Acme 1556 - Reno, NV" }),
    pulley({ id: "prj_path", name: "1556.1003 - Reno, NV", accountPlan: "pathfinder" }),
  ];
  const register = [acme({ sequence: 1002 }), acme({ sequence: 1003 })];
  const report = matchProjects(inputs(register, pool));

  it("replaces decisions, recomputes counts, and keeps the rest", () => {
    // Both Acme rows share store 1556 and the two Pulley projects tie, so both are review items.
    expect(report.decisions.map((d) => d.status)).toEqual(["needs_review", "needs_review"]);
    const loaded = parseOverrides(
      `${HEADER}1556.1002,prj_a,matched,confirmed by lead\n1556.1003,,no_match,\n`,
    );
    const result = applyOverrides(report, loaded, { acme: register, pulley: pool });
    expect(result.applied).toBe(2);
    expect(result.problems).toEqual([]);
    expect(result.report.decisions.map((d) => [d.status, d.pulleyId, d.reason])).toEqual([
      ["matched", "prj_a", "OVERRIDE"],
      ["no_match", null, "OVERRIDE"],
    ]);
    expect(result.report.decisions[0]?.note).toBe("override: confirmed by lead");
    expect(result.overridden.map((o) => [o.acmeId, o.matcher.status, o.matcher.reason])).toEqual([
      ["1556.1002", "needs_review", "AMBIGUOUS"],
      ["1556.1003", "needs_review", "AMBIGUOUS"],
    ]);
    expect(result.report.decisions[0]?.candidates.length).toBeGreaterThan(0);
    expect(result.report.counts).toEqual({ matched: 1, needs_review: 0, no_match: 1 });
    expect(result.report.unmatchedPulley.map((p) => p.id)).toEqual(["prj_b"]);
  });

  it("asks for reconfirmation when upstream facts no longer allow the recorded match", () => {
    const canceled = [
      pulley({ id: "prj_a", name: "#1556 Reno, NV", status: "Canceled" }),
      pulley({ id: "prj_b", name: "Acme 1556 - Reno, NV" }),
      pulley({ id: "prj_wc", name: "1556.1003 - Reno, NV", banner: Banner.WarehouseClub }),
    ];
    const current = matchProjects(inputs(register, canceled));
    const loaded = parseOverrides(
      `${HEADER}1556.1002,prj_a,matched,confirmed last week\n1556.1003,prj_wc,matched,typo\n`,
    );
    const result = applyOverrides(current, loaded, { acme: register, pulley: canceled });
    expect(result.applied).toBe(0);
    expect(result.problems[0]).toMatch(
      /1556\.1002 needs reconfirmation: Acme is now Active and prj_a is Canceled/,
    );
    expect(result.problems[1]).toMatch(
      /1556\.1003 needs reconfirmation: prj_wc is Acme Warehouse Club/,
    );
    expect(result.report.decisions).toEqual(current.decisions);
  });

  it("refuses unknown ids and excluded targets, with reasons", () => {
    const loaded = parseOverrides(
      `${HEADER}9999.1000,prj_a,matched,\n1556.1002,prj_zzz,matched,\n1556.1003,prj_path,matched,\n`,
    );
    const result = applyOverrides(report, loaded, { acme: register, pulley: pool });
    expect(result.applied).toBe(0);
    expect(result.problems).toHaveLength(3);
    expect(result.problems[0]).toMatch(/not in the Project Register/);
    expect(result.problems[1]).toMatch(/not a Pulley project/);
    expect(result.problems[2]).toMatch(/pathfinder/);
    expect(result.report.decisions).toEqual(report.decisions);
  });
});
