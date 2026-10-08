import type { ParsedName } from "./normalize/name.ts";

/**
 * Canonical records the matcher works on. Built once per run from the
 * validated inputs (see `normalize/build.ts`). Nothing in `domain/` reads
 * files or the network.
 */

export const Banner = {
  Market: "Acme Market",
  WarehouseClub: "Acme Warehouse Club",
} as const;
export type Banner = (typeof Banner)[keyof typeof Banner];

/** Banner codes used inside canonical names such as `2264.1001-OMAHA-NE-WHC-RM-2027`. */
const BANNER_BY_CODE: Readonly<Record<string, Banner>> = {
  SUP: Banner.Market,
  MKT: Banner.Market,
  WHC: Banner.WarehouseClub,
};

export function bannerFromCode(code: string): Banner | null {
  return BANNER_BY_CODE[code.toUpperCase()] ?? null;
}

export function bannerFromLabel(label: string): Banner | null {
  const normalized = label.trim().toLowerCase();
  if (normalized === "acme market") return Banner.Market;
  if (normalized === "acme warehouse club") return Banner.WarehouseClub;
  return null;
}

/** Project-type codes used inside canonical names. */
const TYPE_BY_CODE: Readonly<Record<string, string>> = {
  RM: "Remodel",
  EV: "EV Charging",
  CT: "Coffee Tenant",
  PR: "Pharmacy Relocation",
  EX: "Expansion",
  DR: "Deli Remodel",
  NB: "New Build",
};

export function projectTypeFromCode(code: string): string | null {
  return TYPE_BY_CODE[code.toUpperCase()] ?? null;
}

export interface AcmeSite {
  readonly siteId: string;
  readonly banner: Banner | null;
  readonly bannerLabel: string;
  readonly locationNumber: number;
  readonly formerLocationNumber: number | null;
  readonly streetAddress: string;
  /** Normalized street for equality comparison; see `normalize/address.ts`. */
  readonly streetKey: string | null;
  /** Street name without house number; corroboration only. */
  readonly streetNameKey: string | null;
  readonly city: string;
  readonly state: string;
  readonly zip: string;
}

export interface AcmeDates {
  readonly designStart: string | null;
  readonly permitSubmittedProjected: string | null;
  readonly permitSubmittedActual: string | null;
  readonly permitApproved: string | null;
  readonly constructionStart: string | null;
}

export interface AcmeProject {
  /** `store.sequence`, e.g. `1556.1002`. */
  readonly id: string;
  readonly store: number;
  readonly sequence: number;
  readonly siteId: string;
  readonly name: string;
  readonly parsedName: ParsedName;
  readonly programYear: number;
  readonly projectType: string;
  readonly status: string;
  /** From the joined site; null when the site is unknown. */
  readonly banner: Banner | null;
  readonly site: AcmeSite | null;
  readonly dates: AcmeDates | null;
  /**
   * Why this project's identity cannot be trusted automatically: conflicting
   * Site Directory/Key Dates/register rows, or a site/store identity mismatch.
   * A disputed project always goes to review, even with no candidate.
   */
  readonly identityDisputed: string | null;
}

export interface PulleyRecord {
  readonly id: string;
  readonly name: string;
  readonly parsedName: ParsedName;
  readonly organization: string;
  readonly banner: Banner | null;
  readonly accountPlan: string;
  readonly isPathfinder: boolean;
  readonly status: string;
  readonly projectType: string;
  readonly isSignage: boolean;
  readonly jurisdictionCity: string;
  readonly state: string;
  readonly streetAddress: string | null;
  readonly streetKey: string | null;
  readonly streetNameKey: string | null;
  readonly permitSubmitted: string | null;
  readonly permitApproved: string | null;
  readonly constructionStart: string | null;
  readonly createdAt: string;
}

export interface NormalizedInputs {
  readonly acme: readonly AcmeProject[];
  readonly sites: readonly AcmeSite[];
  /** Sites keyed by current and former location number (a site may appear under both). */
  readonly sitesByLocation: ReadonlyMap<number, readonly AcmeSite[]>;
  readonly pulley: readonly PulleyRecord[];
  readonly warnings: readonly string[];
}
