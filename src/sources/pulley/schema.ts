import { z } from "zod";

/**
 * Pulley API response shapes.
 *
 * Structure is strict; categorical values are plain strings checked against
 * the known vocabularies below via `findUnknownValues`, so a new status or
 * type in an updated dataset is reported rather than fatal.
 */

export const PULLEY_ORGANIZATIONS = ["Acme Market", "Acme Warehouse Club"] as const;
export const PULLEY_ACCOUNT_PLANS = ["full_service", "pathfinder"] as const;
export const PULLEY_STATUSES = ["In Progress", "On Hold", "Draft", "Canceled", "Complete"] as const;
export const PULLEY_PROJECT_TYPES = [
  "Remodel",
  "EV Charging",
  "Coffee Tenant",
  "Pharmacy Relocation",
  "Expansion",
  "Deli Remodel",
  "New Build",
  "Signage",
] as const;

const isoDateOrNull = z.iso.date().nullable();

const rawProjectSchema = z.object({
  id: z.string().regex(/^prj_[A-Za-z0-9]+$/, "expected a Pulley id such as prj_7f3k2q"),
  name: z.string(),
  organization: z.string().min(1),
  account_plan: z.string().min(1),
  status: z.string().min(1),
  project_type: z.string().min(1),
  jurisdiction_city: z.string(),
  state: z.string().regex(/^[A-Za-z]{2}$/, "expected a two-letter state"),
  street_address: z.string().nullable(),
  permit_submitted: isoDateOrNull,
  permit_approved: isoDateOrNull,
  construction_start: isoDateOrNull,
  created_at: z.iso.datetime(),
});

export const pulleyProjectSchema = rawProjectSchema.transform((raw) => ({
  id: raw.id,
  name: raw.name,
  organization: raw.organization,
  accountPlan: raw.account_plan,
  status: raw.status,
  projectType: raw.project_type,
  jurisdictionCity: raw.jurisdiction_city,
  state: raw.state.toUpperCase(),
  streetAddress: raw.street_address,
  permitSubmitted: raw.permit_submitted,
  permitApproved: raw.permit_approved,
  constructionStart: raw.construction_start,
  createdAt: raw.created_at,
}));

export type PulleyProject = z.output<typeof pulleyProjectSchema>;

export const pulleyPageSchema = z.object({
  projects: z.array(pulleyProjectSchema),
  next_cursor: z.string().min(1).nullable(),
});

export type PulleyPage = z.output<typeof pulleyPageSchema>;
