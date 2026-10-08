import { describe, expect, it } from "vitest";
import { assessInputQuality } from "../../src/run/quality.ts";

const counts = { acmeProjects: 400, acmeSites: 363, acmeKeyDates: 400, pulleyProjects: 449 };

describe("assessInputQuality", () => {
  it("passes a healthy first run", () => {
    expect(assessInputQuality({ counts, matched: 333, previous: null })).toEqual({
      blockers: [],
      warnings: [],
    });
  });

  it("blocks empty exports even on the first run", () => {
    const { blockers } = assessInputQuality({
      counts: { ...counts, acmeProjects: 0 },
      matched: 0,
      previous: null,
    });
    expect(blockers).toEqual(["Project Register has zero rows"]);
  });

  it("blocks collapses and warns on notable drops versus the previous run", () => {
    const previous = { runId: "r1", inputCounts: counts, matched: 333 };
    const collapse = assessInputQuality({
      counts: { ...counts, pulleyProjects: 100 },
      matched: 100,
      previous,
    });
    expect(collapse.blockers).toEqual([
      "Pulley projects fell from 449 to 100 rows since r1",
      "matched rows fell from 333 to 100 since r1",
    ]);
    const notable = assessInputQuality({
      counts: { ...counts, acmeSites: 280 },
      matched: 300,
      previous,
    });
    expect(notable.blockers).toEqual([]);
    expect(notable.warnings).toEqual(["Site Directory fell from 363 to 280 rows since r1"]);
  });

  it("ignores growth and legacy records without counts", () => {
    const grown = assessInputQuality({
      counts: { ...counts, acmeProjects: 800 },
      matched: 600,
      previous: { runId: "r1", inputCounts: counts, matched: 333 },
    });
    expect(grown).toEqual({ blockers: [], warnings: [] });
    const legacy = assessInputQuality({
      counts,
      matched: 333,
      previous: { runId: "r0", inputCounts: null, matched: null },
    });
    expect(legacy).toEqual({ blockers: [], warnings: [] });
  });
});
