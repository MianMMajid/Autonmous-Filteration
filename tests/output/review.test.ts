import { describe, expect, it } from "vitest";
import { matchProjects } from "../../src/domain/match/matcher.ts";
import { reviewFingerprint, reviewWorkload } from "../../src/output/review.ts";
import { acme, inputs, pulley } from "../domain/match/fixtures.ts";

function pending() {
  const d = matchProjects(
    inputs(
      [acme()],
      [
        pulley({ id: "prj_a", name: "1556.1002 Reno 2027" }),
        pulley({ id: "prj_b", name: "1556.1002 Reno 2027" }),
      ],
    ),
  ).decisions[0];
  if (!d) throw new Error("missing fixture");
  return d;
}

describe("review workload", () => {
  it("surfaces the initial backlog, then keeps unchanged rows pending without resurfacing them", () => {
    const d = pending();
    expect(reviewWorkload(null, [d]).fresh).toEqual([d]);
    const result = reviewWorkload([{ ...d, reviewFingerprint: reviewFingerprint(d) }], [d]);
    expect(result).toEqual({ fresh: [], changed: [], unchanged: [d], resolved: [], removed: [] });
  });

  it("resurfaces changed evidence even when status and target remain unchanged", () => {
    const d = pending();
    const before = [{ ...d, reviewFingerprint: reviewFingerprint(d) }];
    const changed = {
      ...d,
      candidates: d.candidates.map((c) => ({ ...c, pulleyStatus: "On Hold" })),
    };
    expect(reviewWorkload(before, [changed]).changed).toEqual([changed]);
    expect(reviewWorkload(before, [{ ...d, reason: "EVIDENCE_CONFLICT" }]).changed).toHaveLength(1);
  });

  it("compares every candidate and ignores candidate and object-key ordering", () => {
    const d = pending();
    const reordered = {
      ...d,
      candidates: [...d.candidates]
        .reverse()
        .map((c) => Object.fromEntries(Object.entries(c).reverse()) as typeof c),
    };
    expect(reviewFingerprint(reordered)).toBe(reviewFingerprint(d));
  });

  it("keeps resolved cases distinct from projects removed from the register", () => {
    const d = pending();
    const removed = { ...d, acmeId: "2666.1001" };
    const result = reviewWorkload([d, removed], [{ ...d, status: "no_match" }]);
    expect(result.resolved).toEqual([d.acmeId]);
    expect(result.removed).toEqual([removed.acmeId]);
  });

  it("resurfaces legacy review rows without evidence fingerprints once", () => {
    const d = pending();
    expect(reviewWorkload([d], [d]).changed).toEqual([d]);
  });
});
