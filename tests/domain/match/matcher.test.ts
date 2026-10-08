import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { matchProjects } from "../../../src/domain/match/matcher.ts";
import { OutputStatus, ReasonCode, Tier } from "../../../src/domain/match/types.ts";
import { Banner } from "../../../src/domain/model.ts";
import { normalizeInputs } from "../../../src/domain/normalize/build.ts";
import { pulleyProjectSchema } from "../../../src/sources/pulley/schema.ts";
import {
  parseKeyDates,
  parseProjectRegister,
  parseSiteDirectory,
} from "../../../src/sources/siteledger/parse.ts";
import { acme, inputs, pulley } from "./fixtures.ts";

function one(acmeOverrides: Parameters<typeof acme>[0], pulleyList: ReturnType<typeof pulley>[]) {
  const report = matchProjects(inputs([acme(acmeOverrides)], pulleyList));
  const decision = report.decisions[0];
  if (!decision) throw new Error("no decision");
  return decision;
}

describe("matchProjects: tier 1, exact id", () => {
  it("matches a unique full id", () => {
    const d = one({}, [
      pulley({ id: "prj_a", name: "Acme | 1556.1002 RENO, NV" }),
      pulley({ id: "prj_b", name: "#1556 Reno, NV" }),
    ]);
    expect(d).toMatchObject({
      status: "matched",
      pulleyId: "prj_a",
      reason: ReasonCode.ExactId,
      tier: Tier.ExactId,
    });
  });

  it("ignores pathfinder and signage even with the exact id, and says so", () => {
    const d = one({}, [
      pulley({ id: "prj_p", name: "1556.1002 - Reno, NV", accountPlan: "pathfinder" }),
      pulley({ id: "prj_s", name: "1556.1002 - Reno, NV – Signage", projectType: "Signage" }),
    ]);
    expect(d).toMatchObject({
      status: "no_match",
      pulleyId: null,
      reason: ReasonCode.ExcludedOnly,
    });
    expect(d.note).toMatch(/prj_p \(pathfinder\)/);
    expect(d.note).toMatch(/prj_s \(signage\)/);
  });

  it("never matches across banners: club 1556 is not store 1556, but a human should see it", () => {
    const d = one({ banner: Banner.Market }, [
      pulley({ name: "ACME WC | 1556.1002 RENO, NV", banner: Banner.WarehouseClub }),
    ]);
    expect(d).toMatchObject({
      status: "needs_review",
      reason: ReasonCode.IdOutsideScope,
      pulleyId: null,
    });
  });

  it("never matches across states, but a human should see it", () => {
    const d = one({ state: "NV" }, [pulley({ name: "Acme | 1556.1002 RENO, NV", state: "TX" })]);
    expect(d).toMatchObject({
      status: "needs_review",
      reason: ReasonCode.IdOutsideScope,
      pulleyId: null,
    });
  });

  it("prefers the live project over a canceled duplicate, even when the canceled one has more dates", () => {
    const d = one({}, [
      pulley({
        id: "prj_dead",
        name: "[Canceled] 1556.1002 - Reno, NV",
        status: "Canceled",
        constructionStart: "2027-02-01",
      }),
      pulley({ id: "prj_live", name: "1556.1002 - Reno, NV" }),
    ]);
    expect(d).toMatchObject({ status: "matched", pulleyId: "prj_live" });
    expect(d.candidates.map((c) => c.pulleyId)).toEqual(["prj_live", "prj_dead"]);
  });

  it("flags two live projects with the same id as ambiguous", () => {
    const d = one({}, [
      pulley({ id: "prj_a", name: "1556.1002 - Reno, NV" }),
      pulley({ id: "prj_b", name: "1556.1002 - Reno, NV" }),
    ]);
    expect(d).toMatchObject({
      status: "needs_review",
      pulleyId: null,
      reason: ReasonCode.Ambiguous,
    });
    expect(d.candidates).toHaveLength(2);
  });
});

describe("matchProjects: tier 2, store plus type and year", () => {
  it("narrows several store projects by type and year", () => {
    const d = one({ projectType: "EV Charging", programYear: 2028 }, [
      pulley({
        id: "prj_rm",
        name: "#1556 Reno, NV",
        projectType: "Remodel",
        constructionStart: "2027-05-01",
      }),
      pulley({
        id: "prj_ev",
        name: "#1556 Reno, NV",
        projectType: "EV Charging",
        constructionStart: "2028-05-01",
      }),
    ]);
    expect(d).toMatchObject({
      status: "matched",
      pulleyId: "prj_ev",
      reason: ReasonCode.StoreTypeYear,
      tier: Tier.Store,
    });
  });

  it("lets an umbrella remodel absorb a tenant line at the same store and year (many to one)", () => {
    const remodel = pulley({
      id: "prj_rm",
      name: "Acme | 1556.1001 RENO, NV",
      projectType: "Remodel",
      constructionStart: "2027-05-01",
    });
    const report = matchProjects(
      inputs(
        [
          acme({ sequence: 1001, projectType: "Remodel" }),
          acme({ sequence: 1004, projectType: "Coffee Tenant" }),
        ],
        [remodel],
      ),
    );
    expect(report.decisions.map((d) => [d.acmeId, d.status, d.pulleyId])).toEqual([
      ["1556.1001", "matched", "prj_rm"],
      ["1556.1004", "matched", "prj_rm"],
    ]);
  });

  it("resolves a renumbered store through the former location number", () => {
    const d = one({ store: 1556, formerLocationNumber: 4980 }, [
      pulley({ id: "prj_old", name: "Acme | 4980, RENO, NV" }),
    ]);
    expect(d).toMatchObject({ status: "matched", pulleyId: "prj_old" });
  });

  it("sends a type mismatch to review instead of forcing it", () => {
    const d = one({ projectType: "EV Charging" }, [
      pulley({ id: "prj_rm", name: "#1556 Reno, NV", projectType: "Remodel" }),
    ]);
    expect(d).toMatchObject({ status: "needs_review", reason: ReasonCode.TypeMismatch });
  });

  it("does not trust a bare sequence as a store number", () => {
    const d = one({ store: 1005, sequence: 1002 }, [
      pulley({ name: "Phoenix, AZ – Proj 1005", state: "NV", jurisdictionCity: "Phoenix" }),
    ]);
    expect(d.status).toBe("no_match");
  });

  it("does not fold an Acme line into another year's permit at the same store", () => {
    const d = one(
      { programYear: 2029, projectType: "Remodel", dates: { constructionStart: "2029-10-21" } },
      [
        pulley({
          id: "prj_2027",
          name: "AM-1556 Reno NV",
          projectType: "Remodel",
          constructionStart: "2027-09-12",
        }),
      ],
    );
    expect(d).toMatchObject({ status: "no_match", reason: ReasonCode.UnrelatedOnly });
    expect(d.note).toMatch(/other years/);
    expect(d.candidates[0]?.pulleyId).toBe("prj_2027");
  });

  it("tolerates a year-boundary slip when the dates are close", () => {
    const d = one({ programYear: 2027, dates: { constructionStart: "2027-12-28" } }, [
      pulley({ id: "prj_slip", name: "#1556 Reno, NV", constructionStart: "2028-01-06" }),
    ]);
    expect(d).toMatchObject({ status: "matched", pulleyId: "prj_slip" });
  });

  it("lets exact dates decide between two same-store projects", () => {
    const d = one(
      {
        projectType: "Remodel",
        programYear: 2027,
        dates: { constructionStart: "2027-09-12", permitSubmittedActual: "2027-06-20" },
      },
      [
        pulley({
          id: "prj_far",
          name: "#1556 Reno, NV",
          projectType: "Remodel",
          constructionStart: "2027-02-01",
        }),
        pulley({
          id: "prj_exact",
          name: "Acme 1556 - Reno, NV",
          projectType: "Remodel",
          constructionStart: "2027-09-12",
          permitSubmitted: "2027-06-20",
        }),
      ],
    );
    expect(d).toMatchObject({ status: "matched", pulleyId: "prj_exact" });
  });

  it("requires locality when a store number identifies two buildings", () => {
    // Store 4980 is Lowell's current number and Worcester's former number.
    const lowell = acme({
      store: 4980,
      sequence: 1001,
      city: "Lowell",
      state: "MA",
      projectType: "Coffee Tenant",
    });
    const worcester = acme({
      store: 1912,
      sequence: 1003,
      city: "Worcester",
      state: "MA",
      formerLocationNumber: 4980,
      projectType: "New Build",
    });
    const report = matchProjects(
      inputs(
        [lowell, worcester],
        [
          pulley({
            id: "prj_worc",
            name: "Acme | 4980, WORCESTER, MA",
            jurisdictionCity: "Worcester",
            state: "MA",
            projectType: "New Build",
          }),
        ],
      ),
    );
    expect(report.decisions.map((d) => [d.acmeId, d.status, d.pulleyId])).toEqual([
      ["4980.1001", "no_match", null],
      ["1912.1003", "matched", "prj_worc"],
    ]);
  });

  it("treats a different-sequence, different-type candidate as another line, not a review item", () => {
    const d = one({ sequence: 1000, projectType: "Coffee Tenant" }, [
      pulley({ id: "prj_ev", name: "Acme | 1556.1001 TAMPA, FL", projectType: "EV Charging" }),
    ]);
    expect(d).toMatchObject({ status: "no_match", reason: ReasonCode.UnrelatedOnly });
  });
});

describe("matchProjects: tier 3, sequence plus locality", () => {
  it("matches a canonical name without a store when city and sequence identify one project", () => {
    const d = one(
      {
        store: 3497,
        sequence: 1001,
        city: "Columbus",
        state: "OH",
        projectType: "EV Charging",
        programYear: 2026,
      },
      [
        pulley({
          id: "prj_canon",
          name: "COLUMBUS-OH-SUP-EV-2026 (1001)",
          jurisdictionCity: "Columbus",
          state: "OH",
          projectType: "EV Charging",
        }),
      ],
    );
    expect(d).toMatchObject({
      status: "matched",
      pulleyId: "prj_canon",
      reason: ReasonCode.SequenceLocality,
      tier: Tier.Sequence,
    });
  });

  it("refuses when two Acme projects share the city and sequence", () => {
    const report = matchProjects(
      inputs(
        [
          acme({ store: 1111, sequence: 1001, city: "Reno" }),
          acme({ store: 2222, sequence: 1001, city: "Reno" }),
        ],
        [pulley({ id: "prj_seq", name: "Acme .1001 - Reno, NV", jurisdictionCity: "Reno" })],
      ),
    );
    for (const d of report.decisions) expect(d.status).not.toBe("matched");
  });

  it("still matches when type or year separates the two Acme projects", () => {
    const report = matchProjects(
      inputs(
        [
          acme({
            store: 1111,
            sequence: 1001,
            city: "Reno",
            projectType: "EV Charging",
            programYear: 2026,
          }),
          acme({
            store: 2222,
            sequence: 1001,
            city: "Reno",
            projectType: "Remodel",
            programYear: 2028,
          }),
        ],
        [
          pulley({
            id: "prj_ev",
            name: "RENO-NV-SUP-EV-2026 (1001)",
            jurisdictionCity: "Reno",
            projectType: "EV Charging",
          }),
        ],
      ),
    );
    expect(report.decisions.map((d) => [d.acmeId, d.status, d.pulleyId])).toEqual([
      ["1111.1001", "matched", "prj_ev"],
      ["2222.1001", "no_match", null],
    ]);
  });
});

describe("matchProjects: tier 3 and 4, address and weak evidence", () => {
  it("matches on an exact street when the name has no number", () => {
    const d = one({ street: "4329 E Peachtree Road" }, [
      pulley({
        id: "prj_addr",
        name: "Acme Market – Reno, NV",
        street: "4329 E PEACHTREE RD, Suite A",
      }),
      pulley({ id: "prj_other", name: "Acme Market – Reno, NV", street: "1 Elsewhere Ave" }),
    ]);
    expect(d).toMatchObject({
      status: "matched",
      pulleyId: "prj_addr",
      reason: ReasonCode.Address,
      tier: Tier.Address,
    });
  });

  it("never matches on a street name with a different house number", () => {
    const d = one({ street: "411 NW Ridgeview St" }, [
      pulley({ id: "prj_typo", name: "Acme Market – Reno, NV", street: "501 NW Ridgeview St" }),
    ]);
    expect(d).toMatchObject({
      status: "needs_review",
      reason: ReasonCode.WeakEvidence,
      pulleyId: null,
    });
    expect(d.candidates[0]?.pulleyId).toBe("prj_typo");
  });

  it("surfaces a locality, type, and year candidate for review", () => {
    const d = one({ projectType: "Remodel", programYear: 2027, city: "Reno" }, [
      pulley({
        id: "prj_loc",
        name: "Acme Remodel - Reno, NV",
        jurisdictionCity: "Reno",
        projectType: "Remodel",
        constructionStart: "2027-01-01",
      }),
    ]);
    expect(d).toMatchObject({ status: "needs_review", reason: ReasonCode.WeakEvidence });
  });

  it("returns no_match when nothing relates", () => {
    const d = one({}, [pulley({ name: "#9999 Reno, NV" })]);
    expect(d).toMatchObject({ status: "no_match", reason: ReasonCode.NoCandidate });
  });
});

describe("matchProjects: tier 5, dates plus locality", () => {
  it("matches a nameless project whose dates sit within a week of the Key Dates", () => {
    const d = one(
      {
        programYear: 2026,
        dates: { constructionStart: "2026-10-28", permitSubmittedActual: "2026-06-09" },
      },
      [
        pulley({
          id: "prj_dates",
          name: "Project Larkspur",
          jurisdictionCity: "Reno",
          constructionStart: "2026-10-30",
          permitSubmitted: "2026-06-11",
        }),
      ],
    );
    expect(d).toMatchObject({
      status: "matched",
      pulleyId: "prj_dates",
      reason: ReasonCode.DateLocality,
      tier: Tier.Dates,
    });
  });

  it("refuses when two Acme projects in the city share the dates", () => {
    const dates = { constructionStart: "2026-10-28" };
    const report = matchProjects(
      inputs(
        [
          acme({ store: 1111, sequence: 1001, dates }),
          acme({ store: 2222, sequence: 1001, dates }),
        ],
        [
          pulley({
            id: "prj_dates",
            name: "Project Larkspur",
            jurisdictionCity: "Reno",
            constructionStart: "2026-10-29",
          }),
        ],
      ),
    );
    for (const d of report.decisions) expect(d.status).not.toBe("matched");
  });
});

describe("matchProjects: audit cases", () => {
  it("does not let a full id resolve to two buildings when its store number is shared", () => {
    const lowell = acme({
      store: 4980,
      sequence: 1001,
      city: "Lowell",
      state: "MA",
      street: "565 Cypress Rd",
    });
    const worcester = acme({
      store: 1912,
      sequence: 1001,
      city: "Worcester",
      state: "MA",
      formerLocationNumber: 4980,
      street: "6591 Deer Run St",
    });
    const report = matchProjects(
      inputs(
        [lowell, worcester],
        [
          pulley({
            id: "prj_w",
            name: "4980.1001 Worcester, MA",
            jurisdictionCity: "Worcester",
            state: "MA",
            street: "6591 Deer Run St",
          }),
        ],
      ),
    );
    expect(report.decisions.map((d) => [d.acmeId, d.status, d.pulleyId])).toEqual([
      ["4980.1001", "no_match", null],
      ["1912.1001", "matched", "prj_w"],
    ]);
  });

  it("does not let the date tier accept a name that says another year", () => {
    const d = one({ programYear: 2027, dates: { constructionStart: "2027-01-15" } }, [
      pulley({
        id: "prj_2026",
        name: "Acme Reno Remodel 2026",
        jurisdictionCity: "Reno",
        constructionStart: "2027-01-15",
      }),
    ]);
    expect(d.status).not.toBe("matched");
  });

  it("scopes reverse uniqueness checks to the state", () => {
    const il = acme({ store: 1111, sequence: 1002, city: "Springfield", state: "IL" });
    const ma = acme({ store: 2222, sequence: 1002, city: "Springfield", state: "MA" });
    const report = matchProjects(
      inputs(
        [il, ma],
        [
          pulley({
            id: "prj_il",
            name: "Springfield Seq 1002",
            jurisdictionCity: "Springfield",
            state: "IL",
          }),
        ],
      ),
    );
    expect(report.decisions.map((d) => [d.acmeId, d.status, d.pulleyId])).toEqual([
      ["1111.1002", "matched", "prj_il"],
      ["2222.1002", "no_match", null],
    ]);
  });

  it("sends unknown status vocabulary to review instead of matching", () => {
    expect(
      one({ status: "Active" }, [pulley({ name: "1556.1002 - Reno, NV", status: "Archived" })]),
    ).toMatchObject({
      status: "needs_review",
      reason: ReasonCode.StatusUnknown,
    });
    expect(one({ status: "Paused" }, [pulley({ name: "1556.1002 - Reno, NV" })])).toMatchObject({
      status: "needs_review",
      reason: ReasonCode.StatusUnknown,
    });
    expect(
      one({ status: "Canceled" }, [
        pulley({ name: "1556.1002 - Reno, NV", status: "In Progress" }),
      ]),
    ).toMatchObject({
      status: "needs_review",
      reason: ReasonCode.StatusConflict,
    });
  });

  it("lets the full id in the name pin the year when dates point elsewhere", () => {
    const project = pulley({
      id: "prj_x",
      name: "Acme Market 1556.1005 – Reno",
      projectType: "Remodel",
      constructionStart: "2027-05-27",
    });
    const report = matchProjects(
      inputs(
        [
          acme({ sequence: 1005, programYear: 2026, projectType: "Remodel" }),
          acme({
            sequence: 1007,
            programYear: 2027,
            projectType: "Remodel",
            dates: { constructionStart: "2027-06-02" },
          }),
        ],
        [project],
      ),
    );
    expect(report.decisions.map((d) => [d.acmeId, d.status, d.reason])).toEqual([
      ["1556.1005", "matched", ReasonCode.ExactId],
      ["1556.1007", "needs_review", ReasonCode.YearConflict],
    ]);
  });
});

describe("matchProjects: year conflicts across claims", () => {
  it("keeps the strong claim and sends the other year's claim to review", () => {
    const store = pulley({
      id: "prj_store",
      name: "Acme | 1556.1004 RENO, NV",
      projectType: "Remodel",
    });
    const report = matchProjects(
      inputs(
        [
          acme({ sequence: 1004, programYear: 2027, projectType: "Remodel" }),
          acme({ sequence: 1005, programYear: 2028, projectType: "Remodel" }),
        ],
        [store],
      ),
    );
    expect(report.decisions.map((d) => [d.acmeId, d.status, d.reason])).toEqual([
      ["1556.1004", "matched", ReasonCode.ExactId],
      ["1556.1005", "needs_review", ReasonCode.YearConflict],
    ]);
    expect(report.decisions[1]?.note).toMatch(/also claimed by 1556.1004 \(2027\)/);
  });

  it("allows several lines from the same year to share one permit", () => {
    const store = pulley({ id: "prj_store", name: "#1556 Reno, NV", projectType: "Remodel" });
    const report = matchProjects(
      inputs(
        [
          acme({ sequence: 1004, programYear: 2027, projectType: "Remodel" }),
          acme({ sequence: 1005, programYear: 2027, projectType: "Coffee Tenant" }),
        ],
        [store],
      ),
    );
    expect(report.decisions.every((d) => d.status === "matched")).toBe(true);
  });
});

describe("matchProjects: exact id outside the banner or state", () => {
  it("sends a likely data-entry error to review instead of no_match", () => {
    const d = one({ banner: Banner.Market }, [
      pulley({ id: "prj_wc", name: "1556.1002 - Reno, NV", banner: Banner.WarehouseClub }),
    ]);
    expect(d).toMatchObject({
      status: "needs_review",
      reason: ReasonCode.IdOutsideScope,
      pulleyId: null,
    });
    expect(d.note).toMatch(/prj_wc is Acme Warehouse Club in NV; Acme site is Acme Market in NV/);
  });
});

describe("matchProjects: status drift and shared streets", () => {
  it("reports Pulley Complete against Acme Active on a matched row", () => {
    const d = one({ status: "Active" }, [
      pulley({ name: "1556.1002 - Reno, NV", status: "Complete" }),
    ]);
    expect(d.status).toBe("matched");
    expect(d.statusDrift).toBe("Pulley Complete, Acme Active");
    const report = matchProjects(
      inputs(
        [acme({ status: "Active" })],
        [pulley({ name: "1556.1002 - Reno, NV", status: "Complete" })],
      ),
    );
    expect(report.statusDrift).toBe(1);
  });

  it("needs the city when two sites share a street key", () => {
    const reno = acme({ store: 1111, sequence: 1001, city: "Reno", street: "100 Main St" });
    const vegas = acme({ store: 2222, sequence: 1001, city: "Las Vegas", street: "100 Main St" });
    const report = matchProjects(
      inputs(
        [reno, vegas],
        [
          pulley({
            id: "prj_lv",
            name: "Acme Market – Las Vegas, NV",
            jurisdictionCity: "Las Vegas",
            street: "100 Main St",
          }),
        ],
      ),
    );
    expect(report.decisions.map((d) => [d.acmeId, d.status, d.pulleyId])).toEqual([
      ["1111.1001", "no_match", null],
      ["2222.1001", "matched", "prj_lv"],
    ]);
  });
});

describe("matchProjects: status gate", () => {
  it("passes closed vs canceled, blocks closed vs live and live vs canceled", () => {
    expect(
      one({ status: "Closed" }, [pulley({ name: "1556.1002 - Reno, NV", status: "Canceled" })])
        .status,
    ).toBe("matched");
    expect(
      one({ status: "Closed" }, [pulley({ name: "1556.1002 - Reno, NV", status: "In Progress" })]),
    ).toMatchObject({
      status: "needs_review",
      reason: ReasonCode.StatusConflict,
    });
    expect(
      one({ status: "Active" }, [pulley({ name: "1556.1002 - Reno, NV", status: "Canceled" })]),
    ).toMatchObject({
      status: "needs_review",
      reason: ReasonCode.StatusConflict,
    });
  });
});

describe("matchProjects on the real dataset", () => {
  const fixture = (path: string): Uint8Array =>
    new Uint8Array(readFileSync(new URL(`../../fixtures/${path}`, import.meta.url)));
  const pulleyRaw = JSON.parse(
    readFileSync(new URL("../../fixtures/pulley/projects-all.json", import.meta.url), "utf8"),
  ) as unknown[];
  const normalized = normalizeInputs({
    acme: {
      projects: parseProjectRegister(fixture("siteledger/project-register.xls")).rows,
      sites: parseSiteDirectory(fixture("siteledger/site-directory.xlsx")).rows,
      keyDates: parseKeyDates(fixture("siteledger/key-dates.csv")).rows,
    },
    pulley: pulleyRaw.map((p) => pulleyProjectSchema.parse(p)),
  });
  const report = matchProjects(normalized);

  it("produces exactly one decision per Acme project", () => {
    expect(report.decisions).toHaveLength(400);
    expect(new Set(report.decisions.map((d) => d.acmeId)).size).toBe(400);
  });

  it("never points at a pathfinder or signage project", () => {
    const excluded = new Set(
      normalized.pulley.filter((p) => p.isPathfinder || p.isSignage).map((p) => p.id),
    );
    for (const d of report.decisions) {
      if (d.pulleyId) expect(excluded.has(d.pulleyId), d.acmeId).toBe(false);
    }
  });

  it("is deterministic", () => {
    expect(matchProjects(normalized)).toEqual(report);
  });

  it("matches most rows and keeps review manageable", () => {
    expect(report.counts.matched).toBeGreaterThanOrEqual(320);
    expect(report.counts.needs_review).toBeLessThanOrEqual(30);
    expect(report.counts.matched + report.counts.needs_review + report.counts.no_match).toBe(400);
  });

  it("reports Pulley ids that are not in the register, ignoring renumbered-store aliases", () => {
    // An alias is former.sequence for a register row whose site was renumbered.
    const aliases = new Set(
      normalized.acme
        .filter((a) => a.site?.formerLocationNumber != null)
        .map((a) => `${a.site?.formerLocationNumber}.${a.sequence}`),
    );
    expect(aliases.size).toBeGreaterThan(0);
    for (const { acmeId } of report.pulleyIdsNotInRegister) {
      expect(aliases.has(acmeId), `${acmeId} is a renumbered-store alias`).toBe(false);
    }
    expect(report.pulleyIdsNotInRegister.length).toBeGreaterThan(0);
    expect(report.pulleyIdsNotInRegister.length).toBeLessThan(9);
  });

  it("every matched row satisfies the status gate and type compatibility", () => {
    for (const d of report.decisions) {
      if (d.status !== OutputStatus.Matched) continue;
      const winner = d.candidates[0];
      expect(winner?.pulleyId).toBe(d.pulleyId);
      expect(winner?.evidence.typeCompatible).toBe(true);
      expect(winner?.evidence.statusAgree, d.acmeId).toBe(true);
    }
  });

  it("never assigns one Pulley project to Acme lines from different sites or years", () => {
    const byAcme = new Map(normalized.acme.map((a) => [a.id, a]));
    const claims = new Map<string, Set<string>>();
    for (const d of report.decisions) {
      if (d.status !== OutputStatus.Matched || !d.pulleyId) continue;
      const a = byAcme.get(d.acmeId);
      const key = `${a?.siteId}|${a?.programYear}`;
      claims.set(d.pulleyId, new Set([...(claims.get(d.pulleyId) ?? []), key]));
    }
    for (const [pulleyId, keys] of claims) expect(keys.size, pulleyId).toBe(1);
  });
});
