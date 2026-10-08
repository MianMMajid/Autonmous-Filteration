import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SchemaError } from "../../../src/errors.ts";
import {
  parseKeyDates,
  parseProjectRegister,
  parseSiteDirectory,
} from "../../../src/sources/siteledger/parse.ts";
import { reportDateSchema } from "../../../src/sources/siteledger/schemas.ts";

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`../../fixtures/siteledger/${name}`, import.meta.url)));

describe("parseProjectRegister (BIFF8 .xls)", () => {
  const parsed = parseProjectRegister(fixture("project-register.xls"));

  it("skips the banner, validates the header, and parses every row", () => {
    expect(parsed.rows).toHaveLength(400);
    expect(parsed.warnings).toEqual([]);
  });

  it("types the cells", () => {
    const first = parsed.rows[0];
    expect(first).toEqual({
      projectId: "2264.1001",
      siteId: "ST-39231",
      projectName: "2264.1001-OMAHA-NE-WHC-RM-2027",
      programYear: 2027,
      projectType: "Remodel",
      status: "Active",
    });
  });

  it("has unique project ids", () => {
    expect(new Set(parsed.rows.map((r) => r.projectId)).size).toBe(parsed.rows.length);
  });

  it("rejects garbage bytes and empty input", () => {
    expect(() => parseProjectRegister(new Uint8Array(0))).toThrow(SchemaError);
    expect(() => parseProjectRegister(new Uint8Array([1, 2, 3, 4]))).toThrow(SchemaError);
  });
});

describe("parseSiteDirectory (.xlsx)", () => {
  const parsed = parseSiteDirectory(fixture("site-directory.xlsx"));

  it("parses every site", () => {
    expect(parsed.rows).toHaveLength(363);
    expect(parsed.warnings).toEqual([]);
  });

  it("types the cells, including nullable former location numbers", () => {
    expect(parsed.rows[0]).toEqual({
      siteId: "ST-10412",
      banner: "Acme Market",
      locationNumber: 2036,
      formerLocationNumber: null,
      streetAddress: "963 NE Southgate Rd",
      mailingCity: "Aurora",
      state: "IL",
      zip: "60515",
      county: "Kane",
    });
    const withFormer = parsed.rows.filter((r) => r.formerLocationNumber !== null);
    expect(withFormer.length).toBe(10);
    expect(withFormer.every((r) => Number.isInteger(r.formerLocationNumber))).toBe(true);
  });
});

describe("parseKeyDates (CSV)", () => {
  const parsed = parseKeyDates(fixture("key-dates.csv"));

  it("parses every row and normalizes the mixed US and ISO dates", () => {
    expect(parsed.rows).toHaveLength(400);
    const dates = parsed.rows.flatMap((r) => [r.designStart, r.constructionStart]).filter(Boolean);
    expect(dates.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d)))).toBe(true);
    expect(parsed.rows[0]).toEqual({
      projectId: "6587.1004",
      designStart: "2026-12-01",
      permitSubmittedProjected: "2027-03-12",
      permitSubmittedActual: null,
      permitApproved: null,
      constructionStart: "2027-07-16",
    });
  });

  it("accepts a string input", () => {
    const text =
      "Project ID,Design Start,Permit Submitted (Projected),Permit Submitted (Actual),Permit Approved,Construction Start\n1111.1000,01/02/2026,,,,\n";
    expect(parseKeyDates(text).rows).toEqual([
      {
        projectId: "1111.1000",
        designStart: "2026-01-02",
        permitSubmittedProjected: null,
        permitSubmittedActual: null,
        permitApproved: null,
        constructionStart: null,
      },
    ]);
  });

  it("fails loudly on a changed header", () => {
    const text = "Project,Design Start\n1111.1000,01/02/2026\n";
    expect(() => parseKeyDates(text)).toThrow(/header/);
  });

  it("fails loudly on a malformed row and names it", () => {
    const text =
      "Project ID,Design Start,Permit Submitted (Projected),Permit Submitted (Actual),Permit Approved,Construction Start\nnot-an-id,13/45/2026,,,,\n";
    let caught: unknown;
    try {
      parseKeyDates(text);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SchemaError);
    const problems = (caught as SchemaError).details["problems"] as string[];
    expect(problems[0]).toMatch(/row 2/);
    expect(problems[0]).toMatch(/projectId/);
    expect(problems[0]).toMatch(/designStart/);
  });
});

describe("reportDateSchema", () => {
  it("accepts blanks, US and ISO dates, and rejects impossible ones", () => {
    expect(reportDateSchema.parse("")).toBeNull();
    expect(reportDateSchema.parse(null)).toBeNull();
    expect(reportDateSchema.parse("2/29/2028")).toBe("2028-02-29");
    expect(reportDateSchema.parse("2028-02-01")).toBe("2028-02-01");
    expect(reportDateSchema.safeParse("2/30/2028").success).toBe(false);
    expect(reportDateSchema.safeParse("2028-02-30").success).toBe(false);
    expect(reportDateSchema.safeParse("Feb 1 2028").success).toBe(false);
  });
});
