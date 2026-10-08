import { isInScope, statusesAgree } from "../domain/match/compat.ts";
import type { MatchDecision } from "../domain/match/types.ts";
import type { AcmeProject, PulleyRecord } from "../domain/model.ts";
import { ExitCode, SyncError } from "../errors.ts";

/**
 * The publication boundary. Whatever path produced a decision (matcher,
 * assignment pass, override), the combined result must satisfy the brief's
 * hard rules before anything is written. A violation here is a bug in this
 * tool, not a data problem, and nothing is published.
 */

export class InvariantError extends SyncError {
  constructor(message: string, options?: { readonly details?: Readonly<Record<string, unknown>> }) {
    super(message, ExitCode.Invariant, options);
  }
}

export function assertPublicationInvariants(
  decisions: readonly MatchDecision[],
  acme: readonly AcmeProject[],
  pulley: readonly PulleyRecord[],
): void {
  const violations = [
    ...oneDecisionPerProject(decisions, acme),
    ...targetsAreValid(decisions, acme, pulley),
    ...onePermitOneBuildingOneYear(decisions, acme),
  ];
  if (violations.length > 0) {
    throw new InvariantError(
      `Refusing to publish: ${violations.length} invariant violation(s). This is a defect in the tool; nothing was written.`,
      { details: { violations: violations.slice(0, 20) } },
    );
  }
}

function oneDecisionPerProject(
  decisions: readonly MatchDecision[],
  acme: readonly AcmeProject[],
): string[] {
  const out: string[] = [];
  const ids = new Set(acme.map((a) => a.id));
  const seen = new Set<string>();
  for (const d of decisions) {
    if (seen.has(d.acmeId)) out.push(`${d.acmeId} has more than one decision`);
    seen.add(d.acmeId);
    if (!ids.has(d.acmeId)) out.push(`${d.acmeId} is not in the register`);
  }
  for (const id of ids) if (!seen.has(id)) out.push(`${id} has no decision`);
  return out;
}

function targetsAreValid(
  decisions: readonly MatchDecision[],
  acme: readonly AcmeProject[],
  pulley: readonly PulleyRecord[],
): string[] {
  const out: string[] = [];
  const acmeById = new Map(acme.map((a) => [a.id, a]));
  const pulleyById = new Map(pulley.map((p) => [p.id, p]));
  for (const d of decisions) {
    const a = acmeById.get(d.acmeId);
    if (d.status !== "matched") {
      if (d.pulleyId !== null)
        out.push(`${d.acmeId} is ${d.status} but carries target ${d.pulleyId}`);
      continue;
    }
    const target = d.pulleyId === null ? undefined : pulleyById.get(d.pulleyId);
    if (!target || !a) {
      out.push(`${d.acmeId} is matched but has no valid target`);
      continue;
    }
    if (!isInScope(a, target)) out.push(`${d.acmeId} is matched outside its scope to ${target.id}`);
    if (!statusesAgree(a.status, target.status)) {
      out.push(`${d.acmeId} is matched to ${target.id} against the status gate`);
    }
    if (a.identityDisputed) out.push(`${d.acmeId} is matched while its identity is disputed`);
  }
  return out;
}

function onePermitOneBuildingOneYear(
  decisions: readonly MatchDecision[],
  acme: readonly AcmeProject[],
): string[] {
  const acmeById = new Map(acme.map((a) => [a.id, a]));
  const claims = new Map<string, Set<string>>();
  for (const d of decisions) {
    if (d.status !== "matched" || d.pulleyId === null) continue;
    const a = acmeById.get(d.acmeId);
    const key = `${a?.siteId}|${a?.programYear}`;
    claims.set(d.pulleyId, new Set([...(claims.get(d.pulleyId) ?? []), key]));
  }
  return [...claims.entries()]
    .filter(([, keys]) => keys.size > 1)
    .map(
      ([pulleyId, keys]) =>
        `${pulleyId} is assigned to more than one building or year: ${[...keys].join(", ")}`,
    );
}
