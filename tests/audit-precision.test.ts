import { describe, expect, it } from "vitest";
import { matchProjects } from "../src/domain/match/matcher.ts";
import { recommendedAction } from "../src/output/csv.ts";
import { assertPublicationInvariants } from "../src/run/invariants.ts";
import { applyOverrides, parseOverrides } from "../src/run/overrides.ts";
import { acme, inputs, pulley } from "./domain/match/fixtures.ts";

const scenarios = [
  {
    name: "exact ID with a contradictory explicit year",
    build: () => inputs([acme()], [pulley({ name: "1556.1002-RENO-NV-SUP-RM-2025" })]),
  },
  {
    name: "sequence contradicting another building's exact address",
    build: () =>
      inputs(
        [acme(), acme({ store: 2666, sequence: 1003, street: "900 Oak Rd" })],
        [pulley({ name: "Acme .1002 Reno NV 2027", street: "900 Oak Rd" })],
      ),
  },
  {
    name: "dates contradicting another building's exact address",
    build: () =>
      inputs(
        [
          acme({ dates: { constructionStart: "2027-06-01" } }),
          acme({ store: 2666, street: "900 Oak Rd", dates: { constructionStart: "2027-10-01" } }),
        ],
        [
          pulley({
            name: "Acme Reno Remodel 2027",
            street: "900 Oak Rd",
            constructionStart: "2027-06-01",
          }),
        ],
      ),
  },
  {
    name: "street-name bonus resolving a shared store number",
    build: () =>
      inputs(
        [acme(), acme({ store: 2666, formerLocationNumber: 1556, street: "200 Oak Rd" })],
        [pulley({ name: "Store 1556 Remodel 2027", street: "999 Main St" })],
      ),
  },
  {
    name: "one matching milestone hiding two contradictory milestones",
    build: () =>
      inputs(
        [
          acme({
            dates: {
              constructionStart: "2027-06-01",
              permitSubmittedActual: "2027-01-01",
              permitApproved: "2027-03-01",
            },
          }),
        ],
        [
          pulley({
            name: "Acme Reno Remodel",
            constructionStart: "2027-06-01",
            permitSubmitted: "2025-01-01",
            permitApproved: "2025-03-01",
          }),
        ],
      ),
  },
  {
    name: "canceled name with a live structured status",
    build: () => inputs([acme()], [pulley({ name: "[Canceled] 1556.1002-RENO-NV-SUP-RM-2027" })]),
  },
  {
    name: "signage name with a remodel structured type",
    build: () => inputs([acme()], [pulley({ name: "1556.1002-RENO-NV-SUP-RM-2027 – Signage" })]),
  },
  {
    name: "canonical organization contradicting structured organization",
    build: () => inputs([acme()], [pulley({ name: "1556.1002-RENO-NV-WHC-RM-2027" })]),
  },
];

describe("precision safeguards across all acceptance paths", () => {
  it("does not use ranking scores to choose between years without a strong anchor", () => {
    const n = inputs(
      [
        acme({ sequence: 1002, programYear: 2027, dates: { constructionStart: "2027-12-01" } }),
        acme({ sequence: 1003, programYear: 2028, dates: { constructionStart: "2028-01-10" } }),
      ],
      [pulley({ name: "Store 1556 Remodel", constructionStart: "2027-12-15" })],
    );
    for (const register of [n.acme, [...n.acme].reverse()]) {
      const report = matchProjects({ ...n, acme: register });
      expect(report.decisions.every((d) => d.status === "needs_review")).toBe(true);
      const forged = report.decisions.map((d, i) =>
        i === 0 ? { ...d, status: "matched" as const, pulleyId: n.pulley[0]?.id ?? null } : d,
      );
      expect(() => assertPublicationInvariants(forged, register, n.pulley)).toThrow();
    }
  });
  it.each([
    ["2027-06-30", "matched"],
    ["2027-07-01", "needs_review"],
  ])("uses an explicit 180-day review boundary: %s", (date, status) => {
    const n = inputs(
      [acme({ dates: { constructionStart: "2027-01-01" } })],
      [pulley({ name: "1556.1002 Reno NV 2027", constructionStart: date })],
    );
    expect(matchProjects(n).decisions[0]?.status).toBe(status);
  });
  for (const { name, build } of scenarios) {
    it(name, () => {
      const n = build();
      for (const register of [n.acme, [...n.acme].reverse()]) {
        const report = matchProjects({ ...n, acme: register });
        expect(report.counts.matched).toBe(0);
        const disputed = report.decisions.find((d) => d.acmeId === n.acme[0]?.id);
        expect(disputed?.reason).toBe("EVIDENCE_CONFLICT");
        expect(disputed && recommendedAction(disputed)).toMatch(/Verify/);
        expect(() =>
          assertPublicationInvariants(report.decisions, register, n.pulley),
        ).not.toThrow();
        const target = n.pulley[0];
        if (!disputed || !target) throw new Error("missing fixture");
        // Simulate a future code regression bypassing the matcher guard.
        for (const reason of ["EXACT_ID", "OVERRIDE"] as const) {
          const forged = report.decisions.map((d) =>
            d === disputed ? { ...d, status: "matched" as const, pulleyId: target.id, reason } : d,
          );
          expect(() => assertPublicationInvariants(forged, register, n.pulley)).toThrow(
            /Refusing to publish/,
          );
        }
        const loaded = parseOverrides(
          `acme_project_id,pulley_project_id,status,note\n${disputed.acmeId},${target.id},matched,previously confirmed\n`,
        );
        const overridden = applyOverrides(report, loaded, n);
        expect(overridden.applied).toBe(0);
        expect(overridden.report.counts.matched).toBe(0);
        expect(overridden.problems.join(" ")).toMatch(/reconfirmation/);
      }
    });
  }

  it("holds a yearless match, but permits independently confirmed missing evidence", () => {
    const n = inputs([acme()], [pulley({ name: "Store 1556 Remodel", street: "100 Main St" })]);
    const report = matchProjects(n);
    const decision = report.decisions[0];
    expect(decision?.reason).toBe("INSUFFICIENT_EVIDENCE");
    expect(decision && recommendedAction(decision)).toMatch(/independent evidence/);
    const target = n.pulley[0];
    if (!decision || !target) throw new Error("missing fixture");
    expect(() =>
      assertPublicationInvariants(
        [{ ...decision, status: "matched", pulleyId: target.id }],
        n.acme,
        n.pulley,
      ),
    ).toThrow();
    const loaded = parseOverrides(
      `acme_project_id,pulley_project_id,status,note,author,decided_at\n${decision.acmeId},${target.id},matched,verified building and 2027 permit,Permit Ops,2026-10-08\n`,
    );
    const result = applyOverrides(report, loaded, n);
    expect(result.applied).toBe(1);
    expect(() =>
      assertPublicationInvariants(result.report.decisions, n.acme, n.pulley),
    ).not.toThrow();
  });

  it("keeps an explicit owner's conflicting year visible even when its own match is withheld", () => {
    const n = inputs(
      [
        acme({ sequence: 1002, programYear: 2026 }),
        acme({ sequence: 1003, programYear: 2027, dates: { constructionStart: "2027-05-27" } }),
      ],
      [pulley({ name: "1556.1002 Reno NV", constructionStart: "2027-05-27" })],
    );
    expect(matchProjects(n).decisions.every((d) => d.status === "needs_review")).toBe(true);
  });

  it("preserves valid same-year umbrella sharing and small milestone shifts", () => {
    const n = inputs(
      [
        acme({ sequence: 1002, dates: { constructionStart: "2027-06-01" } }),
        acme({
          sequence: 1003,
          projectType: "Coffee Tenant",
          dates: { constructionStart: "2027-06-04" },
        }),
      ],
      [
        pulley({
          name: "1556.1002 Reno NV 2027",
          constructionStart: "2027-06-03",
          street: "100 Main Street",
        }),
      ],
    );
    const report = matchProjects(n);
    expect(report.counts.matched).toBe(2);
    expect(() => assertPublicationInvariants(report.decisions, n.acme, n.pulley)).not.toThrow();
  });
});
