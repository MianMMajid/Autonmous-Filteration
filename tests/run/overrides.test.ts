import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { matchProjects } from "../../src/domain/match/matcher.ts";
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
1556.1002,prj_c,matched,duplicate
`;
    const { overrides, problems } = parseOverrides(text, "test.csv");
    expect(overrides).toEqual([
      { acmeId: "1556.1002", pulleyId: "prj_a", status: "matched", note: "confirmed" },
      { acmeId: "1556.1003", pulleyId: null, status: "no_match", note: "never opened" },
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

  it("accepts an empty file", () => {
    expect(parseOverrides("")).toEqual({ overrides: [], problems: [] });
    expect(parseOverrides(HEADER)).toEqual({ overrides: [], problems: [] });
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
    expect(await loadOverrides(dataDir)).toEqual({ overrides: [], problems: [] });
  });

  it("reads the file when present", async () => {
    await writeFile(join(dataDir, "overrides.csv"), `${HEADER}1556.1002,prj_a,matched,ok\n`);
    expect((await loadOverrides(dataDir)).overrides).toHaveLength(1);
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
    const result = applyOverrides(report, loaded, pool);
    expect(result.applied).toBe(2);
    expect(result.problems).toEqual([]);
    expect(result.report.decisions.map((d) => [d.status, d.pulleyId, d.reason])).toEqual([
      ["matched", "prj_a", "OVERRIDE"],
      ["no_match", null, "OVERRIDE"],
    ]);
    expect(result.report.decisions[0]?.note).toBe("override: confirmed by lead");
    expect(result.report.decisions[0]?.candidates.length).toBeGreaterThan(0);
    expect(result.report.counts).toEqual({ matched: 1, needs_review: 0, no_match: 1 });
    expect(result.report.unmatchedPulley.map((p) => p.id)).toEqual(["prj_b"]);
  });

  it("refuses unknown ids and excluded targets, with reasons", () => {
    const loaded = parseOverrides(
      `${HEADER}9999.1000,prj_a,matched,\n1556.1002,prj_zzz,matched,\n1556.1003,prj_path,matched,\n`,
    );
    const result = applyOverrides(report, loaded, pool);
    expect(result.applied).toBe(0);
    expect(result.problems).toHaveLength(3);
    expect(result.problems[0]).toMatch(/not in the Project Register/);
    expect(result.problems[1]).toMatch(/not a Pulley project/);
    expect(result.problems[2]).toMatch(/pathfinder/);
    expect(result.report.decisions).toEqual(report.decisions);
  });
});
