import { type AcmeProject, bannerFromCode, type PulleyRecord } from "../model.ts";
import {
  acmeState,
  acmeStoreNumbers,
  cityMatches,
  dateProximityDays,
  isInScope,
  isPulleyCanceled,
  milestoneGaps,
  storeContradicts,
  storeMatches,
  Temporal,
  temporalVerdict,
  typesCompatible,
} from "./compat.ts";
import { ReasonCode } from "./types.ts";

export interface SafetyIssue {
  readonly reason: typeof ReasonCode.EvidenceConflict | typeof ReasonCode.InsufficientEvidence;
  readonly note: string;
}

/** Source contradictions matter even when there is no Pulley candidate. */
export function acmeNameIssue(acme: AcmeProject): string | null {
  if (acme.parsedName.years.some((year) => year !== acme.programYear))
    return "Acme project name contradicts its structured program year";
  const allowed = new Set(acmeStoreNumbers(acme).map((store) => `${store}.${acme.sequence}`));
  allowed.add(acme.id);
  if (acme.parsedName.fullIds.some((id) => !allowed.has(id)))
    return "Acme project name contradicts its structured project identity";
  return null;
}

/** Shared by automatic acceptance, overrides, and the publication boundary.
 * Missing evidence may be supplied by a human; contradictory evidence must
 * first be corrected in the source. This is a conservative gate, not proof
 * that every accepted pair is correct.
 */
export function matchSafetyIssue(
  acme: AcmeProject,
  pulley: PulleyRecord,
  register: readonly AcmeProject[],
  automatic: boolean,
): SafetyIssue | null {
  const issue = pairConflict(acme, pulley) ?? ownershipConflict(acme, pulley, register);
  if (issue) return { reason: ReasonCode.EvidenceConflict, note: issue };
  const identifiedYear = register.some(
    (other) =>
      !other.identityDisputed &&
      isInScope(other, pulley) &&
      other.siteId === acme.siteId &&
      other.programYear === acme.programYear &&
      namesProject(other, pulley),
  );
  if (automatic && !identifiedYear && temporalVerdict(acme, pulley) === Temporal.Unknown) {
    return {
      reason: ReasonCode.InsufficientEvidence,
      note: "No exact full id or usable temporal evidence establishes this permit's program year",
    };
  }
  if (
    automatic &&
    !identifiedYear &&
    register.some((other) => isInScope(other, pulley) && competingYear(acme, pulley, other))
  )
    return {
      reason: ReasonCode.InsufficientEvidence,
      note: "Another program year also fits this permit; no unique strong anchor resolves ownership",
    };
  return null;
}

function competingYear(acme: AcmeProject, pulley: PulleyRecord, other: AcmeProject): boolean {
  if (
    other.siteId !== acme.siteId ||
    other.programYear === acme.programYear ||
    !typesCompatible(other.projectType, pulley.projectType) ||
    temporalVerdict(other, pulley) === Temporal.Conflict
  )
    return false;
  const ownGap = dateProximityDays(acme, pulley);
  const otherGap = dateProximityDays(other, pulley);
  return ownGap === null || ownGap > 7 || (otherGap !== null && otherGap <= 7);
}

function pairConflict(acme: AcmeProject, pulley: PulleyRecord): string | null {
  const sourceIssue = acmeNameIssue(acme);
  if (sourceIssue) return sourceIssue;
  if (pulley.parsedName.canceledMarker && !isPulleyCanceled(pulley.status))
    return "Pulley name says canceled but its structured status disagrees";
  if (pulley.parsedName.signageHint && !pulley.isSignage)
    return "Pulley name says signage but its structured project type disagrees";
  const canonical = pulley.parsedName.canonical;
  if (
    canonical &&
    (canonical.state !== pulley.state || bannerFromCode(canonical.bannerCode) !== pulley.banner)
  )
    return "Pulley canonical name contradicts its organization or state";
  if (storeContradicts(acme, pulley)) return "Pulley name identifies another building";
  if (pulley.parsedName.storeNumbers.some((store) => !acmeStoreNumbers(acme).includes(store)))
    return "Pulley name also identifies another building, possibly absent from the register";
  if (!typesCompatible(acme.projectType, pulley.projectType))
    return "Project types do not describe compatible work";
  if (temporalVerdict(acme, pulley) === Temporal.Conflict)
    return "Project year evidence conflicts; confirm the permit's program year";
  if (pulley.parsedName.years.some((year) => year !== acme.programYear))
    return "Pulley name contains a conflicting program year";
  const distant = milestoneGaps(acme, pulley).filter((gap) => gap.days > 180);
  if (distant.length > 0)
    return `Corresponding milestones conflict: ${distant.map((g) => `${g.milestone} ${g.days} days apart`).join(", ")}`;
  if (
    acme.site?.streetNameKey &&
    pulley.streetNameKey &&
    acme.site.streetNameKey !== pulley.streetNameKey
  )
    return "Pulley street names a different street from the Acme building";

  return null;
}

function namesProject(acme: AcmeProject, pulley: PulleyRecord): boolean {
  return acmeStoreNumbers(acme).some((store) =>
    pulley.parsedName.fullIds.includes(`${store}.${acme.sequence}`),
  );
}

function ownershipConflict(
  acme: AcmeProject,
  pulley: PulleyRecord,
  register: readonly AcmeProject[],
): string | null {
  for (const other of register) {
    if (!isInScope(other, pulley)) continue;
    // An explicit id remains evidence even when its owner's provisional
    // match is withheld or another candidate wins for that owner.
    const namesOther = namesProject(other, pulley);
    if (namesOther && (other.siteId !== acme.siteId || other.programYear !== acme.programYear))
      return `Pulley explicitly identifies ${other.id} at another building or program year`;
    if (
      other.siteId !== acme.siteId &&
      other.site?.streetKey &&
      pulley.streetKey &&
      other.site.streetKey === pulley.streetKey &&
      acme.site?.streetKey !== pulley.streetKey &&
      acmeState(other) === acmeState(acme)
    )
      return `Pulley address exactly identifies another registered building (${other.id})`;
    const competing = competingBuilding(acme, pulley, other);
    if (competing) return competing;
  }
  return null;
}

function competingBuilding(
  acme: AcmeProject,
  pulley: PulleyRecord,
  other: AcmeProject,
): string | null {
  if (other.siteId === acme.siteId || !typesCompatible(other.projectType, pulley.projectType))
    return null;
  if (temporalVerdict(other, pulley) === Temporal.Conflict) return null;
  if (
    storeMatches(acme, pulley) &&
    storeMatches(other, pulley) &&
    (!pulley.streetKey ||
      pulley.streetKey !== acme.site?.streetKey ||
      pulley.streetKey === other.site?.streetKey)
  )
    return `Store number also identifies ${other.id}; no unique exact address resolves the building`;
  const gap = dateProximityDays(other, pulley);
  const ownGap = dateProximityDays(acme, pulley);
  if (
    pulley.parsedName.storeNumbers.length === 0 &&
    cityMatches(other, pulley) &&
    gap !== null &&
    gap <= 7 &&
    (ownGap === null || ownGap > 7)
  )
    return `Milestone evidence also points to another building (${other.id}); verify the conflicting identity`;
  return null;
}
