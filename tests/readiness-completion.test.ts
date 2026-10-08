import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { matchProjects } from "../src/domain/match/matcher.ts";
import { Banner } from "../src/domain/model.ts";
import { parseProjectName } from "../src/domain/normalize/name.ts";
import { SchemaError } from "../src/errors.ts";
import { recommendedAction } from "../src/output/csv.ts";
import { assertPublicationInvariants } from "../src/run/invariants.ts";
import { writeOutputs } from "../src/run/outputs.ts";
import { applyOverrides, parseOverrides } from "../src/run/overrides.ts";
import { acme, inputs, pulley } from "./domain/match/fixtures.ts";
import { pipeline } from "./helpers/pipeline.ts";

const header = "acme_project_id,pulley_project_id,status,note,author,decided_at\n";
const ev = () =>
  acme({ sequence: 1003, projectType: "EV Charging", name: "1556.1003-RENO-NV-SUP-EV-2027" });
function confirmed(n: ReturnType<typeof inputs>, id: string, target: string) {
  return applyOverrides(
    matchProjects(n),
    parseOverrides(`${header}${id},${target},matched,checked permit scope,Permit Ops,2026-10-08\n`),
    n,
  );
}

describe("EV umbrella scope from the brief", () => {
  it.each(["Remodel", "Expansion", "New Build"])(
    "folds EV into a %s with a known store/year owner",
    (projectType) => {
      const target = pulley({ name: "1556.1002 Reno 2027", projectType });
      const n = inputs([acme(), ev()], [target]);
      const report = matchProjects(n);
      expect(report.decisions.find((d) => d.acmeId === "1556.1003")).toMatchObject({
        status: "matched",
        pulleyId: target.id,
      });
      expect(() => assertPublicationInvariants(report.decisions, n.acme, n.pulley)).not.toThrow();
    },
  );
  it("keeps a dedicated EV permit rather than folding it into another line's umbrella", () => {
    const umbrella = pulley({ name: "1556.1002 Reno 2027" });
    const dedicated = pulley({ name: "1556.1003 Reno 2027", projectType: "EV Charging" });
    for (const pool of [
      [umbrella, dedicated],
      [dedicated, umbrella],
    ]) {
      const n = inputs([acme(), ev()], pool);
      expect(matchProjects(n).decisions.find((d) => d.acmeId === "1556.1003")?.pulleyId).toBe(
        dedicated.id,
      );
    }
  });
  it("does not let an umbrella's stronger date score silently defeat a dedicated EV candidate", () => {
    const a = acme({ projectType: "EV Charging", dates: { constructionStart: "2027-06-01" } });
    const umbrella = pulley({ name: "Store 1556 Remodel 2027", constructionStart: "2027-06-01" });
    const dedicated = pulley({ name: "Store 1556 EV 2027", projectType: "EV Charging" });
    const n = inputs([a], [umbrella, dedicated]);
    const report = matchProjects(n);
    expect(report.decisions[0]?.status).toBe("needs_review");
    expect(confirmed(n, a.id, umbrella.id).applied).toBe(1);
  });
  it("needs evidence for a yearless EV fold, but accepts an explained human decision", () => {
    const target = pulley({ name: "Store 1556 Remodel" });
    const n = inputs([ev()], [target]);
    expect(matchProjects(n).decisions[0]?.reason).toBe("INSUFFICIENT_EVIDENCE");
    const result = confirmed(n, "1556.1003", target.id);
    expect(result.applied).toBe(1);
    expect(() =>
      assertPublicationInvariants(result.report.decisions, n.acme, n.pulley),
    ).not.toThrow();
  });
  it.each([
    { name: "1556.1002 Reno 2028" },
    { name: "2666.1002 Reno 2027" },
    { projectType: "Signage" },
    { accountPlan: "pathfinder" },
    { status: "Canceled" },
    { banner: Banner.WarehouseClub },
    { state: "CA" },
  ])("blocks an EV fold across a hard constraint: %j", (change) => {
    const target = pulley({ name: "1556.1002 Reno 2027", ...change });
    const n = inputs([ev()], [target]);
    expect(matchProjects(n).counts.matched).toBe(0);
    expect(confirmed(n, "1556.1003", target.id).applied).toBe(0);
  });
});

describe("symmetric source contradictions", () => {
  it.each([
    "1556.1002-RENO-CA-SUP-RM-2027",
    "1556.1002-RENO-NV-WHC-RM-2027",
    "[Canceled] 1556.1002-RENO-NV-SUP-RM-2027",
    "1556.1002-RENO-NV-SUP-RM-2027 Signage",
    "1556.1002-RENO-NV-SUP-RM-2027 / Store 2666",
  ])("holds %s even without candidates and at the override/publication boundary", (name) => {
    const a = acme({ name }),
      target = pulley({ name: "1556.1002 Reno 2027" });
    const n = inputs([a], [target]);
    const report = matchProjects(n),
      d = report.decisions[0];
    if (!d) throw new Error("missing decision");
    expect(d.reason).toBe("IDENTITY_DISPUTED");
    expect(matchProjects(inputs([a], [])).decisions[0]?.reason).toBe("IDENTITY_DISPUTED");
    expect(confirmed(n, a.id, target.id).applied).toBe(0);
    for (const reason of ["EXACT_ID", "OVERRIDE"] as const)
      expect(() =>
        assertPublicationInvariants(
          [{ ...d, status: "matched", pulleyId: target.id, reason }],
          n.acme,
          n.pulley,
        ),
      ).toThrow();
  });
  it("allows cancellation on both sides, including closed Acme status", () => {
    const n = inputs(
      [acme({ name: "[Canceled] 1556.1002-RENO-NV-SUP-RM-2027", status: "Closed" })],
      [pulley({ name: "1556.1002 Reno 2027", status: "Canceled" })],
    );
    expect(matchProjects(n).counts.matched).toBe(1);
  });
  it.each(["Sign Permit", "Signs Package", "Monument Sign", "Pylon Signs", "[Sign]", "[Signs]"])(
    "recognizes explicit signage phrase %s",
    (phrase) => {
      const name = phrase.startsWith("[")
        ? `${phrase} 1556.1002 Reno 2027`
        : `1556.1002 Reno 2027 ${phrase}`;
      const n = inputs([acme()], [pulley({ name })]);
      expect(matchProjects(n).counts.matched).toBe(0);
      expect(parseProjectName(name).signageHint).toBe(true);
    },
  );
  it.each(["Design Review", "Assigned Permit", "Signature Review", "Sign Off", "Sign Road"])(
    "does not confuse %s with signage",
    (phrase) => {
      expect(parseProjectName(`1556.1002 Reno 2027 ${phrase}`).signageHint).toBe(false);
    },
  );
});

describe("review decisions and guidance", () => {
  it("explains the soft override path and continues to prohibit hard conflicts", () => {
    const a = acme({ dates: { constructionStart: "2027-01-01" } });
    const soft = matchProjects(
      inputs([a], [pulley({ name: "1556.1002 Reno 2027", constructionStart: "2027-12-01" })]),
    ).decisions[0];
    const hard = matchProjects(inputs([a], [pulley({ name: "1556.1002 Reno 2028" })])).decisions[0];
    if (!soft || !hard) throw new Error("fixture absent");
    expect(recommendedAction(soft)).toContain("explained decision in overrides.csv");
    expect(recommendedAction(soft)).not.toContain("cannot bypass");
    expect(recommendedAction(hard)).toContain("cannot bypass this hard conflict");
  });
  it.each([
    ["prj_a,matched,first", "prj_b,matched,second"],
    ["prj_a,matched,first", ",no_match,second"],
    ["prj_a,matched,first", "prj_a,matched,different provenance"],
  ])("rejects contradictory duplicate decisions regardless of order: %j", (first, second) => {
    for (const lines of [
      [first, second],
      [second, first],
    ])
      expect(() =>
        parseOverrides(header + lines.map((line) => `1556.1002,${line},Ops,2026-10-08`).join("\n")),
      ).toThrow(/conflicting duplicate/);
  });
  it("collapses identical decisions", () => {
    const row = "1556.1002,prj_a,matched,confirmed,Ops,2026-10-08\n";
    const result = parseOverrides(header + row + row);
    expect(result.overrides).toHaveLength(1);
    expect(result.problems[0]).toContain("identical duplicate");
  });
  it.each(["2026-02-30", "2026-13-01", "2026-10-08T99:00:00Z"])(
    "rejects impossible audit dates: %s",
    (date) => {
      expect(
        parseOverrides(`${header}1556.1002,prj_a,matched,confirmed,Ops,${date}\n`).overrides,
      ).toHaveLength(0);
    },
  );
});

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pulley-completion-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it("preserves an existing partial output instead of deleting and reusing it", async () => {
  const id = "2026-10-08T10-00-00-000Z",
    partial = join(root, "out", `${id}.partial`);
  await mkdir(partial, { recursive: true });
  await writeFile(join(partial, "evidence.txt"), "interrupted run evidence");
  await expect(writeOutputs(root, id, { "mapping.csv": "new" })).rejects.toThrow();
  expect(await readFile(join(partial, "evidence.txt"), "utf8")).toBe("interrupted run evidence");
});

it("preserves the publication when human decisions conflict", async () => {
  const p = pipeline(root),
    first = await p.run();
  const before = await readFile(join(root, "out/latest.json"));
  await writeFile(
    p.config.overridesFile,
    `${header}1556.1002,prj_a,matched,first,Ops,2026-10-08\n1556.1002,prj_b,matched,second,Ops,2026-10-08\n`,
  );
  await expect(p.run("2026-10-08T11:00:00Z")).rejects.toBeInstanceOf(SchemaError);
  expect(await readFile(join(root, "out/latest.json"))).toEqual(before);
  const handoff = await readFile(join(first.outputDirectory, "handoff.md"), "utf8");
  expect(handoff).toContain(`${first.report.counts.matched} matched`);
  expect(handoff).toContain(first.runId);
  const manifest = JSON.parse(
    await readFile(join(first.outputDirectory, "output-manifest.json"), "utf8"),
  );
  expect(manifest.files.some((file: { name: string }) => file.name === "handoff.md")).toBe(true);
});

it("retains a reviewed decision on repeat runs and revalidates it after upstream cancellation", async () => {
  const p = pipeline(root);
  const first = await p.run();
  const decision = (report: typeof first.report) =>
    report.decisions.find((row) => row.acmeId === "3716.1005");
  expect(decision(first.report)?.status).toBe("needs_review");
  await writeFile(
    p.config.overridesFile,
    `${header}3716.1005,prj_ae5zai,matched,synthetic reviewer verified permit scope,Test Ops,2026-10-08\n`,
  );
  const reviewed = await p.run("2026-10-08T11:00:00Z");
  expect(decision(reviewed.report)).toMatchObject({
    status: "matched",
    pulleyId: "prj_ae5zai",
    reason: "OVERRIDE",
  });
  const repeated = await p.run("2026-10-08T12:00:00Z");
  expect(await readFile(join(repeated.outputDirectory, "mapping.csv"))).toEqual(
    await readFile(join(reviewed.outputDirectory, "mapping.csv")),
  );
  expect(
    (await readFile(join(repeated.outputDirectory, "review-changes.csv"), "utf8"))
      .trim()
      .split("\n"),
  ).toHaveLength(1);
  p.changeProject("prj_ae5zai", { status: "Canceled" });
  const changed = await p.run("2026-10-08T13:00:00Z");
  expect(decision(changed.report)?.pulleyId).not.toBe("prj_ae5zai");
  expect(decision(changed.report)?.reason).not.toBe("OVERRIDE");
  const record = await readFile(join(changed.outputDirectory, "run.json"), "utf8");
  expect(record).toContain("needs reconfirmation");
  expect(await readFile(join(reviewed.outputDirectory, "mapping.csv"))).toEqual(
    await readFile(join(repeated.outputDirectory, "mapping.csv")),
  );
});
