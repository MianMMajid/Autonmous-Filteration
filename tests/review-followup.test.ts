import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { matchProjects } from "../src/domain/match/matcher.ts";
import { createSafetyIndex } from "../src/domain/match/safety-index.ts";
import { evaluateRun } from "../src/run/evaluate.ts";
import { outputManifest } from "../src/run/integrity.ts";
import { assertPublicationInvariants } from "../src/run/invariants.ts";
import { latestRunId } from "../src/run/outputs.ts";
import { applyOverrides, parseOverrides } from "../src/run/overrides.ts";
import { readPublishedStatus } from "../src/run/status.ts";
import { acme, inputs, pulley } from "./domain/match/fixtures.ts";
import { pipeline } from "./helpers/pipeline.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pulley-followup-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function confirmed(
  n: ReturnType<typeof inputs>,
  note = "Permit Ops verified the source discrepancy",
) {
  const a = n.acme[0],
    p = n.pulley[0];
  if (!a || !p) throw new Error("fixture absent");
  return applyOverrides(
    matchProjects(n),
    parseOverrides(
      `acme_project_id,pulley_project_id,status,note,author,decided_at\n${a.id},${p.id},matched,${note},Permit Ops,2026-10-08\n`,
    ),
    n,
  );
}

describe("narrow temporal acceptance", () => {
  it("accepts a unique yearless store candidate despite jurisdiction differences", () => {
    const n = inputs(
      [acme()],
      [pulley({ name: "Store 1556 Remodel", jurisdictionCity: "Sparks" })],
    );
    expect(matchProjects(n).counts.matched).toBe(1);
    expect(() =>
      assertPublicationInvariants(matchProjects(n).decisions, n.acme, n.pulley),
    ).not.toThrow();
  });
  it.each([2027, 2028])("withholds multiple Acme lines even when the other year is %i", (year) => {
    const n = inputs(
      [acme(), acme({ sequence: 1003, programYear: year })],
      [pulley({ name: "Store 1556 Remodel" })],
    );
    expect(matchProjects(n).counts.matched).toBe(0);
    expect(matchProjects(n).decisions.every((d) => d.reason === "INSUFFICIENT_EVIDENCE")).toBe(
      true,
    );
  });
  it("requires temporal evidence with a second compatible candidate even if scoring prefers one", () => {
    const n = inputs(
      [acme()],
      [
        pulley({ name: "Store 1556 Remodel", street: "100 Main St" }),
        pulley({ name: "Store 1556 Remodel" }),
      ],
    );
    expect(matchProjects(n).decisions[0]?.reason).toBe("INSUFFICIENT_EVIDENCE");
    const decision = matchProjects(n).decisions[0];
    const target = n.pulley[0];
    if (!decision || !target) throw new Error("fixture absent");
    expect(() =>
      assertPublicationInvariants(
        [{ ...decision, status: "matched", pulleyId: target.id }],
        n.acme,
        n.pulley,
      ),
    ).toThrow();
  });
  it("also counts an address-only competitor against the unique-candidate exception", () => {
    const n = inputs(
      [acme()],
      [pulley({ name: "Store 1556 Remodel" }), pulley({ street: "100 Main St" })],
    );
    expect(matchProjects(n).decisions[0]?.reason).toBe("INSUFFICIENT_EVIDENCE");
  });
  it("does not count excluded, wrong-scope, incompatible or ended competitors as compatible", () => {
    const n = inputs(
      [acme()],
      [
        pulley({ name: "Store 1556 Remodel" }),
        pulley({ name: "Store 1556 Remodel", accountPlan: "pathfinder" }),
        pulley({ name: "Store 1556", projectType: "Signage" }),
        pulley({ name: "Store 1556", state: "CA" }),
        pulley({ name: "Store 1556", projectType: "EV Charging" }),
        pulley({ name: "Store 1556", status: "Canceled" }),
      ],
    );
    expect(matchProjects(n).counts.matched).toBe(1);
  });
});

describe("human resolution of soft discrepancies", () => {
  it.each([
    { street: "100 Mian St" },
    { constructionStart: "2028-06-01" },
    { street: "100 Mian St", constructionStart: "2028-06-01" },
  ])("allows an explained override for %j while automatic matching withholds", (difference) => {
    const n = inputs(
      [acme({ dates: { constructionStart: "2027-06-01" } })],
      [pulley({ name: "1556.1002 Reno", ...difference })],
    );
    expect(matchProjects(n).counts.matched).toBe(0);
    expect(confirmed(n, "").applied).toBe(0);
    const result = confirmed(n);
    expect(result.applied).toBe(1);
    expect(result.report.decisions[0]?.note).toContain("Permit Ops verified");
    expect(() =>
      assertPublicationInvariants(result.report.decisions, n.acme, n.pulley),
    ).not.toThrow();
  });
  it.each([
    { name: "1556.1002 Reno 2028" },
    { name: "2666.1002 Reno" },
    { state: "CA" },
    { status: "Canceled" },
    { projectType: "Signage" },
    { accountPlan: "pathfinder" },
    { projectType: "EV Charging" },
  ])("still blocks hard contradiction %j", (difference) => {
    const n = inputs([acme()], [pulley({ name: "1556.1002 Reno", ...difference })]);
    expect(confirmed(n).applied).toBe(0);
  });
});

it("indexes ownership independently of thousands of unrelated register rows", () => {
  const owner = acme();
  const target = pulley({ name: "1556.1002 Reno 2027" });
  const unrelated = Array.from({ length: 4000 }, (_, i) => acme({ store: 3000 + i }));
  const index = createSafetyIndex([owner, ...unrelated], [target]);
  expect(index.related(owner, target)).toEqual([owner]);
  expect(index.compatibleCandidates(owner)).toEqual([target]);
});

it.each([false, true])(
  "recovers a first-run crash in a fresh location, preserving partial or complete history (%s)",
  async (complete) => {
    const old = join(root, "failed-bootstrap");
    let directory: string;
    if (complete) {
      directory = (await pipeline(old).run()).outputDirectory;
      await rm(join(old, "out/latest.json"));
    } else {
      directory = join(old, "out/2026-10-08T10-00-00-000Z");
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "mapping.csv"), "preserve partial output");
    }
    const before = await readFile(join(directory, "mapping.csv"));
    await expect(latestRunId(old)).rejects.toThrow(/first-run crash recovery/);
    const fresh = join(root, "bootstrap-retry");
    const result = await pipeline(fresh).run();
    expect(await latestRunId(fresh)).toBe(result.runId);
    expect(await readFile(join(directory, "mapping.csv"))).toEqual(before);
  },
);

async function changeRecord(directory: string, change: (record: Record<string, unknown>) => void) {
  const path = join(directory, "run.json");
  const record = JSON.parse(await readFile(path, "utf8"));
  change(record);
  await writeFile(path, JSON.stringify(record));
  const manifest = JSON.parse(await readFile(join(directory, "output-manifest.json"), "utf8"));
  const files: Record<string, string> = {};
  for (const { name } of manifest.files)
    files[name] = await readFile(join(directory, name), "utf8");
  await writeFile(join(directory, "output-manifest.json"), outputManifest(manifest.runId, files));
}

it.each(["publishedAt", "sourceAcquiredAt"])(
  "reports future %s as freshness exit 9 for status and monitor",
  async (field) => {
    const first = await pipeline(root).run();
    await changeRecord(first.outputDirectory, (record) => {
      record[field] = "2099-01-01T00:00:00.000Z";
    });
    await expect(readPublishedStatus(root)).rejects.toMatchObject({ exitCode: 9 });
    const execute = promisify(execFile);
    const cli = new URL("../src/cli.ts", import.meta.url).pathname;
    const schedule = join(root, "schedule.json");
    await writeFile(
      schedule,
      JSON.stringify({
        version: 1,
        utcHours: [13],
        minute: 17,
        weekdays: [1, 2, 3, 4, 5],
        graceMinutes: 60,
      }),
    );
    for (const args of [
      ["status", "--max-age-hours", "24"],
      ["monitor", schedule],
    ])
      await expect(
        execute(process.execPath, [cli, ...args], {
          env: { PATH: process.env["PATH"], DATA_DIR: root, LOG_LEVEL: "error" },
        }),
      ).rejects.toMatchObject({ code: 9 });
  },
);

it("rejects evaluation of an empty population instead of producing NaN coverage", async () => {
  const first = await pipeline(root).run();
  await changeRecord(first.outputDirectory, (record) => {
    record["decisions"] = [];
    record["counts"] = { matched: 0, needs_review: 0, no_match: 0 };
  });
  await expect(evaluateRun(root, first.runId, join(root, "labels.csv"))).rejects.toThrow(
    /empty run/,
  );
});
