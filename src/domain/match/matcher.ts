import type { AcmeProject, NormalizedInputs, PulleyRecord } from "../model.ts";
import {
  acmeState,
  acmeStoreNumbers,
  cityMatches,
  dateProximityDays,
  isPulleyCanceled,
  sequenceRelation,
  statusesAgree,
  storeContradicts,
  storeMatches,
  Temporal,
  temporalVerdict,
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
 *   tier 5 = no store in the name, dates within a week of the Key Dates in the same city, unique
 *   tier 6 = weak evidence only (street name without house number, or locality + type + year)
 * Tiers 2 to 5 drop candidates whose dates place them in another year: the
 * brief folds several Acme lines into one permit only for the same store
 * and the same year. The first tier with any candidate decides. Within it,
 * candidates are ranked by evidence; a unique best candidate wins, otherwise
 * needs_review.
 */

export function matchProjects(inputs: NormalizedInputs): MatchReport {
  const pool = [...inputs.pulley]
    .filter((p) => !p.isPathfinder && !p.isSignage)
    .sort((a, b) => a.id.localeCompare(b.id));
  const excluded = inputs.pulley.filter((p) => p.isPathfinder || p.isSignage);
  const registerIds = knownAcmeIds(inputs.acme);
  const context: Context = {
    pool,
    excluded,
    acme: inputs.acme,
    sharedNumbers: numbersSharedByBuildings(inputs),
  };

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

/**
 * Register ids plus their renumbered-store aliases: a Pulley name citing
 * `6414.1004` is not "unknown" when store 6414 is the former number of a
 * site whose register row is now `NEW.1004`.
 */
function knownAcmeIds(register: readonly AcmeProject[]): Set<string> {
  const ids = new Set<string>();
  for (const acme of register) {
    ids.add(acme.id);
    const former = acme.site?.formerLocationNumber;
    if (former !== null && former !== undefined) ids.add(`${former}.${acme.sequence}`);
  }
  return ids;
}

/**
 * Store numbers that identify more than one building, because one site's
 * former number is another site's current number. A name carrying such a
 * number needs locality corroboration before it counts as a store match.
 */
function numbersSharedByBuildings(inputs: NormalizedInputs): Set<number> {
  const shared = new Set<number>();
  for (const [number, sites] of inputs.sitesByLocation) {
    if (new Set(sites.map((s) => s.siteId)).size > 1) shared.add(number);
  }
  return shared;
}

interface Context {
  readonly pool: readonly PulleyRecord[];
  readonly excluded: readonly PulleyRecord[];
  readonly acme: readonly AcmeProject[];
  readonly sharedNumbers: ReadonlySet<number>;
}

// ---------- Per-project decision ----------

function decide(acme: AcmeProject, context: Context): MatchDecision {
  const state = acmeState(acme);
  const scoped = context.pool.filter(
    (p) => p.banner === acme.banner && (state === null || p.state === state),
  );
  const sameYear = (p: PulleyRecord): boolean => temporalVerdict(acme, p) !== Temporal.Conflict;

  const storeAll = scoped.filter((p) => isStoreCandidate(acme, p, context.sharedNumbers));
  const tiers: ReadonlyArray<readonly [Tier, readonly PulleyRecord[]]> = [
    [Tier.ExactId, scoped.filter((p) => p.parsedName.fullIds.includes(acme.id))],
    [Tier.Store, storeAll.filter(sameYear)],
    [
      Tier.Sequence,
      scoped.filter(
        (p) =>
          isSequenceCandidate(acme, p) &&
          sameYear(p) &&
          identifiedAcmeId(p, context.acme) === acme.id,
      ),
    ],
    [Tier.Address, scoped.filter((p) => isAddressCandidate(acme, p) && sameYear(p))],
    [
      Tier.Dates,
      scoped.filter(
        (p) => isDateCandidate(acme, p) && identifiedAcmeIdByDates(p, context.acme) === acme.id,
      ),
    ],
  ];

  for (const [tier, records] of tiers) {
    if (records.length === 0) continue;
    const candidates = rank(records.map((p) => toCandidate(acme, p, tier)));
    return strongDecision(acme, candidates, context);
  }

  if (storeAll.length > 0) {
    // Projects at this store exist but all belong to another year: a
    // different permit. More honest than a weak locality guess.
    const candidates = rank(storeAll.map((p) => toCandidate(acme, p, Tier.Store)));
    return unrelated(acme, candidates, "other-year");
  }

  const weak = scoped.filter((p) => isWeakCandidate(acme, p) && sameYear(p));
  if (weak.length > 0) {
    return weakDecision(acme, rank(weak.map((p) => toCandidate(acme, p, Tier.Locality))));
  }
  return noCandidate(acme, context.excluded);
}

/** Store number in the name identifies this building (and, for shared numbers, the locality agrees). */
function isStoreCandidate(
  acme: AcmeProject,
  pulley: PulleyRecord,
  sharedNumbers: ReadonlySet<number>,
): boolean {
  if (!storeMatches(acme, pulley)) return false;
  const mine = acmeStoreNumbers(acme);
  const viaShared = pulley.parsedName.storeNumbers.every(
    (n) => !mine.includes(n) || sharedNumbers.has(n),
  );
  if (!viaShared) return true;
  const streetAgrees =
    (pulley.streetKey !== null && pulley.streetKey === acme.site?.streetKey) ||
    (pulley.streetNameKey !== null && pulley.streetNameKey === acme.site?.streetNameKey);
  return cityMatches(acme, pulley) || streetAgrees;
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
    if (temporalVerdict(other, pulley) === Temporal.Conflict) continue;
    if (found !== null) return null;
    found = other.id;
  }
  return found;
}

const SAME_DATES_DAYS = 7;

/**
 * Name has no store or full id, sits in this city, type is compatible, and a
 * milestone date lands within a week of the Acme Key Date. Pulley dates are
 * the Acme dates with small jitter (see `dateProximityDays`), so this is
 * strong evidence once the reverse uniqueness check passes.
 */
function isDateCandidate(acme: AcmeProject, pulley: PulleyRecord): boolean {
  const gap = dateProximityDays(acme, pulley);
  return (
    pulley.parsedName.storeNumbers.length === 0 &&
    pulley.parsedName.fullIds.length === 0 &&
    sequenceRelation(acme, pulley) !== SequenceRelation.Different &&
    gap !== null &&
    gap <= SAME_DATES_DAYS &&
    cityMatches(acme, pulley) &&
    typesCompatible(acme.projectType, pulley.projectType)
  );
}

function identifiedAcmeIdByDates(
  pulley: PulleyRecord,
  register: readonly AcmeProject[],
): string | null {
  let found: string | null = null;
  for (const other of register) {
    if (other.banner !== pulley.banner) continue;
    if (!isDateCandidate(other, pulley)) continue;
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
  const sameLocality =
    cityMatches(acme, pulley) && typesCompatible(acme.projectType, pulley.projectType);
  return sameStreetName || sameLocality;
}

function toCandidate(acme: AcmeProject, pulley: PulleyRecord, tier: Tier): Candidate {
  const evidence: Evidence = {
    exactId: pulley.parsedName.fullIds.includes(acme.id),
    storeMatch: storeMatches(acme, pulley),
    proximityDays: dateProximityDays(acme, pulley),
    temporal: temporalVerdict(acme, pulley),
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
 * another year, excluded plans) never reach scoring; this only orders
 * plausible candidates. See docs/MATCHING.md, "Scoring".
 */
function scoreEvidence(e: Evidence): number {
  let score = 0;
  if (e.exactId) score += 100;
  if (e.sequence === SequenceRelation.Equal) score += 30;
  if (e.sequence === SequenceRelation.Different) score -= 30;
  if (e.typeEqual) score += 20;
  else if (e.typeCompatible) score += 8;
  else score -= 40;
  score += temporalWeight(e);
  if (e.streetExact) score += 15;
  else if (e.streetName) score += 5;
  if (e.cityMatch) score += 3;
  // Outranks every soft signal (near dates, street name, city) but not an
  // exact id or exact dates, so a live duplicate beats a canceled one.
  if (e.statusAgree) score += 20;
  return score;
}

function temporalWeight(e: Evidence): number {
  if (e.proximityDays !== null && e.proximityDays <= 7) return 45;
  switch (e.temporal) {
    case Temporal.Same:
      return 30;
    case Temporal.Near:
      return 8;
    case Temporal.Unknown:
      return 0;
    case Temporal.Conflict:
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
 * An incompatible type is a review item unless every candidate is explicitly
 * another Acme line (different sequence), in which case nothing at this
 * store relates and the honest answer is no_match.
 */
function unrelatedOrMismatch(
  acme: AcmeProject,
  candidates: readonly Candidate[],
  winner: Candidate,
  tier: Tier,
): MatchDecision {
  const explicitlyOther = candidates.every(
    (c) => !c.evidence.typeCompatible && c.evidence.sequence === SequenceRelation.Different,
  );
  if (explicitlyOther) return unrelated(acme, candidates, "other-line");
  return review(
    acme,
    candidates,
    tier,
    ReasonCode.TypeMismatch,
    `best candidate ${winner.pulleyId} is ${winner.pulleyType}; Acme line is ${acme.projectType}`,
  );
}

function unrelated(
  acme: AcmeProject,
  candidates: readonly Candidate[],
  kind: "other-line" | "other-year",
): MatchDecision {
  const listed = candidates
    .map(
      (c) =>
        `${c.pulleyId} (${c.pulleyType}${c.evidence.proximityDays !== null ? `, dates ${Math.round(c.evidence.proximityDays)}d apart` : ""})`,
    )
    .join(", ");
  return {
    ...base(acme, candidates, Tier.Store),
    status: OutputStatus.NoMatch,
    pulleyId: null,
    reason: ReasonCode.UnrelatedOnly,
    note:
      kind === "other-line"
        ? `only other lines at this store: ${listed}`
        : `only other years' work at this store: ${listed}`,
  };
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
    case Tier.Dates:
      return ReasonCode.DateLocality;
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
  if (e.proximityDays !== null && e.proximityDays <= 7) parts.push("same dates");
  else if (e.temporal === Temporal.Same) parts.push("same year");
  else if (e.temporal === Temporal.Near) parts.push("near dates");
  if (e.sequence === SequenceRelation.Equal) parts.push("sequence");
  if (e.streetExact) parts.push("street");
  else if (e.streetName) parts.push("street name");
  if (e.cityMatch) parts.push("city");
  return `${candidate.pulleyId}: ${parts.join(", ") || "no supporting evidence"}`;
}
