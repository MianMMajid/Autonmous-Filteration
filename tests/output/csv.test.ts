import { describe, expect, it } from "vitest";
import type { MatchDecision, MatchReport } from "../../src/domain/match/types.ts";
import {
  MAPPING_COLUMNS,
  renderDecisionsCsv,
  renderMappingCsv,
  renderReviewCsv,
  renderUnmatchedPulleyCsv,
} from "../../src/output/csv.ts";

function decision(
  partial: Partial<MatchDecision> & Pick<MatchDecision, "acmeId" | "status">,
): MatchDecision {
  return {
    acmeName: "name",
    acmeStatus: "Active",
    acmeType: "Remodel",
    programYear: 2027,
    pulleyId: null,
    reason: "NO_CANDIDATE",
    tier: null,
    candidates: [],
    note: "",
    statusDrift: null,
    ...partial,
  };
}

const decisions: MatchDecision[] = [
  decision({
    acmeId: "2210.1001",
    status: "needs_review",
    reason: "AMBIGUOUS",
    tier: 2,
    note: '2 candidates tie, with "quotes"',
  }),
  decision({ acmeId: "1556.1004", status: "no_match" }),
  decision({
    acmeId: "1556.1002",
    status: "matched",
    pulleyId: "prj_7f3k2q",
    reason: "EXACT_ID",
    tier: 1,
  }),
];

describe("renderMappingCsv", () => {
  it("matches the brief byte for byte, sorted by Acme id", () => {
    expect(renderMappingCsv(decisions)).toBe(
      "acme_pcroject_id,pulley_project_id,status\n1556.1002,prj_7f3k2q,matched\n1556.1004,,no_match\n2210.1001,,needs_review\n",
    );
    expect(MAPPING_COLUMNS).toEqual(["acme_pcroject_id", "pulley_project_id", "status"]);
  });

  it("writes only the header when there are no decisions", () => {
    expect(renderMappingCsv([])).toBe("acme_pcroject_id,pulley_project_id,status\n");
  });
});

describe("renderDecisionsCsv and renderReviewCsv", () => {
  it("quotes fields that need it and fills candidate slots", () => {
    const csv = renderDecisionsCsv(decisions);
    const lines = csv.trimEnd().split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^acme_project_id,acme_name,.*candidate_3_score$/);
    expect(lines[3]).toContain('"2 candidates tie, with ""quotes"""');
  });

  it("neutralizes spreadsheet formulas in free-text cells", () => {
    const rows = [
      decision({
        acmeId: "1556.1002",
        status: "no_match",
        acmeName: "=1+1",
        note: "+cmd|' /C calc'!A0",
      }),
    ];
    const csv = renderDecisionsCsv(rows);
    expect(csv).not.toMatch(/,=1\+1,/);
    expect(csv).toMatch(/,'=1\+1,/);
    expect(csv).toMatch(/,'\+cmd\|' \/C calc'!A0,/);
    const unmatched = renderUnmatchedPulleyCsv({
      unmatchedPulley: [{ id: "prj_a", name: "@SUM(A1)", status: "Draft" }],
    } as unknown as MatchReport);
    expect(unmatched).toMatch(/,'@SUM\(A1\),/);
    expect(renderMappingCsv(rows)).toBe(
      "acme_pcroject_id,pulley_project_id,status\n1556.1002,,no_match\n",
    );
  });

  it("review file contains only needs_review rows", () => {
    const lines = renderReviewCsv(decisions).trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/^2210\.1001,/);
  });
});

describe("renderUnmatchedPulleyCsv", () => {
  it("lists unclaimed projects sorted by id", () => {
    const report = {
      unmatchedPulley: [
        { id: "prj_b", name: "B, Inc", status: "Draft" },
        { id: "prj_a", name: "A", status: "In Progress" },
      ],
    } as unknown as MatchReport;
    expect(renderUnmatchedPulleyCsv(report)).toBe(
      'pulley_project_id,pulley_name,pulley_status\nprj_a,A,In Progress\nprj_b,"B, Inc",Draft\n',
    );
  });
});
