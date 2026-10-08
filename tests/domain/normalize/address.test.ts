import { describe, expect, it } from "vitest";
import { normalizeStreet, streetNameKey } from "../../../src/domain/normalize/address.ts";

describe("normalizeStreet", () => {
  it.each([
    ["3546 SYCAMORE RD.", "3546 Sycamore Road"],
    ["14905 WILSON STREET", "14905 Wilson St"],
    ["16588 E Pershing Lane", "16588 East Pershing Ln"],
    ["4329 E Peachtree Road, Suite A", "4329 E PEACHTREE RD"],
    ["2474 Highland Boulevard #13", "2474 Highland Blvd"],
    ["9198 SE SUMMIT RD", "9198 Southeast Summit Road"],
    ["963 N.E. Southgate Rd", "963 NE Southgate Road"],
    ["100   Main  Pkwy", "100 Main Parkway"],
    ["5043 Southeast Westgate Rd", "5043 SE Westgate Rd."],
    ["Lakeview Crossing, 3688 NW Sunset Way", "3688 Northwest Sunset Way"],
    ["Heritage Shopping Center, 858 COPPER AVE", "858 Copper Avenue"],
  ])("%s equals %s", (a, b) => {
    expect(normalizeStreet(a)).toBe(normalizeStreet(b));
    expect(normalizeStreet(a)).not.toBeNull();
  });

  it("produces the expected key", () => {
    expect(normalizeStreet("4329 E Peachtree Road, Suite A")).toBe("4329 E PEACHTREE RD");
    expect(normalizeStreet("963 N.E. Southgate Rd")).toBe("963 NE SOUTHGATE RD");
  });

  it("keeps different streets different", () => {
    expect(normalizeStreet("100 Main St")).not.toBe(normalizeStreet("100 Main Ave"));
    expect(normalizeStreet("100 N Main St")).not.toBe(normalizeStreet("100 S Main St"));
    expect(normalizeStreet("100 Main St")).not.toBe(normalizeStreet("101 Main St"));
  });

  it("exposes a street-name key that ignores the house number", () => {
    expect(streetNameKey("411 NW Ridgeview St")).toBe("NW RIDGEVIEW ST");
    expect(streetNameKey("501 NW Ridgeview Street")).toBe("NW RIDGEVIEW ST");
    expect(streetNameKey("Westfield Commons, 3482 Roswell Rd")).toBe("ROSWELL RD");
    expect(streetNameKey("Main St")).toBeNull();
    expect(streetNameKey(null)).toBeNull();
  });

  it("returns null for missing or empty input", () => {
    expect(normalizeStreet(null)).toBeNull();
    expect(normalizeStreet(undefined)).toBeNull();
    expect(normalizeStreet("   ")).toBeNull();
    expect(normalizeStreet("Suite 100")).toBeNull();
  });
});
