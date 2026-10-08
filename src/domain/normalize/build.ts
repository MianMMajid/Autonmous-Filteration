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
  const sites = inputs.acme.sites.map(toSite);
  const sitesById = new Map(sites.map((site) => [site.siteId, site]));
  const sitesByLocation = indexSitesByLocation(sites);
  const datesById = new Map(inputs.acme.keyDates.map((row) => [row.projectId, row]));

  const acme = buildAcmeProjects(inputs.acme.projects, sitesById, datesById, warnings);
  const pulley = inputs.pulley.map(toPulleyRecord);

  return { acme, sites, sitesByLocation, pulley, warnings };
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
): AcmeProject[] {
  const projects: AcmeProject[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  let missingSite = 0;
  let missingDates = 0;
  let storeMismatch = 0;

  for (const row of rows) {
    if (seen.has(row.projectId)) {
      duplicates++;
      continue;
    }
    seen.add(row.projectId);

    const [storeText = "", sequenceText = ""] = row.projectId.split(".");
    const store = Number(storeText);
    const sequence = Number(sequenceText);
    const site = sitesById.get(row.siteId) ?? null;
    if (!site) missingSite++;
    else if (store !== site.locationNumber && store !== site.formerLocationNumber) storeMismatch++;

    const dates = datesById.get(row.projectId) ?? null;
    if (!dates) missingDates++;

    projects.push({
      id: row.projectId,
      store,
      sequence,
      siteId: row.siteId,
      name: row.projectName,
      parsedName: parseProjectName(row.projectName),
      programYear: row.programYear,
      projectType: row.projectType,
      status: row.status,
      banner: site?.banner ?? null,
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

  if (duplicates > 0)
    warnings.push(`Project Register: ${duplicates} duplicate project id(s) ignored`);
  if (missingSite > 0)
    warnings.push(
      `Project Register: ${missingSite} project(s) reference a site missing from the Site Directory`,
    );
  if (storeMismatch > 0)
    warnings.push(
      `Project Register: ${storeMismatch} project(s) whose store number matches neither the site's current nor former location number`,
    );
  if (missingDates > 0)
    warnings.push(`Key Dates: ${missingDates} project(s) have no Key Dates row`);
  return projects;
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
