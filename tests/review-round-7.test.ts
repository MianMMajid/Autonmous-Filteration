import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadLocalConfig, PROJECT_ROOT } from "../src/config.ts";
import { matchProjects } from "../src/domain/match/matcher.ts";
import { normalizeStreet } from "../src/domain/normalize/address.ts";
import { parseProjectName } from "../src/domain/normalize/name.ts";
import { assertPublicationInvariants } from "../src/run/invariants.ts";
import { applyOverrides, loadOverrides, parseOverrides } from "../src/run/overrides.ts";
import { acme, inputs, pulley } from "./domain/match/fixtures.ts";
import { pipeline } from "./helpers/pipeline.ts";

const header = "acme_project_id,pulley_project_id,status,note,author,decided_at\n";
const exec = promisify(execFile);
let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "pulley-round7-")));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
function override(n: ReturnType<typeof inputs>, note = "verified scope") {
  const a = n.acme[0],
    p = n.pulley[0];
  if (!a || !p) throw new Error("missing fixture");
  return applyOverrides(
    matchProjects(n),
    parseOverrides(`${header}${a.id},${p.id},matched,${note},Ops,2026-10-08\n`),
    n,
  );
}

describe("store/year/address context", () => {
  it.each([2000, 2020, 2043, 2050, 2100, 1556])(
    "recognizes marked store %i in all supported brand forms",
    (store) => {
      for (const name of [
        `Acme Market - ${store}, Reno, NV`,
        `Acme Warehouse Club – ${store}, Reno, NV`,
        `Acme | ${store}, Reno, NV`,
        `Store ${store} Reno NV`,
      ]) {
        const p = parseProjectName(name);
        expect(p.storeNumbers).toEqual([store]);
        expect(p.years).toEqual([]);
        const n = inputs([acme({ store })], [pulley({ name })]);
        expect(matchProjects(n).counts.matched).toBe(1);
      }
    },
  );
  it.each([
    "2050 Main St",
    "1556 Main Street",
    "2020 North Main Avenue",
    "2099 1st Avenue",
    "2050 Highway 7",
    "2077 State Route 43",
  ])("does not treat embedded address %s as a year or store", (street) => {
    const name = `1556.1002 – ${street}`;
    const p = parseProjectName(name);
    expect(p.fullIds).toEqual(["1556.1002"]);
    expect(p.storeNumbers).toEqual([1556]);
    expect(p.years).toEqual([]);
    expect(matchProjects(inputs([acme()], [pulley({ name })])).counts.matched).toBe(1);
  });
  it.each([2000, 2043, 2100])("retains genuine program-year %i evidence", (year) => {
    expect(parseProjectName(`Reno Remodel ${year}`).years).toEqual([year]);
    expect(parseProjectName(`Reno Remodel ${year}`).storeNumbers).toEqual([]);
    expect(parseProjectName(`1556.1002 Remodel ${year} - 2050 Main St`).years).toEqual([year]);
  });
});

describe("mixed signage scope versus signage-only permits", () => {
  it.each([
    "Remodel + exterior signs 2027",
    "Remodel with monument signs 2027",
    "Expansion including signage 2027",
  ])("allows explained review of %s", (scope) => {
    for (const side of ["acme", "pulley"]) {
      const name = `1556.1002 ${scope}`;
      const n = inputs(
        [acme(side === "acme" ? { name } : {})],
        [pulley({ name: side === "pulley" ? name : "1556.1002 Reno 2027" })],
      );
      const report = matchProjects(n);
      expect(report.decisions[0]).toMatchObject({
        status: "needs_review",
        reason: "EVIDENCE_CONFLICT",
        reviewResolution: "human_confirmation",
      });
      expect(override(n, "").applied).toBe(0);
      const reviewed = override(n);
      expect(reviewed.applied).toBe(1);
      expect(() =>
        assertPublicationInvariants(reviewed.report.decisions, n.acme, n.pulley),
      ).not.toThrow();
    }
  });
  it.each([
    "[Signage] 1556.1002 Remodel + exterior signs 2027",
    "1556.1002 Remodel + separate signage 2027",
    "1556.1002 Sign Permit 2027",
    "1556.1002 Pylon Sign 2027",
  ])("keeps %s as a hard conflict", (name) => {
    const n = inputs([acme()], [pulley({ name })]);
    expect(override(n).applied).toBe(0);
  });
});

describe("shared former/current numbers", () => {
  it.each(["Reno", "Sparks"])(
    "trusts a unique composite ID over another site's former number (%s)",
    (city) => {
      const a = acme(),
        b = acme({
          store: 2666,
          formerLocationNumber: 1556,
          sequence: 1003,
          city,
          street: "200 Oak Rd",
        });
      const p = pulley({ name: "1556.1002", jurisdictionCity: "County Office" });
      for (const list of [
        [a, b],
        [b, a],
      ]) {
        const n = inputs(list, [p]);
        const r = matchProjects(n);
        expect(r.decisions.find((d) => d.acmeId === a.id)).toMatchObject({
          status: "matched",
          tier: 1,
          pulleyId: p.id,
        });
        expect(r.decisions.find((d) => d.acmeId === b.id)?.status).not.toBe("matched");
        expect(() => assertPublicationInvariants(r.decisions, n.acme, n.pulley)).not.toThrow();
      }
    },
  );
  it("allows unique city evidence for a shared store-only number", () => {
    const a = acme(),
      b = acme({
        store: 2666,
        formerLocationNumber: 1556,
        sequence: 1003,
        city: "Sparks",
        street: "200 Oak Rd",
      });
    const p = pulley({ name: "Store 1556 Reno NV 2027" });
    const n = inputs([a, b], [p]);
    expect(matchProjects(n).decisions[0]?.pulleyId).toBe(p.id);
  });
  it("keeps actual composite-ID collisions blocked even when the city prefers one", () => {
    const n = inputs(
      [
        acme(),
        acme({ store: 2666, formerLocationNumber: 1556, city: "Sparks", street: "200 Oak Rd" }),
      ],
      [pulley({ name: "1556.1002 Reno" })],
    );
    expect(matchProjects(n).counts.matched).toBe(0);
    expect(override(n).applied).toBe(0);
  });
  it("does not waive contradictory exact address evidence for a unique full ID", () => {
    const n = inputs(
      [
        acme(),
        acme({
          store: 2666,
          formerLocationNumber: 1556,
          sequence: 1003,
          city: "Sparks",
          street: "200 Oak Rd",
        }),
      ],
      [pulley({ name: "1556.1002 Reno", street: "200 Oak Rd" })],
    );
    expect(matchProjects(n).counts.matched).toBe(0);
    expect(override(n).applied).toBe(0);
  });
  it("recognizes current-number aliases when the register still uses the old number", () => {
    const a = acme({ store: 1556, formerLocationNumber: 1556 });
    if (!a.site) throw new Error("site missing");
    const updated = { ...a, site: { ...a.site, locationNumber: 2666 } };
    const n = inputs([updated], [pulley({ name: "2666.1002 Reno 2027" })]);
    const r = matchProjects(n);
    expect(r.decisions[0]).toMatchObject({ status: "matched", tier: 1 });
    expect(r.pulleyIdsNotInRegister).toEqual([]);
  });
});

it.each([
  ["2077 CENTER BLVD", "2077 CTR BLVD"],
  ["100 CENTER STREET", "100 CTR STREET"],
  ["BLDG-3, 100 Main St", "100 Main St BLDG 3"],
  ["100 Main St Building-A-3", "100 Main St BLDG A-3"],
])("equates address aliases %s / %s", (a, b) => {
  expect(normalizeStreet(a)).not.toBeNull();
  expect(normalizeStreet(a)).toBe(normalizeStreet(b));
  expect(normalizeStreet("100 Main St BLDG-3")).not.toBe(normalizeStreet("100 Main St BLDG-4"));
});

describe("override input visibility and validation", () => {
  it("surfaces a missing bootstrap file in the result and run summary", async () => {
    const p = pipeline(root);
    const loaded = await loadOverrides(p.config.overridesFile);
    expect(loaded.problems.join()).toContain("missing");
    const result = await p.run();
    expect(result.summary).toContain("no human decisions loaded");
  });
  it("does not publish or fetch when a previously recorded override file disappears", async () => {
    const p = pipeline(root);
    await writeFile(
      p.config.overridesFile,
      `${header}3716.1005,prj_ae5zai,matched,reviewed,Ops,2026-10-08\n`,
    );
    await p.run();
    const pointer = await readFile(join(root, "out/latest.json"));
    const calls = p.calls();
    await rm(p.config.overridesFile);
    await expect(p.run("2026-10-08T11:00:00Z")).rejects.toThrow(/missing after a published run/);
    expect(p.calls()).toBe(calls);
    expect(await readFile(join(root, "out/latest.json"))).toEqual(pointer);
    await writeFile(p.config.overridesFile, header);
    await expect(p.run("2026-10-08T12:00:00Z")).resolves.toBeDefined();
  });
  it.each([
    "",
    "   ",
    "wrong,headers\n",
    "acme_project_id,status\n",
    "acme_project_id,pulley_project_id,status,status\n",
  ])("rejects invalid header without data rows: %s", (text) => {
    expect(() => parseOverrides(text)).toThrow();
  });
  it("accepts a valid header-only file", () =>
    expect(parseOverrides(header).overrides).toEqual([]));
  it.each([
    "2026-10-08T12:30:00+02:00",
    "2026-10-08T12:30:00-07:00",
    "2026-10-08T12:30:00Z",
    "2026-10-08",
  ])("accepts valid ISO decision time %s", (date) => {
    const r = parseOverrides(`${header}1556.1002,prj_a,matched,reviewed,Ops,${date}\n`);
    expect(r.problems).toEqual([]);
    expect(r.overrides[0]?.decidedAt).toBe(date);
  });
  it.each(["2026-02-30T12:30:00+02:00", "2026-10-08T12:30:00", "2026-10-08T12:30:00+99:00"])(
    "rejects invalid or zoneless timestamp %s",
    (date) => {
      expect(
        parseOverrides(`${header}1556.1002,prj_a,matched,reviewed,Ops,${date}\n`).overrides,
      ).toHaveLength(0);
    },
  );
});

it("uses stable default paths and consistent explicit relative paths from another working directory", async () => {
  const expected = loadLocalConfig({});
  expect(expected.dataDir).toBe(resolve(PROJECT_ROOT, "data"));
  expect(expected.overridesFile).toBe(resolve(PROJECT_ROOT, "overrides.csv"));
  const env = {
    PATH: process.env["PATH"],
    DATA_DIR: "relative-data",
    OVERRIDES_FILE: "relative-overrides.csv",
  };
  const cli = resolve(PROJECT_ROOT, "src/cli.ts"),
    preflight = resolve(PROJECT_ROOT, "src/preflight.ts");
  const check = await exec(process.execPath, [preflight, "--skip-env"], { cwd: root, env });
  expect(check.stdout).toContain(join(root, "relative-data"));
  const configModule = new URL("../src/config.ts", import.meta.url).href;
  const loaded = await exec(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {loadLocalConfig} from ${JSON.stringify(configModule)};console.log(JSON.stringify(loadLocalConfig()))`,
    ],
    { cwd: root, env },
  );
  expect(JSON.parse(loaded.stdout)).toMatchObject({
    dataDir: join(root, "relative-data"),
    overridesFile: join(root, "relative-overrides.csv"),
  });
  await expect(
    exec(process.execPath, [cli, "status", "--json"], { cwd: root, env }),
  ).rejects.toMatchObject({ code: 9, stderr: expect.stringContaining("No published result yet") });
  const defaults = await exec(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {loadLocalConfig} from ${JSON.stringify(configModule)};console.log(JSON.stringify(loadLocalConfig()))`,
    ],
    { cwd: root, env: { PATH: process.env["PATH"] } },
  );
  expect(JSON.parse(defaults.stdout)).toMatchObject({
    dataDir: expected.dataDir,
    overridesFile: expected.overridesFile,
  });
});

it("preflight reports invalid local configuration with the normal configuration exit", async () => {
  await expect(
    exec(process.execPath, [resolve(PROJECT_ROOT, "src/preflight.ts"), "--skip-env"], {
      cwd: root,
      env: { PATH: process.env["PATH"], DATA_DIR: "" },
    }),
  ).rejects.toMatchObject({
    code: 2,
    stdout: expect.stringContaining("FAIL"),
    stderr: expect.not.stringContaining("at loadLocalConfig"),
  });
});
