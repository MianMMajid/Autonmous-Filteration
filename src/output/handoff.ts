import type { MatchReport } from "../domain/match/types.ts";

/** Counts and provenance come from the same run as mapping.csv, never copied from docs. */
export function renderHandoff(input: {
  readonly runId: string;
  readonly sourceArchiveId: string;
  readonly sourceAcquiredAt: string;
  readonly source: string;
  readonly rulesVersion: string;
  readonly implementationSha256: string;
  readonly report: MatchReport;
}): string {
  const { matched, needs_review: review, no_match: noMatch } = input.report.counts;
  const total = matched + review + noMatch;
  const coverage = total
    ? `${((100 * matched) / total).toFixed(2)}%`
    : "not applicable (empty input)";
  return `# Permit Ops handoff

Run: ${input.runId}
Source archive: ${input.sourceArchiveId}
Source acquired: ${input.sourceAcquiredAt} (${input.source})
Matching rules: ${input.rulesVersion}
Implementation SHA-256: ${input.implementationSha256}

## Files and results

Submit mapping.csv from this directory. Its exact columns are
acme_pcroject_id,pulley_project_id,status. This run has ${total} rows:
${matched} matched, ${review} needing review, and ${noMatch} with no match.
Automatic matching plus applied human decisions cover ${coverage} of rows.
Coverage is not an estimate of correctness. Supply the accompanying reviewed
sample/validation report before claiming an estimated correct percentage;
this run alone cannot determine it. Overrides are identified in decisions.csv.

review.csv contains the full unresolved backlog. review-changes.csv is only
the change since the preceding run; it is not a weekly unread queue. Check
recommended_action before recording a decision in overrides.csv. Source
identity, scope, status and shared-permit constraints still apply to reviewers.

## Draft response to the Account Lead (not sent)

Hi! The tool downloads the SiteLedger reports and Pulley projects, then creates
the mapping CSV and an explained review list. Run pnpm sync for updated data.
This snapshot has ${matched} matched rows, ${review} needing review and ${noMatch}
with no match. Verified review decisions can be retained for subsequent runs.
We should resolve the initial backlog and measure new cases on updated data
before promising only a few reviews per week. Scheduling support is included;
its deployment and monitoring need to be configured and demonstrated.
Could we meet for 30 minutes to review the results and onboard your team?

## Reproduction

Use the implementation and overrides snapshot recorded with this run to replay
source archive ${input.sourceArchiveId}. A replay does not fetch fresh upstream
data. Do not combine this CSV with counts or accuracy claims from another run.
`;
}
