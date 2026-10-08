import { describe, expect, it } from "vitest";
import { matchProjects } from "../src/domain/match/matcher.ts";
import { Banner, type NormalizedInputs } from "../src/domain/model.ts";
import { normalizeStreet } from "../src/domain/normalize/address.ts";
import { parseProjectName } from "../src/domain/normalize/name.ts";
import { assertPublicationInvariants } from "../src/run/invariants.ts";
import { applyOverrides, parseOverrides } from "../src/run/overrides.ts";
import { acme, inputs, pulley } from "./domain/match/fixtures.ts";

const counterexamples: Array<{
  name: string;
  humanResolvable?: boolean;
  build: () => NormalizedInputs;
}> = [
  {
    name: "a street named North collapsed into a street named N",
    humanResolvable: true,
    build: () =>
      inputs(
        [acme({ street: "100 North Street" })],
        [pulley({ name: "Reno Remodel 2027", street: "100 N Street" })],
      ),
  },
  {
    name: "an extra named store absent from the register",
    build: () => inputs([acme()], [pulley({ name: "Store 1556 / Store 2666 Remodel 2027" })]),
  },
  {
    name: "a signage marker in a bracket prefix",
    build: () => inputs([acme()], [pulley({ name: "[Signage] 1556.1002 Reno NV 2027" })]),
  },
  {
    name: "a contradictory year in a bracket prefix",
    build: () => inputs([acme()], [pulley({ name: "[2025] 1556.1002 Reno NV 2027" })]),
  },
  {
    name: "different buildings at the same base address",
    humanResolvable: true,
    build: () =>
      inputs(
        [acme({ street: "100 Main St Building A" })],
        [pulley({ name: "Reno Remodel 2027", street: "100 Main St Building B" })],
      ),
  },
  {
    name: "a future year misread as a store number",
    build: () =>
      inputs(
        [acme({ store: 2040 })],
        [pulley({ name: "Reno Remodel 2040", constructionStart: "2027-06-01" })],
      ),
  },
  {
    name: "a contradictory Acme canonical year",
    build: () =>
      inputs(
        [acme({ name: "1556.1002-RENO-NV-SUP-RM-2025" })],
        [pulley({ name: "1556.1002 Reno NV 2027" })],
      ),
  },
];

describe("new synthetic counterexamples", () => {
  it.each(counterexamples)(
    "withholds automatic acceptance for $name",
    ({ build, humanResolvable }) => {
      const n = build();
      const report = matchProjects(n);
      expect(report.counts.matched).toBe(0);
      expect(() => assertPublicationInvariants(report.decisions, n.acme, n.pulley)).not.toThrow();
      const decision = report.decisions[0],
        target = n.pulley[0];
      if (!decision || !target) throw new Error("missing fixture");
      for (const reason of ["EXACT_ID", "OVERRIDE"] as const) {
        const check = () =>
          assertPublicationInvariants(
            [{ ...decision, status: "matched", pulleyId: target.id, reason }],
            n.acme,
            n.pulley,
          );
        if (humanResolvable && reason === "OVERRIDE") expect(check).not.toThrow();
        else expect(check).toThrow();
      }
      const override = parseOverrides(
        `acme_project_id,pulley_project_id,status,note\n${decision.acmeId},${target.id},matched,previously confirmed\n`,
      );
      expect(applyOverrides(report, override, n).applied).toBe(humanResolvable ? 1 : 0);
    },
  );

  it("retains Acme source disputes when no Pulley candidate exists", () => {
    const n = inputs([acme({ name: "2666.1002-RENO-NV-SUP-RM-2027" })], []);
    expect(matchProjects(n).decisions[0]).toMatchObject({
      status: "needs_review",
      reason: "IDENTITY_DISPUTED",
    });
  });

  it.each([2000, 2020, 2023, 2024, 2035, 2036, 2040, 2100])(
    "distinguishes an explicit store from a bare year %i",
    (year) => {
      expect(parseProjectName(`Remodel ${year}`)).toMatchObject({
        storeNumbers: [],
        years: [year],
      });
      expect(parseProjectName(`Store ${year} Remodel`)).toMatchObject({
        storeNumbers: [year],
        years: [],
      });
    },
  );

  it("preserves building identity in both prefix and suffix forms", () => {
    const a = normalizeStreet("Building A, 100 Main Street, Suite 12");
    expect(a).toBe(normalizeStreet("100 Main St Bldg. #A"));
    expect(a).not.toBe(normalizeStreet("Building B, 100 Main Street, Suite 12"));
    expect(a).not.toBe(normalizeStreet("100 Main St"));
  });

  it("allows a verified current/former store pair rather than treating it as two buildings", () => {
    const n = inputs(
      [acme({ formerLocationNumber: 2666 })],
      [pulley({ name: "Store 1556 / former Store 2666 Remodel 2027" })],
    );
    expect(matchProjects(n).counts.matched).toBe(1);
  });
});

// A reproducible independent oracle: valid inputs have one exact-ID owner;
// every mutation deliberately introduces an exclusion or contradictory fact.
// Expected outcomes do not call the implementation's compatibility predicates.
describe("seeded synthetic mutation matrix", () => {
  it("rejects 1,152 contradictory cases while preserving 96 valid controls in both input orders", () => {
    let seed = 0x50_55_4c_4c;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    const years = [2000, 2023, 2027, 2036, 2040, 2100];
    for (let index = 0; index < 96; index++) {
      const store = 3000 + (random() % 5000);
      const sequence = 1000 + (random() % 100);
      const year = years[random() % years.length] ?? 2027;
      const otherYear = year === 2100 ? 2099 : year + 1;
      const banner = (random() >>> 16) % 2 ? Banner.Market : Banner.WarehouseClub;
      const state = (random() >>> 16) % 2 ? "NV" : "CA";
      const id = `${store}.${sequence}`;
      const name = `${id} Reno ${state} ${year}`;
      const a = acme({ store, sequence, programYear: year, banner, state });
      const p = pulley({ id: "prj_owner", name, banner, state, street: "100 Main St" });
      const distractor = acme({
        store: 9001,
        sequence: 1000,
        programYear: year,
        street: "900 Oak Rd",
        city: "Sparks",
        state,
        banner,
      });
      const otherPermit = pulley({
        id: "prj_other",
        name: `9001.1000 Sparks ${state} ${year}`,
        street: "900 Oak Rd",
        jurisdictionCity: "Sparks",
        state,
        banner,
      });
      const differentBanner = banner === Banner.Market ? Banner.WarehouseClub : Banner.Market;
      const mutations = [
        { ...p, state: state === "NV" ? "CA" : "NV" },
        {
          ...p,
          banner: differentBanner,
          organization: differentBanner,
        },
        { ...p, accountPlan: "pathfinder", isPathfinder: true },
        { ...p, projectType: "Signage", isSignage: true },
        { ...p, status: "Canceled" },
        { ...p, status: "Unrecognized lifecycle" },
        { ...p, name: `[Signage] ${name}`, parsedName: parseProjectName(`[Signage] ${name}`) },
        {
          ...p,
          name: `[${otherYear}] ${name}`,
          parsedName: parseProjectName(`[${otherYear}] ${name}`),
        },
        {
          ...p,
          name: `${name} / Store 9999`,
          parsedName: parseProjectName(`${name} / Store 9999`),
        },
        {
          ...p,
          name: `${id} Reno ${otherYear}`,
          parsedName: parseProjectName(`${id} Reno ${otherYear}`),
        },
        { ...p, name: `[Canceled] ${name}`, parsedName: parseProjectName(`[Canceled] ${name}`) },
        { ...p, projectType: "EV Charging" },
      ];
      checkMutationFamily(index, a, p, distractor, otherPermit, mutations);
    }
  });
});

function checkMutationFamily(
  index: number,
  a: ReturnType<typeof acme>,
  p: ReturnType<typeof pulley>,
  distractor: ReturnType<typeof acme>,
  otherPermit: ReturnType<typeof pulley>,
  mutations: ReturnType<typeof pulley>[],
): void {
  for (const reverse of [false, true]) {
    const register = reverse ? [distractor, a] : [a, distractor];
    const valid = inputs(register, reverse ? [otherPermit, p] : [p, otherPermit]);
    expect(
      matchProjects(valid).decisions.find((d) => d.acmeId === a.id)?.pulleyId,
      `control ${index}`,
    ).toBe(p.id);
    for (const [mutation, bad] of mutations.entries()) {
      const n = inputs(register, reverse ? [otherPermit, bad] : [bad, otherPermit]);
      const report = matchProjects(n);
      expect(
        report.decisions.find((d) => d.acmeId === a.id)?.status,
        `seed case ${index}, mutation ${mutation}, reverse ${reverse}`,
      ).not.toBe("matched");
      expect(report.decisions.find((d) => d.acmeId === distractor.id)?.pulleyId).toBe(
        otherPermit.id,
      );
      expect(() => assertPublicationInvariants(report.decisions, n.acme, n.pulley)).not.toThrow();
    }
  }
}
