import { describe, expect, it } from "vitest";
import type { MatchDecision } from "../../src/domain/match/types.ts";
import { diffRuns } from "../../src/output/diff.ts";

const d = (
  acmeId: string,
  status: MatchDecision["status"],
  pulleyId: string | null,
): MatchDecision => ({ acmeId, status, pulleyId }) as MatchDecision;

describe("diffRuns", () => {
  it("reports nothing on the first run", () => {
    const diff = diffRuns(null, [d("1.1000", "matched", "prj_a")]);
    expect(diff.previousRunId).toBeNull();
    expect(diff.changes).toEqual([]);
  });

  it("classifies every kind of change and lists new and removed ids", () => {
    const previous = {
      runId: "r1",
      decisions: [
        { acmeId: "1.1000", status: "matched" as const, pulleyId: "prj_a" },
        { acmeId: "1.1001", status: "needs_review" as const, pulleyId: null },
        { acmeId: "1.1002", status: "matched" as const, pulleyId: "prj_c" },
        { acmeId: "1.1003", status: "no_match" as const, pulleyId: null },
        { acmeId: "1.1004", status: "matched" as const, pulleyId: "prj_e" },
        { acmeId: "1.1009", status: "matched" as const, pulleyId: "prj_z" },
      ],
    };
    const current = [
      d("1.1000", "matched", "prj_a"), // unchanged
      d("1.1001", "matched", "prj_b"), // newly matched
      d("1.1002", "needs_review", null), // lost match
      d("1.1003", "needs_review", null), // status changed
      d("1.1004", "matched", "prj_f"), // rematched
      d("1.1010", "no_match", null), // new
    ];
    const diff = diffRuns(previous, current);
    expect(diff.previousRunId).toBe("r1");
    expect(diff.changes.map((c) => [c.acmeId, c.kind])).toEqual([
      ["1.1001", "newly_matched"],
      ["1.1002", "lost_match"],
      ["1.1003", "status_changed"],
      ["1.1004", "rematched"],
    ]);
    expect(diff.counts).toEqual({ newlyMatched: 1, lostMatch: 1, rematched: 1, statusChanged: 1 });
    expect(diff.newAcmeIds).toEqual(["1.1010"]);
    expect(diff.removedAcmeIds).toEqual(["1.1009"]);
  });
});
