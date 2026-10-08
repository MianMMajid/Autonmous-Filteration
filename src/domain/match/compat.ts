import type { AcmeProject, PulleyRecord } from "../model.ts";
import { labelKey } from "../normalize/text.ts";
import { SequenceRelation, YearSignal } from "./types.ts";

/**
 * Pairwise compatibility rules between an Acme project and a Pulley record.
 * Each function answers one question and is unit-tested on its own.
 */

/**
 * Pulley permit types that absorb Acme line items at the same store and
 * year. Observed: Coffee Tenant, Deli Remodel, Pharmacy Relocation, and
 * Expansion lines filed under a Remodel or Expansion permit.
 */
const UMBRELLA_TYPES: ReadonlySet<string> = new Set(["remodel", "expansion", "new build"]);
const ABSORBABLE_TYPES: ReadonlySet<string> = new Set([
  "remodel",
  "expansion",
  "coffee tenant",
  "deli remodel",
  "pharmacy relocation",
]);

export function typeKey(value: string): string {
  return value.trim().toLowerCase();
}

export function typesEqual(acmeType: string, pulleyType: string): boolean {
  return typeKey(acmeType) === typeKey(pulleyType);
}

/** Equal types, or a Pulley umbrella permit covering an absorbable Acme line. */
export function typesCompatible(acmeType: string, pulleyType: string): boolean {
  const acme = typeKey(acmeType);
  const pulley = typeKey(pulleyType);
  if (acme === pulley) return true;
  return UMBRELLA_TYPES.has(pulley) && ABSORBABLE_TYPES.has(acme);
}

function yearOf(isoDate: string | null): number | null {
  if (!isoDate) return null;
  const year = Number(isoDate.slice(0, 4));
  return Number.isInteger(year) ? year : null;
}

/** Year evidence for a candidate, strongest signal first. */
export function yearSignal(acme: AcmeProject, pulley: PulleyRecord): YearSignal {
  const nameYears = pulley.parsedName.years;
  if (nameYears.length > 0) {
    return nameYears.includes(acme.programYear) ? YearSignal.NameEqual : YearSignal.NameDifferent;
  }
  const dateYears = [pulley.constructionStart, pulley.permitSubmitted, pulley.permitApproved]
    .map(yearOf)
    .filter((year): year is number => year !== null);
  if (dateYears.length === 0) return YearSignal.None;
  return dateYears.includes(acme.programYear) ? YearSignal.DateEqual : YearSignal.DateDifferent;
}

/** How a Pulley name's own sequence information relates to the Acme sequence. */
export function sequenceRelation(acme: AcmeProject, pulley: PulleyRecord): SequenceRelation {
  const { fullIds, sequences } = pulley.parsedName;
  const own = [
    ...sequences,
    ...fullIds.map((id) => Number(id.split(".")[1])).filter((n) => Number.isInteger(n)),
  ];
  if (own.length === 0) return SequenceRelation.Unknown;
  return own.includes(acme.sequence) ? SequenceRelation.Equal : SequenceRelation.Different;
}

/** Store numbers that identify this Acme project's building: current and former location numbers. */
export function acmeStoreNumbers(acme: AcmeProject): readonly number[] {
  const numbers = [acme.store];
  if (acme.site) {
    if (!numbers.includes(acme.site.locationNumber)) numbers.push(acme.site.locationNumber);
    if (
      acme.site.formerLocationNumber !== null &&
      !numbers.includes(acme.site.formerLocationNumber)
    ) {
      numbers.push(acme.site.formerLocationNumber);
    }
  }
  return numbers;
}

export function storeMatches(acme: AcmeProject, pulley: PulleyRecord): boolean {
  const mine = acmeStoreNumbers(acme);
  return pulley.parsedName.storeNumbers.some((n) => mine.includes(n));
}

/** True when the Pulley name names a store that is definitely not this one. */
export function storeContradicts(acme: AcmeProject, pulley: PulleyRecord): boolean {
  const theirs = pulley.parsedName.storeNumbers;
  return theirs.length > 0 && !storeMatches(acme, pulley);
}

export function cityMatches(acme: AcmeProject, pulley: PulleyRecord): boolean {
  if (!acme.site) return false;
  const site = labelKey(acme.site.city);
  if (labelKey(pulley.jurisdictionCity) === site) return true;
  const named = pulley.parsedName.cityState?.city ?? pulley.parsedName.canonical?.city;
  return named !== undefined && labelKey(named) === site;
}

export function acmeState(acme: AcmeProject): string | null {
  return acme.site?.state ?? acme.parsedName.canonical?.state ?? null;
}

// ---------- Dates ----------

const DAY_MS = 86_400_000;

function daysBetween(a: string | null | undefined, b: string | null | undefined): number | null {
  if (!a || !b) return null;
  const diff = Math.abs(Date.parse(a) - Date.parse(b)) / DAY_MS;
  return Number.isFinite(diff) ? diff : null;
}

/**
 * Smallest gap in days between corresponding milestone dates on both sides,
 * or null when no pair of dates exists. Observed 2026-10-08: for exact-id
 * matches with dates, 57 of 71 are within 7 days, so Pulley dates are the
 * Acme Key Dates with small jitter.
 */
export function dateProximityDays(acme: AcmeProject, pulley: PulleyRecord): number | null {
  const d = acme.dates;
  if (!d) return null;
  const gaps = [
    daysBetween(d.constructionStart, pulley.constructionStart),
    daysBetween(d.permitSubmittedActual ?? d.permitSubmittedProjected, pulley.permitSubmitted),
    daysBetween(d.permitApproved, pulley.permitApproved),
  ].filter((gap): gap is number => gap !== null);
  return gaps.length === 0 ? null : Math.min(...gaps);
}

export const Temporal = {
  /** Same permit timeline: dates within a month, or the year written in the name agrees. */
  Same: "same",
  /** Same year, dates a few months apart: plausible for a folded permit. */
  Near: "near",
  /** Nothing to compare. */
  Unknown: "unknown",
  /** Another year's work: the name says a different year, or the dates are far apart in a different year. */
  Conflict: "conflict",
} as const;
export type Temporal = (typeof Temporal)[keyof typeof Temporal];

const SAME_DAYS = 30;
const CONFLICT_DAYS = 180;

export function temporalVerdict(acme: AcmeProject, pulley: PulleyRecord): Temporal {
  const year = yearSignal(acme, pulley);
  if (year === YearSignal.NameDifferent) return Temporal.Conflict;
  if (year === YearSignal.NameEqual) return Temporal.Same;
  const gap = dateProximityDays(acme, pulley);
  if (gap !== null && gap <= SAME_DAYS) return Temporal.Same;
  if (year === YearSignal.DateDifferent) {
    return gap !== null && gap <= CONFLICT_DAYS ? Temporal.Near : Temporal.Conflict;
  }
  if (year === YearSignal.DateEqual) return Temporal.Near;
  return Temporal.Unknown;
}

// ---------- Status gate ----------

/**
 * Lifecycle meaning of a status value. Every value is classified explicitly;
 * a value we have never seen is `unknown`, and an unknown lifecycle never
 * produces a confident match (see `statusVerdict`).
 */
const ACME_ACTIVE: ReadonlySet<string> = new Set([
  "active",
  "deferred",
  "on hold",
  "in progress",
  "draft",
  "planned",
  "open",
  "pending",
]);
const ACME_CLOSED: ReadonlySet<string> = new Set([
  "closed",
  "complete",
  "completed",
  "canceled",
  "cancelled",
]);
const PULLEY_ACTIVE: ReadonlySet<string> = new Set([
  "in progress",
  "on hold",
  "draft",
  "planned",
  "open",
  "active",
  "pending",
]);
const PULLEY_CANCELED: ReadonlySet<string> = new Set(["canceled", "cancelled", "cancelation"]);
const PULLEY_COMPLETE: ReadonlySet<string> = new Set(["complete", "completed", "closed", "done"]);

export type AcmeLifecycle = "active" | "ended" | "unknown";
export type PulleyLifecycle = "active" | "complete" | "canceled" | "unknown";

export function acmeLifecycle(status: string): AcmeLifecycle {
  const key = typeKey(status);
  if (ACME_ACTIVE.has(key)) return "active";
  if (ACME_CLOSED.has(key)) return "ended";
  return "unknown";
}

export function pulleyLifecycle(status: string): PulleyLifecycle {
  const key = typeKey(status);
  if (PULLEY_ACTIVE.has(key)) return "active";
  if (PULLEY_CANCELED.has(key)) return "canceled";
  if (PULLEY_COMPLETE.has(key)) return "complete";
  return "unknown";
}

export function isAcmeClosed(status: string): boolean {
  return acmeLifecycle(status) === "ended";
}

export function isPulleyCanceled(status: string): boolean {
  return pulleyLifecycle(status) === "canceled";
}

export const StatusVerdict = {
  Agree: "agree",
  Conflict: "conflict",
  /** One side's status has no known lifecycle meaning; a human decides. */
  Unknown: "unknown",
} as const;
export type StatusVerdict = (typeof StatusVerdict)[keyof typeof StatusVerdict];

/**
 * Brief: canceled only counts when canceled or closed on both sides.
 * Ended on Acme's side needs ended (complete or canceled) on Pulley's; live
 * on Acme's side tolerates anything but canceled. Unknown vocabulary on
 * either side is reported as such rather than guessed.
 */
export function statusVerdict(acmeStatus: string, pulleyStatus: string): StatusVerdict {
  const acme = acmeLifecycle(acmeStatus);
  const pulley = pulleyLifecycle(pulleyStatus);
  if (acme === "unknown" || pulley === "unknown") return StatusVerdict.Unknown;
  if (acme === "ended") return pulley === "active" ? StatusVerdict.Conflict : StatusVerdict.Agree;
  return pulley === "canceled" ? StatusVerdict.Conflict : StatusVerdict.Agree;
}

export function statusesAgree(acmeStatus: string, pulleyStatus: string): boolean {
  return statusVerdict(acmeStatus, pulleyStatus) === StatusVerdict.Agree;
}

/**
 * A status difference on a matched pair that the two systems may want to
 * reconcile. The gate above already rejects cancellation on one side only;
 * this reports the remaining, permitted differences.
 */
export function statusDrift(acmeStatus: string, pulleyStatus: string): string | null {
  const acme = typeKey(acmeStatus);
  const pulley = typeKey(pulleyStatus);
  if (!isAcmeClosed(acmeStatus) && PULLEY_COMPLETE.has(pulley)) {
    return `Pulley ${pulleyStatus}, Acme ${acmeStatus}`;
  }
  if (acme === "deferred" && (pulley === "in progress" || pulley === "draft")) {
    return `Acme ${acmeStatus}, Pulley ${pulleyStatus}`;
  }
  return null;
}
