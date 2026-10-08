import type { AcmeProject, NormalizedInputs, PulleyRecord } from "../model.ts";
import {
  acmeState,
  cityMatches,
  isPulleyCanceled,
  sequenceRelation,
  statusesAgree,
  storeContradicts,
  storeMatches,
  typesCompatible,
  typesEqual,
  yearSignal,
} from "./compat.ts";
import {
  type Candidate,
  type Evidence,
  type MatchDecision,
  type MatchReport,
  OutputStatus,
  ReasonCode,
  SequenceRelation,
  Tier,
  YearSignal,
} from "./types.ts";

/**
 * Tiered, deterministic matcher. See docs/MATCHING.md for the rules and
 * docs/adr/0004 for why ambiguity never becomes a guess.
 *
 * For each Acme project:
 *   pool   = Pulley projects that are not pathfinder, not signage, same banner, same state
 *   tier 1 = pool entries whose name carries the full Acme id
 *   tier 2 = pool entries whose name carries the store number (current or former)
 *   tier 3 = no store in the name, but the sequence plus city identify this Acme project uniquely
 *   tier 4 = no store in the name and an exact street match
 *   tier 5 = weak evidence only (street name without house number, or locality + type + year)
 * The first tier with any candidate decides. Within it, candidates are ranked
 * by evidence; a unique best candidate wins, otherwise needs_review.
 */

export function matchProjects(inputs: NormalizedInputs): MatchReport {
  const pool = [...inputs.pulley]
    .filter((p) => !p.isPathfinder && !p.isSignage)
    .sort((a, b) => a.id.localeCompare(b.id));
  const excluded = inputs.pulley.filter((p) => p.isPathfinder || p.isSignage);
  const registerIds = new Set(inputs.acme.map((a) => a.id));
  const context: Context = { pool, excluded, acme: inputs.acme };

  const decisions = inputs.acme.map((acme) => decide(acme, context));

  const matchedPulleyIds = new Set(
    decisions.filter((d) => d.pulleyId !== null).map((d) => d.pulleyId as string),
  );
  const unmatchedPulley = pool
    .filter((p) => !matchedPulleyIds.has(p.id))
    .map((p) => ({ id: p.id, name: p.name, status: p.status }));

  const pulleyIdsNotInRegister = inputs.pulley.flatMap((p) =>
    p.parsedName.fullIds
      .filter((id) => !registerIds.has(id))
      .map((acmeId) => ({ pulleyId: p.id, acmeId })),
  );

  const counts = { matched: 0, needs_review: 0, no_match: 0 };
  const reasons: Record<string, number> = {};
  for (const decision of decisions) {
    counts[decision.status]++;
    reasons[decision.reason] = (reasons[decision.reason] ?? 0) + 1;
  }

  return { decisions, unmatchedPulley, pulleyIdsNotInRegister, counts, reasons };
}

interface Context {
  readonly pool: readonly PulleyRecord[];
  readonly excluded: readonly PulleyRecord[];
  readonly acme: readonly AcmeProject[];
}

// ---------- Per-project decision ----------

function decide(acme: AcmeProject, context: Context): MatchDecision {
  const state = acmeState(acme);
  const scoped = context.pool.filter(
    (p) => p.banner === acme.banner && (state === null || p.state === state),
  );

  const tiers: ReadonlyArray<readonly [Tier, readonly PulleyRecord[]]> = [
    [Tier.ExactId, scoped.filter((p) => p.parsedName.fullIds.includes(acme.id))],
    [Tier.Store, scoped.filter((p) => storeMatches(acme, p))],
    [
      Tier.Sequence,
      scoped.filter(
        (p) => isSequenceCandidate(acme, p) && identifiedAcmeId(p, context.acme) === acme.id,
      ),
    ],
    [Tier.Address, scoped.filter((p) => isAddressCandidate(acme, p))],
    [Tier.Locality, scoped.filter((p) => isWeakCandidate(acme, p))],
  ];

  for (const [tier, records] of tiers) {
    if (records.length === 0) continue;
    const candidates = rank(records.map((p) => toCandidate(acme, p, tier)));
    return tier === Tier.Locality
      ? weakDecision(acme, candidates)
      : strongDecision(acme, candidates, context);
  }

  return noCandidate(acme, context.excluded);
}

/** Name has no store, carries this exact sequence, and sits in this city. */
function isSequenceCandidate(acme: AcmeProject, pulley: PulleyRecord): boolean {
  return (
    pulley.parsedName.storeNumbers.length === 0 &&
    pulley.parsedName.fullIds.length === 0 &&
    sequenceRelation(acme, pulley) === SequenceRelation.Equal &&
    cityMatches(acme, pulley)
  );
}

/**
 * Reverse check for tier 3: a store-less name is only trusted when, across the
 * whole register, exactly one Acme project in that city carries that sequence
 * with a compatible type and no contradicting year. Sequences repeat across
 * stores, so without this a "Proj 1001" could be claimed by two buildings.
 * Returns that project's id, or null when zero or several qualify.
 */
function identifiedAcmeId(pulley: PulleyRecord, register: readonly AcmeProject[]): string | null {
  let found: string | null = null;
  for (const other of register) {
    if (other.banner !== pulley.banner) continue;
    if (!isSequenceCandidate(other, pulley)) continue;
    if (!typesCompatible(other.projectType, pulley.projectType)) continue;
    const year = yearSignal(other, pulley);
    if (year === YearSignal.NameDifferent || year === YearSignal.DateDifferent) continue;
    if (found !== null) return null;
    found = other.id;
  }
  return found;
}

function isAddressCandidate(acme: AcmeProject, pulley: PulleyRecord): boolean {
  return (
    pulley.parsedName.storeNumbers.length === 0 &&
    sequenceRelation(acme, pulley) !== SequenceRelation.Different &&
    pulley.streetKey !== null &&
    pulley.streetKey === acme.site?.streetKey
  );
}

function isWeakCandidate(acme: AcmeProject, pulley: PulleyRecord): boolean {
  if (storeContradicts(acme, pulley)) return false;
  if (pulley.parsedName.fullIds.length > 0) return false;
  if (sequenceRelation(acme, pulley) === SequenceRelation.Different) return false;
  const sameStreetName =
    pulley.streetNameKey !== null && pulley.streetNameKey === acme.site?.streetNameKey;
  const year = yearSignal(acme, pulley);
  const sameLocality =
    cityMatches(acme, pulley) &&
    typesCompatible(acme.projectType, pulley.projectType) &&
    year !== YearSignal.NameDifferent &&
    year !== YearSignal.DateDifferent;
  return sameStreetName || sameLocality;
}

function toCandidate(acme: AcmeProject, pulley: PulleyRecord, tier: Tier): Candidate {
  const evidence: Evidence = {
    exactId: pulley.parsedName.fullIds.includes(acme.id),
    storeMatch: storeMatches(acme, pulley),
    typeCompatible: typesCompatible(acme.projectType, pulley.projectType),
    typeEqual: typesEqual(acme.projectType, pulley.projectType),
    year: yearSignal(acme, pulley),
    sequence: sequenceRelation(acme, pulley),
    streetExact: pulley.streetKey !== null && pulley.streetKey === acme.site?.streetKey,
    streetName: pulley.streetNameKey !== null && pulley.streetNameKey === acme.site?.streetNameKey,
    cityMatch: cityMatches(acme, pulley),
    statusAgree: statusesAgree(acme.status, pulley.status),
  };
  return {
    pulleyId: pulley.id,
    pulleyName: pulley.name,
    pulleyStatus: pulley.status,
    pulleyType: pulley.projectType,
    tier,
    evidence,
    score: scoreEvidence(evidence),
  };
}

/**
 * Evidence weights. Hard exclusions (contradicting store or sequence,
 * excluded plans) never reach scoring; this only orders plausible candidates.
 */
function scoreEvidence(e: Evidence): number {
  let score = 0;
  if (e.exactId) score += 100;
  if (e.sequence === SequenceRelation.Equal) score += 30;
  if (e.sequence === SequenceRelation.Different) score -= 30;
  if (e.typeEqual) score += 20;
  else if (e.typeCompatible) score += 8;
  else score -= 40;
  score += yearWeight(e.year);
  if (e.streetExact) score += 15;
  else if (e.streetName) score += 5;
  if (e.cityMatch) score += 3;
  // Outranks every soft signal (date year, street name, city) but not an
  // exact id, so a live duplicate beats a canceled one and nothing else flips.
  if (e.statusAgree) score += 20;
  return score;
}

function yearWeight(year: YearSignal): number {
  switch (year) {
    case YearSignal.NameEqual:
      return 25;
    case YearSignal.DateEqual:
      return 12;
    case YearSignal.None:
      return 0;
    case YearSignal.DateDifferent:
      return -6;
    case YearSignal.NameDifferent:
      return -35;
  }
}

function rank(candidates: Candidate[]): Candidate[] {
  return candidates.sort((a, b) => b.score - a.score || a.pulleyId.localeCompare(b.pulleyId));
}

/** Tiers 1 to 4: a unique best candidate with compatible type and agreeing status is matched. */
function strongDecision(
  acme: AcmeProject,
  candidates: readonly Candidate[],
  context: Context,
): MatchDecision {
  const top = candidates[0];
  if (!top) return noCandidate(acme, context.excluded);
  const tier = top.tier;
  const tied = candidates.filter((c) => c.score === top.score);
  const live = tied.filter((c) => !isPulleyCanceled(c.pulleyStatus));
  const winner = tied.length === 1 ? top : live.length === 1 ? live[0] : undefined;

  if (!winner) {
    return review(
      acme,
      candidates,
      tier,
      ReasonCode.Ambiguous,
      `${tied.length} candidates tie on evidence in tier ${tier}`,
    );
  }
  if (!winner.evidence.typeCompatible) {
    return unrelatedOrMismatch(acme, candidates, winner, tier);
  }
  if (!winner.evidence.statusAgree) {
    return review(
      acme,
      candidates,
      tier,
      ReasonCode.StatusConflict,
      `Acme is ${acme.status}, Pulley ${winner.pulleyId} is ${winner.pulleyStatus}`,
    );
  }
  return {
    ...base(acme, [winner, ...candidates.filter((c) => c !== winner)], tier),
    status: OutputStatus.Matched,
    pulleyId: winner.pulleyId,
    reason: reasonForTier(tier),
    note: describeWinner(winner),
  };
}

/**
 * An incompatible type is a review item unless the candidate is explicitly
 * another Acme line (different sequence) or another year, in which case
 * nothing at this store relates and the honest answer is no_match.
 */
function unrelatedOrMismatch(
  acme: AcmeProject,
  candidates: readonly Candidate[],
  winner: Candidate,
  tier: Tier,
): MatchDecision {
  const explicitlyOther = candidates.every(
    (c) =>
      !c.evidence.typeCompatible &&
      (c.evidence.sequence === SequenceRelation.Different ||
        c.evidence.year === YearSignal.NameDifferent ||
        c.evidence.year === YearSignal.DateDifferent),
  );
  if (explicitlyOther) {
    const listed = candidates.map((c) => `${c.pulleyId} (${c.pulleyType})`).join(", ");
    return {
      ...base(acme, candidates, tier),
      status: OutputStatus.NoMatch,
      pulleyId: null,
      reason: ReasonCode.UnrelatedOnly,
      note: `only other lines at this store: ${listed}`,
    };
  }
  return review(
    acme,
    candidates,
    tier,
    ReasonCode.TypeMismatch,
    `best candidate ${winner.pulleyId} is ${winner.pulleyType}; Acme line is ${acme.projectType}`,
  );
}

/** Tier 5 never matches; it surfaces the likely answer for a human. */
function weakDecision(acme: AcmeProject, candidates: readonly Candidate[]): MatchDecision {
  return review(
    acme,
    candidates,
    Tier.Locality,
    ReasonCode.WeakEvidence,
    `${candidates.length} candidate(s) on weak evidence only (${describeWinner(candidates[0])})`,
  );
}

function noCandidate(acme: AcmeProject, excluded: readonly PulleyRecord[]): MatchDecision {
  const onlyExcluded = excluded.filter(
    (p) => p.parsedName.fullIds.includes(acme.id) || storeMatches(acme, p),
  );
  if (onlyExcluded.length > 0) {
    const what = onlyExcluded
      .map((p) => `${p.id} (${p.isPathfinder ? "pathfinder" : "signage"})`)
      .join(", ");
    return {
      ...base(acme, [], null),
      status: OutputStatus.NoMatch,
      pulleyId: null,
      reason: ReasonCode.ExcludedOnly,
      note: `only ${what} reference this project; excluded by the brief`,
    };
  }
  return {
    ...base(acme, [], null),
    status: OutputStatus.NoMatch,
    pulleyId: null,
    reason: ReasonCode.NoCandidate,
    note: "no Pulley project carries this id, store, sequence, or address",
  };
}

function review(
  acme: AcmeProject,
  candidates: readonly Candidate[],
  tier: Tier,
  reason: ReasonCode,
  note: string,
): MatchDecision {
  return {
    ...base(acme, candidates, tier),
    status: OutputStatus.NeedsReview,
    pulleyId: null,
    reason,
    note,
  };
}

function reasonForTier(tier: Tier): ReasonCode {
  switch (tier) {
    case Tier.ExactId:
      return ReasonCode.ExactId;
    case Tier.Store:
      return ReasonCode.StoreTypeYear;
    case Tier.Sequence:
      return ReasonCode.SequenceLocality;
    case Tier.Address:
      return ReasonCode.Address;
    case Tier.Locality:
      return ReasonCode.WeakEvidence;
  }
}

function base(
  acme: AcmeProject,
  candidates: readonly Candidate[],
  tier: Tier | null,
): Pick<
  MatchDecision,
  "acmeId" | "acmeName" | "acmeStatus" | "acmeType" | "programYear" | "candidates" | "tier"
> {
  return {
    acmeId: acme.id,
    acmeName: acme.name,
    acmeStatus: acme.status,
    acmeType: acme.projectType,
    programYear: acme.programYear,
    candidates: candidates.slice(0, 5),
    tier,
  };
}

function describeWinner(candidate: Candidate | undefined): string {
  if (!candidate) return "no candidate";
  const e = candidate.evidence;
  const parts: string[] = [];
  if (e.exactId) parts.push("exact id");
  else if (e.storeMatch) parts.push("store");
  if (e.typeEqual) parts.push("same type");
  else if (e.typeCompatible) parts.push("compatible type");
  if (e.year === YearSignal.NameEqual) parts.push("year in name");
  else if (e.year === YearSignal.DateEqual) parts.push("year by date");
  if (e.sequence === SequenceRelation.Equal) parts.push("sequence");
  if (e.streetExact) parts.push("street");
  else if (e.streetName) parts.push("street name");
  if (e.cityMatch) parts.push("city");
  return `${candidate.pulleyId}: ${parts.join(", ") || "no supporting evidence"}`;
}
