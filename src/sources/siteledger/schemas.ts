import { z } from "zod";

/**
 * Row schemas for the three SiteLedger reports, after header mapping.
 *
 * Structure is strict (a malformed row fails the run). Vocabulary is lenient
 * (an unknown status or type is kept as a string and reported via
 * `findUnknownValues`), so a new value in an updated dataset does not crash
 * the sync. See docs/ARCHITECTURE.md, "Boundaries and validation".
 */

// ---------- Known vocabularies (observed 2026-10-08 plus supported signage) ----------

export const ACME_STATUSES = ["Active", "Deferred", "Closed"] as const;
export const ACME_BANNERS = ["Acme Market", "Acme Warehouse Club"] as const;
export const ACME_PROJECT_TYPES = [
  "Remodel",
  "EV Charging",
  "Coffee Tenant",
  "Pharmacy Relocation",
  "Expansion",
  "Deli Remodel",
  "New Build",
  "Signage",
] as const;

// ---------- Cell-level helpers ----------

/** Spreadsheet cells arrive as string, number, or null. Coerce to trimmed text. */
const cellText = z.union([z.string(), z.number()]).transform((value) => String(value).trim());

const nonEmptyText = cellText.pipe(z.string().min(1, "must not be empty"));

const optionalText = z.union([cellText, z.null(), z.undefined()]).transform((value) => value ?? "");

const integerCell = z
  .union([z.number(), z.string().trim().regex(/^\d+$/, "expected an integer")])
  .transform((value) => Number(value))
  .pipe(z.number().int("expected an integer"));

const optionalIntegerCell = z
  .union([z.null(), z.undefined(), z.literal(""), integerCell])
  .transform((value) => (value === "" || value === undefined ? null : value));

export const acmeProjectIdSchema = cellText.pipe(
  z.string().regex(/^\d{4}\.\d{4}$/, "expected store.sequence such as 1556.1002"),
);

const siteIdSchema = cellText.pipe(
  z.string().regex(/^ST-\d+$/, "expected a site id such as ST-12345"),
);

const stateSchema = cellText.pipe(
  z
    .string()
    .regex(/^[A-Za-z]{2}$/, "expected a two-letter state")
    .transform((s) => s.toUpperCase()),
);

/** ZIP may lose leading zeros if the sheet stored it as a number. Restore them. */
const zipSchema = cellText.pipe(
  z
    .string()
    .regex(/^\d{1,5}(-\d{4})?$/, "expected a ZIP code")
    .transform((zip) => {
      const [five = "", plus4] = zip.split("-");
      const padded = five.padStart(5, "0");
      return plus4 ? `${padded}-${plus4}` : padded;
    }),
);

const US_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Report date cell to ISO `YYYY-MM-DD`, or null when blank.
 *
 * The Key Dates export mixes `MM/DD/YYYY` and `YYYY-MM-DD` in the same column
 * (observed 2026-10-08: roughly 5 to 1). Both are accepted; impossible dates
 * such as 02/30 are rejected.
 */
export const reportDateSchema = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((raw, ctx) => {
    const text = (raw ?? "").trim();
    if (text === "") return null;
    let year: number;
    let month: number;
    let day: number;
    const us = US_DATE.exec(text);
    const iso = ISO_DATE.exec(text);
    if (us) {
      month = Number(us[1]);
      day = Number(us[2]);
      year = Number(us[3]);
    } else if (iso) {
      year = Number(iso[1]);
      month = Number(iso[2]);
      day = Number(iso[3]);
    } else {
      ctx.addIssue({ code: "custom", message: `expected MM/DD/YYYY or YYYY-MM-DD, got "${text}"` });
      return z.NEVER;
    }
    const date = new Date(Date.UTC(year, month - 1, day));
    const valid =
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day;
    if (!valid) {
      ctx.addIssue({ code: "custom", message: `impossible date "${text}"` });
      return z.NEVER;
    }
    return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  });

// ---------- Report row schemas ----------

export const projectRegisterRowSchema = z.object({
  projectId: acmeProjectIdSchema,
  siteId: siteIdSchema,
  projectName: nonEmptyText,
  programYear: integerCell.pipe(z.number().min(2000).max(2100)),
  projectType: nonEmptyText,
  status: nonEmptyText,
});
export type ProjectRegisterRow = z.output<typeof projectRegisterRowSchema>;

export const siteDirectoryRowSchema = z.object({
  siteId: siteIdSchema,
  banner: nonEmptyText,
  locationNumber: integerCell,
  formerLocationNumber: optionalIntegerCell,
  streetAddress: nonEmptyText,
  mailingCity: nonEmptyText,
  state: stateSchema,
  zip: zipSchema,
  county: optionalText,
});
export type SiteDirectoryRow = z.output<typeof siteDirectoryRowSchema>;

export const keyDatesRowSchema = z.object({
  projectId: acmeProjectIdSchema,
  designStart: reportDateSchema,
  permitSubmittedProjected: reportDateSchema,
  permitSubmittedActual: reportDateSchema,
  permitApproved: reportDateSchema,
  constructionStart: reportDateSchema,
});
export type KeyDatesRow = z.output<typeof keyDatesRowSchema>;

// ---------- Header contracts ----------

export interface ColumnSpec {
  /** Header text exactly as it appears in the report. */
  readonly header: string;
  /** Key in the row object fed to the schema. */
  readonly key: string;
}

export const PROJECT_REGISTER_COLUMNS: readonly ColumnSpec[] = [
  { header: "Project ID", key: "projectId" },
  { header: "Site ID", key: "siteId" },
  { header: "Project Name", key: "projectName" },
  { header: "Program Year", key: "programYear" },
  { header: "Project Type", key: "projectType" },
  { header: "Status", key: "status" },
];

export const SITE_DIRECTORY_COLUMNS: readonly ColumnSpec[] = [
  { header: "Site ID", key: "siteId" },
  { header: "Banner", key: "banner" },
  { header: "Location #", key: "locationNumber" },
  { header: "Former Location #", key: "formerLocationNumber" },
  { header: "Street Address", key: "streetAddress" },
  { header: "Mailing City", key: "mailingCity" },
  { header: "State", key: "state" },
  { header: "ZIP", key: "zip" },
  { header: "County", key: "county" },
];

export const KEY_DATES_COLUMNS: readonly ColumnSpec[] = [
  { header: "Project ID", key: "projectId" },
  { header: "Design Start", key: "designStart" },
  { header: "Permit Submitted (Projected)", key: "permitSubmittedProjected" },
  { header: "Permit Submitted (Actual)", key: "permitSubmittedActual" },
  { header: "Permit Approved", key: "permitApproved" },
  { header: "Construction Start", key: "constructionStart" },
];
