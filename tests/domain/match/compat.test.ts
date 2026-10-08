import { describe, expect, it } from "vitest";
import {
  dateProximityDays,
  sequenceRelation,
  statusesAgree,
  storeContradicts,
  storeMatches,
  Temporal,
  temporalVerdict,
  typesCompatible,
  yearSignal,
} from "../../../src/domain/match/compat.ts";
import { SequenceRelation, YearSignal } from "../../../src/domain/match/types.ts";
import { acme, pulley } from "./fixtures.ts";

describe("typesCompatible", () => {
  it("accepts equal types and umbrella permits over absorbable lines", () => {
    expect(typesCompatible("Remodel", "Remodel")).toBe(true);
    expect(typesCompatible("Coffee Tenant", "Remodel")).toBe(true);
    expect(typesCompatible("Pharmacy Relocation", "Expansion")).toBe(true);
    expect(typesCompatible("Deli Remodel", "New Build")).toBe(true);
  });
  it("rejects distinct infrastructure and signage", () => {
    expect(typesCompatible("EV Charging", "Remodel")).toBe(false);
    expect(typesCompatible("Remodel", "EV Charging")).toBe(false);
    expect(typesCompatible("Remodel", "Signage")).toBe(false);
    expect(typesCompatible("New Build", "Remodel")).toBe(false);
  });
});

describe("yearSignal", () => {
  const a = acme({ programYear: 2027 });
  it("prefers the year written in the name", () => {
    expect(
      yearSignal(a, pulley({ name: "X-TX-SUP-RM-2027", constructionStart: "2029-01-01" })),
    ).toBe(YearSignal.NameEqual);
    expect(yearSignal(a, pulley({ name: "Remodel 2026", constructionStart: "2027-01-01" }))).toBe(
      YearSignal.NameDifferent,
    );
  });
  it("falls back to dates, then none", () => {
    expect(yearSignal(a, pulley({ permitSubmitted: "2027-03-01" }))).toBe(YearSignal.DateEqual);
    expect(yearSignal(a, pulley({ constructionStart: "2028-03-01" }))).toBe(
      YearSignal.DateDifferent,
    );
    expect(yearSignal(a, pulley({}))).toBe(YearSignal.None);
  });
});

describe("sequenceRelation and store matching", () => {
  const a = acme({ id: "1556.1002", store: 1556, sequence: 1002, formerLocationNumber: 4980 });
  it("reads sequences from full ids and seq-only names", () => {
    expect(sequenceRelation(a, pulley({ name: "Acme | 1556.1002 RENO, NV" }))).toBe(
      SequenceRelation.Equal,
    );
    expect(sequenceRelation(a, pulley({ name: "Acme | 1556.1004 RENO, NV" }))).toBe(
      SequenceRelation.Different,
    );
    expect(sequenceRelation(a, pulley({ name: "Acme .1002 - Reno, NV" }))).toBe(
      SequenceRelation.Equal,
    );
    expect(sequenceRelation(a, pulley({ name: "#1556 Reno, NV" }))).toBe(SequenceRelation.Unknown);
  });
  it("matches current and former location numbers and detects contradictions", () => {
    expect(storeMatches(a, pulley({ name: "#1556 Reno, NV" }))).toBe(true);
    expect(storeMatches(a, pulley({ name: "#4980 Reno, NV" }))).toBe(true);
    expect(storeMatches(a, pulley({ name: "#9999 Reno, NV" }))).toBe(false);
    expect(storeContradicts(a, pulley({ name: "#9999 Reno, NV" }))).toBe(true);
    expect(storeContradicts(a, pulley({ name: "Acme Market - Reno, NV" }))).toBe(false);
  });
});

describe("dateProximityDays and temporalVerdict", () => {
  const a = acme({
    programYear: 2027,
    dates: { constructionStart: "2027-09-12", permitSubmittedActual: "2027-06-20" },
  });
  it("takes the smallest gap across milestone pairs", () => {
    expect(
      dateProximityDays(
        a,
        pulley({ constructionStart: "2027-09-15", permitSubmitted: "2027-01-01" }),
      ),
    ).toBe(3);
    expect(dateProximityDays(a, pulley({}))).toBeNull();
    expect(dateProximityDays(acme({}), pulley({ constructionStart: "2027-09-15" }))).toBeNull();
  });
  it("classifies same, near, unknown, and conflict", () => {
    expect(temporalVerdict(a, pulley({ constructionStart: "2027-09-15" }))).toBe(Temporal.Same);
    expect(temporalVerdict(a, pulley({ name: "X-NV-SUP-RM-2027" }))).toBe(Temporal.Same);
    expect(temporalVerdict(a, pulley({ constructionStart: "2027-02-01" }))).toBe(Temporal.Near);
    expect(temporalVerdict(a, pulley({ constructionStart: "2028-01-05" }))).toBe(Temporal.Near);
    expect(temporalVerdict(a, pulley({}))).toBe(Temporal.Unknown);
    expect(temporalVerdict(a, pulley({ constructionStart: "2029-09-12" }))).toBe(Temporal.Conflict);
    expect(
      temporalVerdict(a, pulley({ name: "Remodel 2029", constructionStart: "2027-09-12" })),
    ).toBe(Temporal.Conflict);
    expect(
      temporalVerdict(acme({ programYear: 2027 }), pulley({ constructionStart: "2029-09-12" })),
    ).toBe(Temporal.Conflict);
  });
});

describe("statusesAgree", () => {
  it.each([
    ["Active", "In Progress", true],
    ["Active", "Complete", true],
    ["Active", "Canceled", false],
    ["Deferred", "On Hold", true],
    ["Deferred", "Canceled", false],
    ["Closed", "Canceled", true],
    ["Closed", "Complete", true],
    ["Closed", "In Progress", false],
    ["Closed", "Draft", false],
  ])("%s vs %s -> %s", (a, p, expected) => {
    expect(statusesAgree(a, p)).toBe(expected);
  });
});
