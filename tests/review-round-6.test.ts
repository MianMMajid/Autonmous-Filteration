import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { matchProjects } from "../src/domain/match/matcher.ts";
import { Banner } from "../src/domain/model.ts";
import { normalizeStreet } from "../src/domain/normalize/address.ts";
import { assertPublicationInvariants } from "../src/run/invariants.ts";
import { acme, inputs, pulley } from "./domain/match/fixtures.ts";
import { pipeline } from "./helpers/pipeline.ts";

describe("address spelling recovery without erasing identity", () => {
  it.each([
    ["4400 TOWN CTR BLVD", "4400 TOWN CENTER BLVD"],
    ["4400 TOWN CTR BLVD", "4400 TOWN CENTRE BOULEVARD"],
    ["12345 HIGHWAY 7", "12345 HWY 7"],
    ["12345 STATE HIGHWAY 7", "12345 STATE HWY 7"],
    ["12345 ROUTE 7", "12345 RTE 7"],
    ["100 NORTH MAIN", "100 N MAIN"],
    ["100 MAIN SOUTHWEST", "100 MAIN SW"],
    ["100 NORTH EAST MAIN", "100 NE MAIN"],
    ["ACME BUILDING 3, 100 MAIN ST", "100 MAIN STREET"],
    ["BUILDING 3, 100 MAIN ST", "100 MAIN STREET BLDG 3"],
    ["ACME BUILDING 3, BLDG 4, 100 MAIN ST", "100 MAIN STREET BLDG 4"],
    ["ACME BUILDING 3, 100 MAIN ST, BUILDING 4", "100 MAIN STREET BLDG 4"],
  ])("equates %s and %s", (a, b) => {
    const key = normalizeStreet(a);
    expect(key).not.toBeNull();
    expect(key).toBe(normalizeStreet(b));
    expect(normalizeStreet(key)).toBe(key);
    const n = inputs([acme({ street: a })], [pulley({ name: "1556.1002 Reno 2027", street: b })]);
    expect(matchProjects(n).counts.matched).toBe(1);
  });
  it.each([
    ["100 NORTH STREET", "100 N STREET"],
    ["100 CENTER STREET", "100 CTR STREET"],
    ["100 HIGHWAY DRIVE", "100 HWY DRIVE"],
    ["100 NORTH MAIN", "100 SOUTH MAIN"],
    ["100 MAIN SOUTHWEST", "100 MAIN SOUTHEAST"],
    ["12345 HIGHWAY 7", "12345 HIGHWAY 8"],
    ["BUILDING 3, 100 MAIN ST", "BUILDING 4, 100 MAIN ST"],
    ["BUILDING 3, 100 MAIN ST", "100 MAIN ST"],
  ])("keeps %s distinct from %s", (a, b) => {
    expect(normalizeStreet(a)).not.toBe(normalizeStreet(b));
  });
});

describe("singleton-compatible ownership", () => {
  it("does not remove a possible sibling owner merely because its status is unknown", () => {
    const n = inputs(
      [acme(), acme({ sequence: 1003, programYear: 2028, status: "Unrecognized" })],
      [pulley({ name: "Store 1556 Remodel" })],
    );
    expect(matchProjects(n).decisions[0]?.reason).toBe("INSUFFICIENT_EVIDENCE");
  });
  it.each(["Coffee Tenant", "EV Charging"])(
    "ignores a Remodel sibling for a dedicated %s permit",
    (type) => {
      const own = acme({ projectType: type });
      const sibling = acme({ sequence: 1003, programYear: 2028 });
      const target = pulley({ name: "Store 1556", projectType: type });
      for (const register of [
        [own, sibling],
        [sibling, own],
      ]) {
        const n = inputs(register, [target]);
        const result = matchProjects(n);
        expect(result.decisions.find((d) => d.acmeId === own.id)).toMatchObject({
          status: "matched",
          pulleyId: target.id,
        });
        expect(() => assertPublicationInvariants(result.decisions, n.acme, n.pulley)).not.toThrow();
      }
    },
  );
  it("still counts an EV sibling that can share a Remodel umbrella", () => {
    const n = inputs(
      [acme(), acme({ sequence: 1003, projectType: "EV Charging", programYear: 2028 })],
      [pulley({ name: "Store 1556 Remodel" })],
    );
    expect(matchProjects(n).decisions[0]?.reason).toBe("INSUFFICIENT_EVIDENCE");
  });
  it.each([2027, 2028])("still counts a compatible sibling in year %i", (year) => {
    const n = inputs(
      [acme(), acme({ sequence: 1003, programYear: year })],
      [pulley({ name: "Store 1556 Remodel" })],
    );
    expect(matchProjects(n).counts.matched).toBe(0);
  });
});

describe("canonical codes and former full IDs", () => {
  it.each([Banner.Market, Banner.WarehouseClub])(
    "does not invent a banner contradiction from unknown WHS (%s)",
    (banner) => {
      const n = inputs(
        [acme({ banner, name: "1556.1002-RENO-NV-WHS-RM-2027" })],
        [pulley({ banner, name: "1556.1002-RENO-NV-WHS-RM-2027" })],
      );
      const result = matchProjects(n);
      expect(result.counts.matched).toBe(1);
      expect(() => assertPublicationInvariants(result.decisions, n.acme, n.pulley)).not.toThrow();
    },
  );
  it("still rejects a known contradictory banner", () => {
    const n = inputs(
      [acme({ name: "1556.1002-RENO-NV-WHC-RM-2027" })],
      [pulley({ name: "1556.1002 Reno" })],
    );
    expect(matchProjects(n).decisions[0]?.reason).toBe("IDENTITY_DISPUTED");
  });
  it("promotes a verified former full ID to exact evidence and preserves its program-year owner", () => {
    const own = acme({ formerLocationNumber: 4980 });
    const sibling = acme({ sequence: 1003, programYear: 2028, formerLocationNumber: 4980 });
    const target = pulley({ name: "4980.1002 Reno" });
    for (const register of [
      [own, sibling],
      [sibling, own],
    ]) {
      const n = inputs(register, [target]);
      const result = matchProjects(n);
      const decision = result.decisions.find((d) => d.acmeId === own.id);
      expect(decision).toMatchObject({ status: "matched", tier: 1, pulleyId: target.id });
      expect(decision?.candidates[0]?.evidence.exactId).toBe(true);
      expect(result.decisions.find((d) => d.acmeId === sibling.id)?.status).not.toBe("matched");
      expect(() => assertPublicationInvariants(result.decisions, n.acme, n.pulley)).not.toThrow();
    }
  });
  it("does not promote an unverified old number or reused sequence", () => {
    const n = inputs([acme()], [pulley({ name: "4980.1002 Reno" })]);
    expect(matchProjects(n).counts.matched).toBe(0);
  });
  it("does not let a former full ID bypass a current-number collision", () => {
    const own = acme({ formerLocationNumber: 4980 });
    const other = acme({ store: 4980, city: "Sparks", street: "200 Other St" });
    const n = inputs([own, other], [pulley({ name: "4980.1002 Reno" })]);
    expect(matchProjects(n).decisions.find((d) => d.acmeId === own.id)?.status).not.toBe("matched");
  });
});

it("reports the configured override path and all published artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "pulley-summary-review-"));
  try {
    const p = pipeline(root);
    await writeFile(
      p.config.overridesFile,
      "acme_project_id,pulley_project_id,status,note\n3716.1005,prj_ae5zai,matched,synthetic review\n",
    );
    const result = await p.run();
    expect(result.summary).toContain(`1 applied from ${p.config.overridesFile}`);
    expect(result.summary).not.toContain("applied from data/overrides.csv");
    for (const name of [
      "handoff.md",
      "review-changes.csv",
      "overrides.snapshot.csv",
      "output-manifest.json",
    ]) {
      expect(result.summary).toContain(name);
      expect((await readFile(join(result.outputDirectory, name))).length).toBeGreaterThan(0);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
