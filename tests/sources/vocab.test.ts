import { describe, expect, it } from "vitest";
import { findUnknownValues } from "../../src/sources/vocab.ts";

describe("findUnknownValues", () => {
  it("counts values outside the known set, sorted by value", () => {
    const items = [
      { s: "Active" },
      { s: "Zombie" },
      { s: "Zombie" },
      { s: "Archived" },
      { s: null },
    ];
    expect(findUnknownValues("acme", "status", items, (i) => i.s, ["Active"])).toEqual([
      { source: "acme", field: "status", value: "Archived", count: 1 },
      { source: "acme", field: "status", value: "Zombie", count: 2 },
    ]);
  });

  it("returns an empty list when everything is known", () => {
    expect(findUnknownValues("x", "f", [{ v: "a" }], (i) => i.v, ["a"])).toEqual([]);
  });
});
