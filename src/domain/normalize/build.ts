import type { AcquiredInputs } from "../../run/acquire.ts";
import type { PulleyProject } from "../../sources/pulley/schema.ts";
import type {
  KeyDatesRow,
  ProjectRegisterRow,
  SiteDirectoryRow,
} from "../../sources/siteledger/schemas.ts";
import {
  type AcmeProject,
  type AcmeSite,
  bannerFromCode,
  bannerFromLabel,
  type NormalizedInputs,
  type PulleyRecord,
} from "../model.ts";
import { normalizeStreet, streetNameKey } from "./address.ts";
import { parseProjectName } from "./name.ts";

/**
 * Build canonical records from validated inputs: join the Project Register to
 * the Site Directory and Key Dates, parse every name, and normalize streets.
 *
 * Join problems are warnings, not failures. A project without a site still
 * gets matched on whatever facts its name carries.
 */
export function normalizeInputs(inputs: Pick<AcquiredInputs, "acme" | "pulley">): NormalizedInputs {
  const warnings: string[] = [];
  const siteRows = dedupeRows(
    inputs.acme.sites,
    (r) => r.siteId,
    "Site Directory",
    "Site ID",
    warnings,
  );
  const dateRows = dedupeRows(
    inputs.acme.keyDates,
    (r) => r.projectId,
    "Key Dates",
    "Project ID",
    warnings,
  );
  const sites = siteRows.rows.map(toSite);
  const sitesById = new Map(sites.map((site) => [site.siteId, site]));
  const sitesByLocation = indexSitesByLocation(sites);
  const datesById = new Map(dateRows.rows.map((row) => [row.projectId, row]));

  const acme = buildAcmeProjects(inputs.acme.projects, sitesById, datesById, warnings, {
    quarantinedSites: siteRows.quarantined,
    quarantinedDates: dateRows.quarantined,
  });
  const pulley = inputs.pulley.map(toPulleyRecord);

  return { acme, sites, sitesByLocation, pulley, warnings };
}

/**
 * Join keys must be unique. Rows that repeat a key with identical content
 * collapse to one (with a warning). Rows that repeat a key with *different*
 * content are quarantined: none of them is used, because picking one by
 * position would make the result depend on export order.
 */
function dedupeRows<T>(
  rows: readonly T[],
  keyOf: (row: T) => string,
  report: string,
  keyName: string,
  warnings: string[],
): { readonly rows: T[]; readonly quarantined: ReadonlySet<string> } {
  const firstByKey = new Map<string, T>();
  const conflicting = new Set<string>();
  let identical = 0;
  for (const row of rows) {
    const key = keyOf(row);
    const first = firstByKey.get(key);
    if (first === undefined) {
      firstByKey.set(key, row);
    } else if (JSON.stringify(first) === JSON.stringify(row)) {
      identical++;
    } else {
      conflicting.add(key);
    }
  }
  if (identical > 0) warnings.push(`${report}: ${identical} identical duplicate row(s) collapsed`);
  if (conflicting.size > 0) {
    const sample = [...conflicting].slice(0, 10).join(", ");
    warnings.push(
      `${report}: ${conflicting.size} ${keyName}(s) appear more than once with different content and were set aside: ${sample}${conflicting.size > 10 ? ", …" : ""}`,
    );
  }
  return {
    rows: [...firstByKey.entries()].filter(([key]) => !conflicting.has(key)).map(([, row]) => row),
    quarantined: conflicting,
  };
}

// ---------- Acme ----------

function toSite(row: SiteDirectoryRow): AcmeSite {
  return {
    siteId: row.siteId,
    banner: bannerFromLabel(row.banner),
    bannerLabel: row.banner,
    locationNumber: row.locationNumber,
    formerLocationNumber: row.formerLocationNumber,
    streetAddress: row.streetAddress,
    streetKey: normalizeStreet(row.streetAddress),
    streetNameKey: streetNameKey(row.streetAddress),
    city: row.mailingCity,
    state: row.state,
    zip: row.zip,
  };
}

function indexSitesByLocation(sites: readonly AcmeSite[]): Map<number, AcmeSite[]> {
  const index = new Map<number, AcmeSite[]>();
  const add = (key: number, site: AcmeSite): void => {
    const list = index.get(key);
    if (list) list.push(site);
    else index.set(key, [site]);
  };
  for (const site of sites) {
    add(site.locationNumber, site);
    if (site.formerLocationNumber !== null) add(site.formerLocationNumber, site);
  }
  return index;
}

function buildAcmeProjects(
  rows: readonly ProjectRegisterRow[],
  sitesById: ReadonlyMap<string, AcmeSite>,
  datesById: ReadonlyMap<string, KeyDatesRow>,
  warnings: string[],
  quarantined: { quarantinedSites: ReadonlySet<string>; quarantinedDates: ReadonlySet<string> },
): AcmeProject[] {
  const projects: AcmeProject[] = [];
  const seen = new Map<string, ProjectRegisterRow>();
  let duplicates = 0;
  let conflicting = 0;
  let missingSite = 0;
  let quarantinedSite = 0;
  let missingDates = 0;
  let storeMismatch = 0;

  for (const row of rows) {
    const first = seen.get(row.projectId);
    if (first) {
      // Every register row must yield one decision, so the first row stands;
      // a conflicting repeat is reported rather than silently dropped.
      if (JSON.stringify(first) !== JSON.stringify(row)) conflicting++;
      else duplicates++;
      continue;
    }
    seen.set(row.projectId, row);

    const [storeText = "", sequenceText = ""] = row.projectId.split(".");
    const store = Number(storeText);
    const sequence = Number(sequenceText);
    const site = sitesById.get(row.siteId) ?? null;
    if (!site) {
      if (quarantined.quarantinedSites.has(row.siteId)) quarantinedSite++;
      else missingSite++;
    } else if (store !== site.locationNumber && store !== site.formerLocationNumber) {
      storeMismatch++;
    }

    const dates = datesById.get(row.projectId) ?? null;
    if (!dates && !quarantined.quarantinedDates.has(row.projectId)) missingDates++;

    const parsedName = parseProjectName(row.projectName);
    // Without a site row the banner still comes from the canonical name's code.
    const banner =
      site?.banner ??
      (parsedName.canonical ? bannerFromCode(parsedName.canonical.bannerCode) : null);

    projects.push({
      id: row.projectId,
      store,
      sequence,
      siteId: row.siteId,
      name: row.projectName,
      parsedName,
      programYear: row.programYear,
      projectType: row.projectType,
      status: row.status,
      banner,
      site,
      dates: dates
        ? {
            designStart: dates.designStart,
            permitSubmittedProjected: dates.permitSubmittedProjected,
            permitSubmittedActual: dates.permitSubmittedActual,
            permitApproved: dates.permitApproved,
            constructionStart: dates.constructionStart,
          }
        : null,
    });
  }

  warnings.push(
    ...joinWarnings({
      duplicates,
      conflicting,
      missingSite,
      quarantinedSite,
      storeMismatch,
      missingDates,
    }),
  );
  return projects;
}

function joinWarnings(counts: {
  duplicates: number;
  conflicting: number;
  missingSite: number;
  quarantinedSite: number;
  storeMismatch: number;
  missingDates: number;
}): string[] {
  const out: string[] = [];
  if (counts.duplicates > 0) {
    out.push(`Project Register: ${counts.duplicates} identical duplicate row(s) collapsed`);
  }
  if (counts.conflicting > 0) {
    out.push(
      `Project Register: ${counts.conflicting} project id(s) repeat with different content; the first row was used`,
    );
  }
  if (counts.quarantinedSite > 0) {
    out.push(
      `Project Register: ${counts.quarantinedSite} project(s) reference a site set aside for conflicting Site Directory rows`,
    );
  }
  if (counts.missingSite > 0) {
    out.push(
      `Project Register: ${counts.missingSite} project(s) reference a site missing from the Site Directory`,
    );
  }
  if (counts.storeMismatch > 0) {
    out.push(
      `Project Register: ${counts.storeMismatch} project(s) whose store number matches neither the site's current nor former location number`,
    );
  }
  if (counts.missingDates > 0) {
    out.push(`Key Dates: ${counts.missingDates} project(s) have no Key Dates row`);
  }
  return out;
}

// ---------- Pulley ----------

function toPulleyRecord(project: PulleyProject): PulleyRecord {
  return {
    id: project.id,
    name: project.name,
    parsedName: parseProjectName(project.name),
    organization: project.organization,
    banner: bannerFromLabel(project.organization),
    accountPlan: project.accountPlan,
    isPathfinder: project.accountPlan.toLowerCase() === "pathfinder",
    status: project.status,
    projectType: project.projectType,
    isSignage: project.projectType.toLowerCase() === "signage",
    jurisdictionCity: project.jurisdictionCity,
    state: project.state,
    streetAddress: project.streetAddress,
    streetKey: normalizeStreet(project.streetAddress),
    streetNameKey: streetNameKey(project.streetAddress),
    permitSubmitted: project.permitSubmitted,
    permitApproved: project.permitApproved,
    constructionStart: project.constructionStart,
    createdAt: project.createdAt,
  };
}
