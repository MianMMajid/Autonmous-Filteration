import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseProjectName } from "../../../src/domain/normalize/name.ts";

interface Expectation {
  readonly name: string;
  readonly fullIds?: string[];
  readonly stores?: number[];
  readonly sequences?: number[];
  readonly years?: number[];
  readonly canceled?: boolean;
  readonly signage?: boolean;
  readonly cityState?: { city: string; state: string } | null;
  readonly canonical?: Partial<{
    store: number | null;
    sequence: number | null;
    city: string;
    state: string;
    bannerCode: string;
    typeCode: string;
    year: number;
  }> | null;
}

/** One representative per observed name shape (2026-10-08 dataset). */
const CASES: Expectation[] = [
  {
    name: "6136.1004-PROVO-UT-SUP-DR-2027",
    fullIds: ["6136.1004"],
    stores: [6136],
    sequences: [],
    years: [2027],
    canonical: {
      store: 6136,
      sequence: 1004,
      city: "PROVO",
      state: "UT",
      bannerCode: "SUP",
      typeCode: "DR",
      year: 2027,
    },
  },
  {
    name: "1342.1005-SAN ANTONIO-TX-SUP-DR-2028",
    canonical: { city: "SAN ANTONIO", state: "TX" },
    stores: [1342],
  },
  {
    name: "Acme 6909 - Reno, NV",
    stores: [6909],
    fullIds: [],
    cityState: { city: "Reno", state: "NV" },
  },
  { name: "#1570 Gainesville, FL", stores: [1570] },
  { name: "2162.1005 - Rockford, IL", fullIds: ["2162.1005"], stores: [2162] },
  { name: "NAPERVILLE IL #3794", stores: [3794], years: [] },
  {
    name: "Acme | 4490, NASHVILLE, TN",
    stores: [4490],
    cityState: { city: "NASHVILLE", state: "TN" },
  },
  { name: "Acme | 5979.1000 MESA, AZ", fullIds: ["5979.1000"], stores: [5979] },
  { name: "Store 5354 Worcester, MA", stores: [5354] },
  { name: "AM-3229 Phoenix AZ", stores: [3229] },
  { name: "SACRAMENTO COUNTY CA #5444", stores: [5444] },
  { name: "Acme Market 6082.1003 – Tallahassee", fullIds: ["6082.1003"], stores: [6082] },
  { name: "Acme Market #6158 – Sparks Coffee Tenant", stores: [6158] },
  {
    name: "Acme Market – Layton, UT",
    stores: [],
    fullIds: [],
    sequences: [],
    years: [],
    cityState: { city: "Layton", state: "UT" },
  },
  { name: "ACME WC | 5490 HOUSTON, TX", stores: [5490] },
  { name: "ACME MKT STORE 4680 CHARLOTTE NC 2028 EX", stores: [4680], years: [2028] },
  { name: "Atlanta GA - 1729.1005 Remodel", fullIds: ["1729.1005"], stores: [1729] },
  {
    name: "Phoenix, AZ – Proj 1001",
    stores: [],
    sequences: [1001],
    cityState: { city: "Phoenix", state: "AZ" },
  },
  { name: "Project Larkspur", stores: [], fullIds: [], sequences: [], years: [], cityState: null },
  { name: "Acme .1004 - Chandler, AZ", stores: [], sequences: [1004] },
  { name: "Washington County OR Remodel 2027", stores: [], years: [2027] },
  {
    name: "COLUMBUS-OH-SUP-EV-2026 (1001)",
    stores: [],
    sequences: [1001],
    years: [2026],
    canonical: {
      store: null,
      sequence: 1001,
      city: "COLUMBUS",
      state: "OH",
      bannerCode: "SUP",
      typeCode: "EV",
      year: 2026,
    },
  },
  {
    name: "[Canceled] 2191.1005-RIVERSIDE-CA-SUP-RM-2028",
    canceled: true,
    fullIds: ["2191.1005"],
    years: [2028],
  },
  { name: "Ridgeback (CA)", stores: [], cityState: null },
  { name: "Acme Springfield MA Seq 1005 Coffee Tenant", stores: [], sequences: [1005] },
  { name: "⭐ SCRANTON PA #1776", stores: [1776] },
  { name: "Acme | 4187.1003 RENO, NV – Signage", fullIds: ["4187.1003"], signage: true },
  { name: "🔴 Acme | 2957, JOLIET, IL", stores: [2957], canceled: false },
  { name: "Nashville, TN (Store #2472) Deli Remodel", stores: [2472] },
  { name: "Remodel 2026 / Acme 1134 / Tucson", stores: [1134], years: [2026] },
  { name: "⭐ Club 6287 Lowell, MA", stores: [6287] },
  { name: "[Canceled] Acme | 4117, ROCKFORD, IL", canceled: true, stores: [4117] },
  { name: "⚠️ Store 4557 Orlando, FL", stores: [4557] },
  { name: "Store  2247 Memphis, TN", stores: [2247] },
  {
    name: "Acme 3841 - Unincorporated Maricopa County, AZ",
    stores: [3841],
    cityState: { city: "Unincorporated Maricopa County", state: "AZ" },
  },
  {
    name: "2548.1000-KANSAS CITY-MO-SUP-EX-2026 – Signage",
    fullIds: ["2548.1000"],
    signage: true,
    canonical: { city: "KANSAS CITY" },
  },
  { name: "#2020 Somewhere, TX", stores: [2020], years: [] },
];

describe("parseProjectName", () => {
  it.each(CASES)("$name", (expected) => {
    const parsed = parseProjectName(expected.name);
    if (expected.fullIds) expect(parsed.fullIds).toEqual(expected.fullIds);
    if (expected.stores) expect(parsed.storeNumbers).toEqual(expected.stores);
    if (expected.sequences) expect(parsed.sequences).toEqual(expected.sequences);
    if (expected.years) expect(parsed.years).toEqual(expected.years);
    if (expected.canceled !== undefined) expect(parsed.canceledMarker).toBe(expected.canceled);
    if (expected.signage !== undefined) expect(parsed.signageHint).toBe(expected.signage);
    if (expected.cityState !== undefined) expect(parsed.cityState).toEqual(expected.cityState);
    if (expected.canonical === null) expect(parsed.canonical).toBeNull();
    else if (expected.canonical) expect(parsed.canonical).toMatchObject(expected.canonical);
  });

  it("strips decorations into clean text", () => {
    const parsed = parseProjectName("🔴 [Canceled] Acme | 2957, JOLIET, IL – Signage");
    expect(parsed.text).toBe("Acme | 2957, JOLIET, IL - Signage");
    expect(parsed.markers).toEqual(["Canceled"]);
  });

  it("never mistakes a sequence for a store number", () => {
    for (const name of [
      "Phoenix, AZ – Proj 1001",
      "Acme .1004 - Chandler, AZ",
      "Acme Springfield MA Seq 1005 Coffee Tenant",
    ]) {
      expect(parseProjectName(name).storeNumbers).toEqual([]);
    }
  });
});

describe("parseProjectName over the full Pulley fixture", () => {
  const projects = JSON.parse(
    readFileSync(new URL("../../fixtures/pulley/projects-all.json", import.meta.url), "utf8"),
  ) as { name: string }[];

  it("parses every name and extracts at least one fact from every name with digits", () => {
    for (const { name } of projects) {
      const parsed = parseProjectName(name);
      const hasDigits = /\d/.test(name);
      const facts =
        parsed.fullIds.length +
        parsed.storeNumbers.length +
        parsed.sequences.length +
        parsed.years.length;
      expect(hasDigits ? facts > 0 : facts === 0, `name: ${name}`).toBe(true);
    }
  });

  it("recovers every full id that appears literally", () => {
    for (const { name } of projects) {
      const literal = [...name.matchAll(/\b\d{4}\.\d{4}\b/g)].map((m) => m[0]);
      expect(parseProjectName(name).fullIds).toEqual([...new Set(literal)]);
    }
  });

  it("matches the counts observed on 2026-10-08", () => {
    const parsed = projects.map((p) => parseProjectName(p.name));
    expect(parsed.filter((p) => p.fullIds.length > 0)).toHaveLength(146);
    expect(parsed.filter((p) => p.canceledMarker)).toHaveLength(11);
    expect(parsed.filter((p) => p.canonical !== null)).toHaveLength(66);
    expect(
      parsed.filter(
        (p) => p.fullIds.length === 0 && p.storeNumbers.length === 0 && p.sequences.length === 0,
      ),
    ).toHaveLength(32);
  });
});

describe("parseProjectName on Acme register names", () => {
  it("reads the canonical structure", () => {
    const parsed = parseProjectName("1180.1006-ROUND ROCK-TX-SUP-PR-2028");
    expect(parsed.canonical).toEqual({
      store: 1180,
      sequence: 1006,
      city: "ROUND ROCK",
      state: "TX",
      bannerCode: "SUP",
      typeCode: "PR",
      year: 2028,
    });
  });
});
