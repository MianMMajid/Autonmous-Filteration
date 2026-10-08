import type { MatchDecision, OutputStatus } from "../domain/match/types.ts";

/**
 * Change report between two runs. Someone running the sync three times a
 * day wants to know what moved, not re-read 400 rows.
 */

export interface PreviousDecision {
  readonly acmeId: string;
  readonly status: OutputStatus;
  readonly pulleyId: string | null;
}

export interface DecisionChange {
  readonly acmeId: string;
  readonly from: { readonly status: OutputStatus; readonly pulleyId: string | null };
  readonly to: { readonly status: OutputStatus; readonly pulleyId: string | null };
  readonly kind: "newly_matched" | "lost_match" | "rematched" | "status_changed";
}

export interface RunDiff {
  readonly previousRunId: string | null;
  readonly changes: readonly DecisionChange[];
  readonly newAcmeIds: readonly string[];
  readonly removedAcmeIds: readonly string[];
  readonly counts: {
    readonly newlyMatched: number;
    readonly lostMatch: number;
    readonly rematched: number;
    readonly statusChanged: number;
  };
}

export function diffRuns(
  previous: { runId: string; decisions: readonly PreviousDecision[] } | null,
  current: readonly MatchDecision[],
): RunDiff {
  if (!previous) {
    return {
      previousRunId: null,
      changes: [],
      newAcmeIds: [],
      removedAcmeIds: [],
      counts: { newlyMatched: 0, lostMatch: 0, rematched: 0, statusChanged: 0 },
    };
  }

  const before = new Map(previous.decisions.map((d) => [d.acmeId, d]));
  const after = new Map(current.map((d) => [d.acmeId, d]));
  const changes: DecisionChange[] = [];
  const counts = { newlyMatched: 0, lostMatch: 0, rematched: 0, statusChanged: 0 };

  for (const [acmeId, now] of [...after.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const was = before.get(acmeId);
    if (!was) continue;
    if (was.status === now.status && was.pulleyId === now.pulleyId) continue;
    const kind = classify(was, now);
    changes.push({
      acmeId,
      from: { status: was.status, pulleyId: was.pulleyId },
      to: { status: now.status, pulleyId: now.pulleyId },
      kind,
    });
    if (kind === "newly_matched") counts.newlyMatched++;
    else if (kind === "lost_match") counts.lostMatch++;
    else if (kind === "rematched") counts.rematched++;
    else counts.statusChanged++;
  }

  return {
    previousRunId: previous.runId,
    changes,
    newAcmeIds: [...after.keys()].filter((id) => !before.has(id)).sort(),
    removedAcmeIds: [...before.keys()].filter((id) => !after.has(id)).sort(),
    counts,
  };
}

function classify(was: PreviousDecision, now: PreviousDecision): DecisionChange["kind"] {
  if (was.status !== "matched" && now.status === "matched") return "newly_matched";
  if (was.status === "matched" && now.status !== "matched") return "lost_match";
  if (was.status === "matched" && now.status === "matched") return "rematched";
  return "status_changed";
}
