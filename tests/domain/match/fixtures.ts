import {
  type AcmeProject,
  type AcmeSite,
  Banner,
  type PulleyRecord,
} from "../../../src/domain/model.ts";
import { normalizeStreet, streetNameKey } from "../../../src/domain/normalize/address.ts";
import { parseProjectName } from "../../../src/domain/normalize/name.ts";

/** Compact builders for synthetic matcher tests. Defaults describe store 1556 in Reno, NV. */

interface AcmeOverrides {
  id?: string;
  store?: number;
  sequence?: number;
  banner?: Banner;
  projectType?: string;
  programYear?: number;
  status?: string;
  street?: string;
  city?: string;
  state?: string;
  formerLocationNumber?: number | null;
  name?: string;
  site?: null;
  dates?: Partial<NonNullable<AcmeProject["dates"]>>;
  identityDisputed?: string | null;
}

export function acme(overrides: AcmeOverrides = {}): AcmeProject {
  const store = overrides.store ?? 1556;
  const sequence = overrides.sequence ?? 1002;
  const id = overrides.id ?? `${store}.${sequence}`;
  const street = overrides.street ?? "100 Main St";
  const state = overrides.state ?? "NV";
  const city = overrides.city ?? "Reno";
  const bannerCode = overrides.banner === Banner.WarehouseClub ? "WHC" : "SUP";
  const name =
    overrides.name ??
    `${id}-${city.toUpperCase()}-${state}-${bannerCode}-RM-${overrides.programYear ?? 2027}`;
  const site: AcmeSite = {
    siteId: `ST-${store}`,
    banner: overrides.banner ?? Banner.Market,
    bannerLabel: overrides.banner ?? Banner.Market,
    locationNumber: store,
    formerLocationNumber: overrides.formerLocationNumber ?? null,
    streetAddress: street,
    streetKey: normalizeStreet(street),
    streetNameKey: streetNameKey(street),
    city,
    state,
    zip: "89501",
  };
  return {
    id,
    store,
    sequence,
    siteId: site.siteId,
    name,
    parsedName: parseProjectName(name),
    programYear: overrides.programYear ?? 2027,
    projectType: overrides.projectType ?? "Remodel",
    status: overrides.status ?? "Active",
    banner: overrides.banner ?? Banner.Market,
    site: overrides.site === null ? null : site,
    identityDisputed: overrides.identityDisputed ?? null,
    dates: overrides.dates
      ? {
          designStart: null,
          permitSubmittedProjected: null,
          permitSubmittedActual: null,
          permitApproved: null,
          constructionStart: null,
          ...overrides.dates,
        }
      : null,
  };
}

interface PulleyOverrides {
  id?: string;
  name?: string;
  banner?: Banner;
  accountPlan?: string;
  status?: string;
  projectType?: string;
  jurisdictionCity?: string;
  state?: string;
  street?: string | null;
  permitSubmitted?: string | null;
  permitApproved?: string | null;
  constructionStart?: string | null;
}

let counter = 0;

export function pulley(overrides: PulleyOverrides = {}): PulleyRecord {
  counter++;
  const name = overrides.name ?? "Acme Market - Reno, NV";
  const banner = overrides.banner ?? Banner.Market;
  const accountPlan = overrides.accountPlan ?? "full_service";
  const projectType = overrides.projectType ?? "Remodel";
  const street = overrides.street === undefined ? null : overrides.street;
  return {
    id: overrides.id ?? `prj_${String(counter).padStart(4, "0")}`,
    name,
    parsedName: parseProjectName(name),
    organization: banner,
    banner,
    accountPlan,
    isPathfinder: accountPlan === "pathfinder",
    status: overrides.status ?? "In Progress",
    projectType,
    isSignage: projectType.trim().toLowerCase() === "signage",
    jurisdictionCity: overrides.jurisdictionCity ?? "Reno",
    state: overrides.state ?? "NV",
    streetAddress: street,
    streetKey: normalizeStreet(street),
    streetNameKey: streetNameKey(street),
    permitSubmitted: overrides.permitSubmitted ?? null,
    permitApproved: overrides.permitApproved ?? null,
    constructionStart: overrides.constructionStart ?? null,
    createdAt: "2026-10-01T00:00:00Z",
  };
}

export function inputs(acmeList: AcmeProject[], pulleyList: PulleyRecord[]) {
  const sites = acmeList.flatMap((a) => (a.site ? [a.site] : []));
  const sitesByLocation = new Map<number, AcmeSite[]>();
  const add = (key: number, site: AcmeSite): void => {
    sitesByLocation.set(key, [...(sitesByLocation.get(key) ?? []), site]);
  };
  for (const site of sites) {
    add(site.locationNumber, site);
    if (site.formerLocationNumber !== null) add(site.formerLocationNumber, site);
  }
  return { acme: acmeList, sites, sitesByLocation, pulley: pulleyList, warnings: [] };
}
