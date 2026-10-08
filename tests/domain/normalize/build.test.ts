import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Banner } from "../../../src/domain/model.ts";
import { normalizeInputs } from "../../../src/domain/normalize/build.ts";
import { pulleyProjectSchema } from "../../../src/sources/pulley/schema.ts";
import {
  parseKeyDates,
  parseProjectRegister,
  parseSiteDirectory,
} from "../../../src/sources/siteledger/parse.ts";

const fixture = (path: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`../../fixtures/${path}`, import.meta.url)));

function loadInputs() {
  const pulleyRaw = JSON.parse(
    readFileSync(new URL("../../fixtures/pulley/projects-all.json", import.meta.url), "utf8"),
  ) as unknown[];
  return {
    acme: {
      projects: parseProjectRegister(fixture("siteledger/project-register.xls")).rows,
      sites: parseSiteDirectory(fixture("siteledger/site-directory.xlsx")).rows,
      keyDates: parseKeyDates(fixture("siteledger/key-dates.csv")).rows,
    },
    pulley: pulleyRaw.map((p) => pulleyProjectSchema.parse(p)),
  };
}

describe("normalizeInputs on the real dataset", () => {
  const normalized = normalizeInputs(loadInputs());

  it("builds one Acme project per register row with site and dates joined", () => {
    expect(normalized.acme).toHaveLength(400);
    expect(normalized.acme.every((p) => p.site !== null)).toBe(true);
    expect(normalized.acme.every((p) => p.dates !== null)).toBe(true);
    expect(normalized.acme.every((p) => p.banner !== null)).toBe(true);
    expect(normalized.warnings).toEqual([]);
  });

  it("splits ids and reads canonical names", () => {
    const first = normalized.acme[0];
    expect(first).toMatchObject({ id: "2264.1001", store: 2264, sequence: 1001 });
    expect(first?.parsedName.canonical?.city).toBe("OMAHA");
    expect(
      first?.site?.locationNumber === first?.store ||
        first?.site?.formerLocationNumber === first?.store,
    ).toBe(true);
  });

  it("indexes sites by current and former location numbers", () => {
    expect(normalized.sites).toHaveLength(363);
    const withFormer = normalized.sites.filter((s) => s.formerLocationNumber !== null);
    expect(withFormer).toHaveLength(10);
    for (const site of withFormer) {
      expect(normalized.sitesByLocation.get(site.formerLocationNumber as number)).toContain(site);
      expect(normalized.sitesByLocation.get(site.locationNumber)).toContain(site);
    }
    expect(normalized.sites.every((s) => s.banner !== null && s.streetKey !== null)).toBe(true);
  });

  it("flags pathfinder and signage and derives banners on the Pulley side", () => {
    expect(normalized.pulley).toHaveLength(449);
    expect(normalized.pulley.filter((p) => p.isPathfinder)).toHaveLength(20);
    expect(normalized.pulley.filter((p) => p.isSignage)).toHaveLength(15);
    expect(normalized.pulley.filter((p) => p.banner === Banner.WarehouseClub)).toHaveLength(101);
    expect(normalized.pulley.filter((p) => p.streetKey !== null)).toHaveLength(299);
  });

  it("warns on join problems instead of failing", () => {
    const inputs = loadInputs();
    const broken = {
      acme: {
        projects: [
          ...inputs.acme.projects.slice(0, 2),
          { ...inputs.acme.projects[0], projectId: "9999.1000", siteId: "ST-0" },
          inputs.acme.projects[0],
        ],
        sites: inputs.acme.sites,
        keyDates: inputs.acme.keyDates.slice(1),
      },
      pulley: [],
    };
    const result = normalizeInputs(broken as Parameters<typeof normalizeInputs>[0]);
    expect(result.acme).toHaveLength(3);
    expect(result.warnings.join("\n")).toMatch(/1 duplicate/);
    expect(result.warnings.join("\n")).toMatch(/missing from the Site Directory/);
    expect(result.warnings.join("\n")).toMatch(/no Key Dates row/);
  });
});
