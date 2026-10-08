import { createHash } from "node:crypto";
import type { MatchDecision } from "../domain/match/types.ts";
import type { PreviousDecision } from "./diff.ts";

/** Stable across object-key and candidate ordering; includes all review evidence. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function reviewFingerprint(decision: MatchDecision): string {
  return createHash("sha256")
    .update(
      canonical({
        ...decision,
        candidates: [...decision.candidates].sort((a, b) => a.pulleyId.localeCompare(b.pulleyId)),
      }),
    )
    .digest("hex");
}

export interface ReviewWorkload {
  readonly fresh: readonly MatchDecision[];
  readonly changed: readonly MatchDecision[];
  readonly unchanged: readonly MatchDecision[];
  readonly resolved: readonly string[];
  readonly removed: readonly string[];
}

/** A run-to-run delta, never a substitute for the unresolved review backlog. */
export function reviewWorkload(
  previous: readonly PreviousDecision[] | null,
  current: readonly MatchDecision[],
): ReviewWorkload {
  const before = new Map((previous ?? []).map((d) => [d.acmeId, d]));
  const after = new Map(current.map((d) => [d.acmeId, d]));
  const fresh: MatchDecision[] = [],
    changed: MatchDecision[] = [],
    unchanged: MatchDecision[] = [];
  for (const decision of current) {
    if (decision.status !== "needs_review") continue;
    const old = before.get(decision.acmeId);
    if (old?.status !== "needs_review") fresh.push(decision);
    // Legacy records have no fingerprint; surface them once, never assume unchanged.
    else if (old.reviewFingerprint !== reviewFingerprint(decision)) changed.push(decision);
    else unchanged.push(decision);
  }
  const resolved: string[] = [],
    removed: string[] = [];
  for (const old of before.values()) {
    if (old.status !== "needs_review") continue;
    const now = after.get(old.acmeId);
    if (!now) removed.push(old.acmeId);
    else if (now.status !== "needs_review") resolved.push(old.acmeId);
  }
  return { fresh, changed, unchanged, resolved: resolved.sort(), removed: removed.sort() };
}
