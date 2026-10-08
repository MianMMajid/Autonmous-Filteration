import type { AcmeProject, NormalizedInputs, PulleyRecord } from "../model.ts";
import {
  acmeLifecycle,
  acmeState,
  acmeStoreNumbers,
  cityMatches,
  dateProximityDays,
  isInScope,
  isPulleyCanceled,
  StatusVerdict,
  sequenceRelation,
  statusDrift,
  statusesAgree,
  statusVerdict,
  storeContradicts,
  storeMatches,
  Temporal,
  temporalVerdict,
  typesCompatible,
  typesEqual,
  yearSignal,
} from "./compat.ts";
import { acmeNameIssue, matchSafetyIssue } from "./safety.ts";
import { createSafetyIndex, type SafetyIndex } from "./safety-index.ts";
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

/**
 * Bump when a rule, weight, or tier changes. Recorded in run.json so a
 * historical decision can be attributed to the rules that produced it.
 */
export const RULES_VERSION = "2026-10-08.9";

export function matchProjects(inputs: NormalizedInputs): MatchReport {
  const pool = [...inputs.pulley]
    .filter((p) => !p.isPathfinder && !p.isSignage)
    .sort((a, b) => a.id.localeCompare(b.id));
  const excluded = inputs.pulley.filter((p) => p.isPathfinder || p.isSignage);
  const registerIds = knownAcmeIds(inputs.acme);
  const context: Context = {
    pool,
    safety: createSafetyIndex(inputs.acme, pool),
    pulleyById: new Map(pool.map((p) => [p.id, p])),
    excluded,
    acme: inputs.acme,
    sharedNumbers: numbersSharedByBuildings(inputs),
    sharedStreets: streetsSharedBySites(inputs),
    sequenceOwner: new Map(),
    dateOwner: new Map(),
  };

  const decisions = resolveYearConflicts(
    inputs.acme.map((acme) => decide(acme, context)),
    inputs.acme,
  );

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
  let drift = 0;
  for (const decision of decisions) {
    counts[decision.status]++;
    reasons[decision.reason] = (reasons[decision.reason] ?? 0) + 1;
    if (decision.statusDrift !== null) drift++;
  }

  return {
    decisions,
    unmatchedPulley,
    pulleyIdsNotInRegister,
    counts,
    reasons,
    statusDrift: drift,
  };
}

/**
 * Post-pass. The brief folds several Acme lines into one permit only for
 * the same store and the same year. When one Pulley project ends up claimed
 * by lines from different program years (possible when the project has no
 * dates to conflict with), keep the claims with strong evidence (exact id,
 * or dates within a week) and send the others to review. With no strong
 * claim, no building/year is guessed: every claim goes to review.
 */
function resolveYearConflicts(
  decisions: readonly MatchDecision[],
  register: readonly AcmeProject[],
): MatchDecision[] {
  const yearOf = new Map(register.map((a) => [a.id, a.programYear]));
  const siteOf = new Map(register.map((a) => [a.id, a.siteId]));
  const claims = new Map<string, MatchDecision[]>();
  for (const d of decisions) {
    if (d.status !== OutputStatus.Matched || d.pulleyId === null) continue;
    claims.set(d.pulleyId, [...(claims.get(d.pulleyId) ?? []), d]);
  }
  const demoted = new Map<string, MatchDecision>();
  for (const [pulleyId, group] of claims) {
    const keyOf = (d: MatchDecision): string => `${siteOf.get(d.acmeId)}|${yearOf.get(d.acmeId)}`;
    if (new Set(group.map(keyOf)).size < 2) continue;
    const keep = anchorKeys(group, keyOf);
    for (const d of group) {
      if (keep.has(keyOf(d))) continue;
      const others = group
        .filter((o) => o !== d)
        .map((o) => `${o.acmeId} (${yearOf.get(o.acmeId)})`)
        .join(", ");
      demoted.set(d.acmeId, {
        ...d,
        status: OutputStatus.NeedsReview,
        pulleyId: null,
        reason: ReasonCode.YearConflict,
        statusDrift: null,
        note: `${pulleyId} is also claimed by ${others}; one permit covers one year`,
      });
    }
  }
  return decisions.map((d) => demoted.get(d.acmeId) ?? d);
}

/**
 * Which site-and-year keys may keep a shared Pulley project. The full id
 * written in the name pins the project to that line; exact dates are next;
 * otherwise nothing anchors. Ranking evidence alone cannot choose between
 * buildings or program years, so input order can never pick a winner.
 */
function anchorKeys(
  group: readonly MatchDecision[],
  keyOf: (d: MatchDecision) => string,
): Set<string> {
  // Anchors of equal strength that disagree with each other anchor nothing:
  // the dispute goes to review instead of letting both years through.
  const single = (claims: readonly MatchDecision[]): Set<string> => {
    const keys = new Set(claims.map(keyOf));
    return keys.size === 1 ? keys : new Set();
  };
  const byId = group.filter((d) => d.tier === Tier.ExactId);
  if (byId.length > 0) return single(byId);
  const byDates = group.filter(isStrongClaim);
  if (byDates.length > 0) return single(byDates);
  return new Set();
}

function isStrongClaim(d: MatchDecision): boolean {
  const e = d.candidates[0]?.evidence;
  return d.tier === Tier.ExactId || (e?.proximityDays != null && e.proximityDays <= 7);
}

/** Street keys that belong to more than one site; an address match there needs city agreement. */
function streetsSharedBySites(inputs: NormalizedInputs): Set<string> {
  const seen = new Map<string, number>();
  for (const site of inputs.sites) {
    if (site.streetKey === null) continue;
    const key = collisionKey(site.banner, site.state, site.streetKey);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return new Set([...seen.entries()].filter(([, n]) => n > 1).map(([key]) => key));
}

/** Collisions only matter among buildings that could compete: same banner and state. */
function collisionKey(banner: string | null, state: string | null, what: string | number): string {
  return `${banner ?? "?"}|${state ?? "?"}|${what}`;
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
function numbersSharedByBuildings(inputs: NormalizedInputs): Set<string> {
  const shared = new Set<string>();
  for (const [number, sites] of inputs.sitesByLocation) {
    const byScope = new Map<string, Set<string>>();
    for (const site of sites) {
      const key = collisionKey(site.banner, site.state, number);
      byScope.set(key, new Set([...(byScope.get(key) ?? []), site.siteId]));
    }
    for (const [key, ids] of byScope) if (ids.size > 1) shared.add(key);
  }
  return shared;
}

interface Context {
  readonly safety: SafetyIndex;
  readonly pulleyById: ReadonlyMap<string, PulleyRecord>;
  readonly pool: readonly PulleyRecord[];
  readonly excluded: readonly PulleyRecord[];
  readonly acme: readonly AcmeProject[];
  /** `banner|state|number` keys that identify more than one building in that scope. */
  readonly sharedNumbers: ReadonlySet<string>;
  /** `banner|state|streetKey` keys shared by more than one site in that scope. */
  readonly sharedStreets: ReadonlySet<string>;
  /** Memo: which Acme id (if exactly one) a store-less Pulley name identifies by sequence and city. */
  readonly sequenceOwner: Map<string, string | null>;
  /** Memo: which Acme id (if exactly one) a store-less Pulley name identifies by dates and city. */
  readonly dateOwner: Map<string, string | null>;
}

/** The uniqueness checks depend only on the Pulley record and the register, so compute each once. */
function memo(
  cache: Map<string, string | null>,
  pulley: PulleyRecord,
  compute: () => string | null,
): string | null {
  const cached = cache.get(pulley.id);
  if (cached !== undefined) return cached;
  const value = compute();
  cache.set(pulley.id, value);
  return value;
}

// ---------- Per-project decision ----------

function decide(acme: AcmeProject, context: Context): MatchDecision {
  const decision = decideFromEvidence(acme, context);
  const sourceIssue = acme.identityDisputed ?? acmeNameIssue(acme);
  if (sourceIssue === null) return decision;
  // Contradictory source rows must never raise confidence: hold the row.
  return review(
    acme,
    decision.candidates,
    decision.tier ?? Tier.ExactId,
    ReasonCode.IdentityDisputed,
    `${sourceIssue}; provisional outcome ${decision.status}${decision.pulleyId ? `; would otherwise match ${decision.pulleyId}` : ""}`,
  );
}

function decideFromEvidence(acme: AcmeProject, context: Context): MatchDecision {
  const state = acmeState(acme);
  const sameYear = (p: PulleyRecord): boolean => temporalVerdict(acme, p) !== Temporal.Conflict;

  const exact = context.safety
    .exactCandidates(acme)
    .filter((p) => isExactIdCandidate(acme, p, context.sharedNumbers));
  if (exact.length > 0)
    return strongDecision(
      acme,
      rank(exact.map((p) => toCandidate(acme, p, Tier.ExactId))),
      context,
    );
  const storeAll = context.safety
    .storeCandidates(acme)
    .filter((p) => isStoreCandidate(acme, p, context.sharedNumbers));
  const sameYearStores = storeAll.filter(sameYear);
  if (sameYearStores.length > 0)
    return strongDecision(
      acme,
      rank(sameYearStores.map((p) => toCandidate(acme, p, Tier.Store))),
      context,
    );
  // Only fallback tiers need the broad scoped pool. Common ID/store matches
  // should not scan every unrelated permit (or calculate lower-tier uniqueness).
  const scoped = context.pool.filter((p) => isInScope(acme, p));
  const tiers: ReadonlyArray<readonly [Tier, readonly PulleyRecord[]]> = [
    [
      Tier.Sequence,
      scoped.filter(
        (p) =>
          isSequenceCandidate(acme, p) &&
          sameYear(p) &&
          memo(context.sequenceOwner, p, () => identifiedAcmeId(p, context.acme)) === acme.id,
      ),
    ],
    [
      Tier.Address,
      scoped.filter((p) => isAddressCandidate(acme, p, context.sharedStreets) && sameYear(p)),
    ],
    [
      Tier.Dates,
      scoped.filter(
        (p) =>
          isDateCandidate(acme, p) &&
          sameYear(p) &&
          memo(context.dateOwner, p, () => identifiedAcmeIdByDates(p, context.acme)) === acme.id,
      ),
    ],
  ];

  for (const [tier, records] of tiers) {
    if (records.length === 0) continue;
    const candidates = rank(records.map((p) => toCandidate(acme, p, tier)));
    return strongDecision(acme, candidates, context);
  }

  // The exact id on a project of the other banner or state is most likely a
  // data-entry error in Pulley; a human should see it rather than "no match".
  const outside = context.pool.filter(
    (p) => p.parsedName.fullIds.includes(acme.id) && !scoped.includes(p),
  );
  if (outside.length > 0) {
    const where = outside
      .map((p) => `${p.id} is ${p.banner ?? p.organization} in ${p.state}`)
      .join("; ");
    return review(
      acme,
      rank(outside.map((p) => toCandidate(acme, p, Tier.ExactId))),
      Tier.ExactId,
      ReasonCode.IdOutsideScope,
      `${where}; Acme site is ${acme.banner ?? "unknown banner"} in ${state ?? "unknown state"}`,
    );
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

/**
 * The full Acme id in the name. When that id's store number also identifies
 * another building (a former number reused as a current one), the name alone
 * cannot say which building it means, so the locality must agree too.
 */
function isExactIdCandidate(
  acme: AcmeProject,
  pulley: PulleyRecord,
  sharedNumbers: ReadonlySet<string>,
): boolean {
  if (!pulley.parsedName.fullIds.includes(acme.id)) return false;
  if (!sharedNumbers.has(collisionKey(acme.banner, acmeState(acme), acme.store))) return true;
  return localityAgrees(acme, pulley);
}

function localityAgrees(acme: AcmeProject, pulley: PulleyRecord): boolean {
  const streetAgrees =
    (pulley.streetKey !== null && pulley.streetKey === acme.site?.streetKey) ||
    (pulley.streetNameKey !== null && pulley.streetNameKey === acme.site?.streetNameKey);
  return cityMatches(acme, pulley) || streetAgrees;
}

/** Store number in the name identifies this building (and, for shared numbers, the locality agrees). */
function isStoreCandidate(
  acme: AcmeProject,
  pulley: PulleyRecord,
  sharedNumbers: ReadonlySet<string>,
): boolean {
  if (!storeMatches(acme, pulley)) return false;
  const mine = acmeStoreNumbers(acme);
  const scope = (n: number): string => collisionKey(acme.banner, acmeState(acme), n);
  const viaShared = pulley.parsedName.storeNumbers.every(
    (n) => !mine.includes(n) || sharedNumbers.has(scope(n)),
  );
  if (!viaShared) return true;
  return localityAgrees(acme, pulley);
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
    if (!isInScope(other, pulley)) continue;
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
    if (!isInScope(other, pulley)) continue;
    if (!isDateCandidate(other, pulley)) continue;
    if (temporalVerdict(other, pulley) === Temporal.Conflict) continue;
    if (found !== null) return null;
    found = other.id;
  }
  return found;
}

function isAddressCandidate(
  acme: AcmeProject,
  pulley: PulleyRecord,
  sharedStreets: ReadonlySet<string>,
): boolean {
  if (pulley.parsedName.storeNumbers.length > 0) return false;
  if (sequenceRelation(acme, pulley) === SequenceRelation.Different) return false;
  if (pulley.streetKey === null || pulley.streetKey !== acme.site?.streetKey) return false;
  // Two sites on the same street key (possible across cities): need the city too.
  const key = collisionKey(acme.banner, acmeState(acme), pulley.streetKey);
  return !sharedStreets.has(key) || cityMatches(acme, pulley);
}

function isWeakCandidate(acme: AcmeProject, pulley: PulleyRecord): boolean {
  if (storeContradicts(acme, pulley)) return false;
  if (pulley.parsedName.fullIds.length > 0) return false;
  if (sequenceRelation(acme, pulley) === SequenceRelation.Different) return false;
  // Street name without the house number only means something in the same city.
  const sameStreetName =
    pulley.streetNameKey !== null &&
    pulley.streetNameKey === acme.site?.streetNameKey &&
    cityMatches(acme, pulley);
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
  const candidate: Candidate = {
    pulleyId: pulley.id,
    pulleyName: pulley.name,
    pulleyStatus: pulley.status,
    pulleyType: pulley.projectType,
    pulleyCity: pulley.jurisdictionCity,
    pulleyStreet: pulley.streetAddress,
    pulleyDates: describeDates({
      cs: pulley.constructionStart,
      ps: pulley.permitSubmitted,
      pa: pulley.permitApproved,
    }),
    evidenceSummary: "",
    tier,
    evidence,
    score: scoreEvidence(evidence),
  };
  return { ...candidate, evidenceSummary: describeEvidence(candidate) };
}

function describeDates(d: { cs: string | null; ps: string | null; pa: string | null }): string {
  const parts: string[] = [];
  if (d.cs) parts.push(`cs ${d.cs}`);
  if (d.ps) parts.push(`ps ${d.ps}`);
  if (d.pa) parts.push(`pa ${d.pa}`);
  return parts.join(", ");
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

/** Score without the soft corroboration bonuses; two candidates equal here are a real tie. */
function decisiveScore(candidate: Candidate): number {
  const e = candidate.evidence;
  let soft = 0;
  if (e.cityMatch) soft += 3;
  if (e.streetName && !e.streetExact) soft += 5;
  return candidate.score - soft;
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
  const first = candidates[0];
  if (!first) return noCandidate(acme, context.excluded);
  const tier = first.tier;
  // Acceptance is separate from ranking: candidates that differ only in
  // soft corroboration (jurisdiction city, street name) are a tie, because
  // the brief says those names legitimately differ. Only hard evidence
  // (id, store, type, dates, sequence, exact street, status) separates them,
  // so acceptance starts from the best *decisive* score, not the display order.
  const best = Math.max(...candidates.map(decisiveScore));
  const tied = candidates.filter((c) => decisiveScore(c) === best);
  const top = tied[0] as Candidate;
  const live = tied.filter((c) => !isPulleyCanceled(c.pulleyStatus));
  const winner = tied.length === 1 ? top : live.length === 1 ? live[0] : undefined;

  if (!winner) {
    return review(
      acme,
      candidates,
      tier,
      ReasonCode.Ambiguous,
      `${tied.length} candidates tie on decisive evidence in tier ${tier}`,
    );
  }
  if (!winner.evidence.typeCompatible) {
    return unrelatedOrMismatch(acme, candidates, winner, tier);
  }
  const verdict = statusVerdict(acme.status, winner.pulleyStatus);
  if (verdict === StatusVerdict.Unknown) {
    const odd = acmeLifecycle(acme.status) === "unknown" ? acme.status : winner.pulleyStatus;
    return review(
      acme,
      candidates,
      tier,
      ReasonCode.StatusUnknown,
      `status "${odd}" has no known meaning; cannot apply the canceled-on-both-sides rule`,
    );
  }
  if (verdict === StatusVerdict.Conflict) {
    return review(
      acme,
      candidates,
      tier,
      ReasonCode.StatusConflict,
      `Acme is ${acme.status}, Pulley ${winner.pulleyId} is ${winner.pulleyStatus}`,
    );
  }
  const target = context.pulleyById.get(winner.pulleyId);
  const safety = target ? matchSafetyIssue(acme, target, context.safety, true) : null;
  if (safety)
    return {
      ...review(acme, candidates, tier, safety.reason, safety.note),
      reviewResolution: safety.resolution,
    };
  return {
    ...base(acme, [winner, ...candidates.filter((c) => c !== winner)], tier),
    status: OutputStatus.Matched,
    pulleyId: winner.pulleyId,
    reason: reasonForTier(tier),
    note: describeWinner(winner),
    statusDrift: statusDrift(acme.status, winner.pulleyStatus),
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
  | "acmeId"
  | "acmeName"
  | "acmeStatus"
  | "acmeType"
  | "programYear"
  | "acmeCity"
  | "acmeStreet"
  | "acmeDates"
  | "candidates"
  | "tier"
  | "statusDrift"
> {
  return {
    acmeId: acme.id,
    acmeName: acme.name,
    acmeStatus: acme.status,
    acmeType: acme.projectType,
    programYear: acme.programYear,
    acmeCity: acme.site?.city ?? acme.parsedName.canonical?.city ?? "",
    acmeStreet: acme.site?.streetAddress ?? "",
    acmeDates: describeDates({
      cs: acme.dates?.constructionStart ?? null,
      ps: acme.dates?.permitSubmittedActual ?? acme.dates?.permitSubmittedProjected ?? null,
      pa: acme.dates?.permitApproved ?? null,
    }),
    candidates: candidates.slice(0, 5),
    tier,
    statusDrift: null,
  };
}

function describeWinner(candidate: Candidate | undefined): string {
  if (!candidate) return "no candidate";
  return `${candidate.pulleyId}: ${describeEvidence(candidate)}`;
}

/** The evidence a candidate carries, in words a reviewer can scan. */
function describeEvidence(candidate: Candidate): string {
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
  if (e.temporal === Temporal.Conflict) parts.push("OTHER YEAR");
  if (!e.typeCompatible) parts.push("INCOMPATIBLE TYPE");
  if (!e.statusAgree) parts.push("STATUS DISAGREES");
  return parts.join(", ") || "no supporting evidence";
}
