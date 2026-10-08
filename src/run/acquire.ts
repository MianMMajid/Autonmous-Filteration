import type { Config } from "../config.ts";
import { SchemaError } from "../errors.ts";
import type { Logger } from "../logger.ts";
import { HttpClient } from "../sources/http.ts";
import { dedupeProjects, PulleyClient } from "../sources/pulley/client.ts";
import {
  PULLEY_ACCOUNT_PLANS,
  PULLEY_ORGANIZATIONS,
  PULLEY_PROJECT_TYPES,
  PULLEY_STATUSES,
  type PulleyProject,
  pulleyPageSchema,
} from "../sources/pulley/schema.ts";
import { SiteLedgerClient } from "../sources/siteledger/client.ts";
import {
  parseKeyDates,
  parseProjectRegister,
  parseSiteDirectory,
} from "../sources/siteledger/parse.ts";
import {
  ACME_BANNERS,
  ACME_PROJECT_TYPES,
  ACME_STATUSES,
  type KeyDatesRow,
  type ProjectRegisterRow,
  type SiteDirectoryRow,
} from "../sources/siteledger/schemas.ts";
import { findUnknownValues, type VocabularyWarning } from "../sources/vocab.ts";
import {
  type ArchiveManifestFile,
  createRunId,
  loadArchive,
  loadLatestArchive,
  RawArchive,
} from "./archive.ts";

/**
 * Acquisition: fetch (or replay) every input, archive raw bytes, parse and
 * validate, and report vocabulary drift. Produces the typed inputs the
 * normalization and matching phases consume.
 */

export interface AcquiredInputs {
  readonly runId: string;
  /** "live" when fetched from both systems; "archive" when replayed via --dry-run. */
  readonly source: "live" | "archive";
  readonly archiveDirectory: string;
  /** When the source bytes were fetched from the upstream systems (not when this run happened). */
  readonly sourceAcquiredAt: string;
  /** Manifest entries (name, kind, size, hash) of the archived inputs this run used. */
  readonly archiveFiles: readonly ArchiveManifestFile[];
  readonly acme: {
    readonly projects: readonly ProjectRegisterRow[];
    readonly sites: readonly SiteDirectoryRow[];
    readonly keyDates: readonly KeyDatesRow[];
  };
  readonly pulley: readonly PulleyProject[];
  readonly warnings: readonly string[];
  readonly vocabulary: readonly VocabularyWarning[];
}

export interface AcquireOptions {
  readonly config: Config;
  readonly log: Logger;
  readonly dryRun: boolean;
  /** With dryRun: replay this archived run instead of the newest one. */
  readonly replayRunId?: string;
  /** Injection point for tests. */
  readonly http?: HttpClient;
  readonly now?: () => Date;
}

export async function acquireInputs(options: AcquireOptions): Promise<AcquiredInputs> {
  return options.dryRun ? replayArchive(options) : fetchLive(options);
}

// ---------- Live ----------

async function fetchLive(options: AcquireOptions): Promise<AcquiredInputs> {
  const { config, log } = options;
  const now = options.now ?? (() => new Date());
  const http = options.http ?? new HttpClient({ log });
  const runId = createRunId(now());
  const archive = new RawArchive(config.dataDir, runId);
  await archive.init();

  const siteLedger = new SiteLedgerClient({ ...config.siteLedger, http, log });
  const pulley = new PulleyClient({ ...config.pulley, http, log });

  // Both systems are independent; fetch them concurrently.
  const [reports, pulleyResult] = await Promise.all([
    siteLedger.login().then((session) => siteLedger.downloadAll(session)),
    pulley.fetchAllProjects(),
  ]);

  await Promise.all([
    archive.write(
      "project-register.xls",
      "project-register",
      reports["project-register"].bytes,
      undefined,
      reports["project-register"].filename,
    ),
    archive.write(
      "site-directory.xlsx",
      "site-directory",
      reports["site-directory"].bytes,
      undefined,
      reports["site-directory"].filename,
    ),
    archive.write(
      "key-dates.csv",
      "key-dates",
      reports["key-dates"].bytes,
      undefined,
      reports["key-dates"].filename,
    ),
    ...pulleyResult.pages.map((page, index) =>
      archive.write(
        `pulley-projects.page-${String(index + 1).padStart(3, "0")}.json`,
        "pulley-page",
        page.body,
        index + 1,
      ),
    ),
  ]);
  const manifest = await archive.finalize(now());
  log.info({ directory: archive.directory }, "raw inputs archived");

  const parsed = parseAll({
    projectRegister: reports["project-register"].bytes,
    siteDirectory: reports["site-directory"].bytes,
    keyDates: reports["key-dates"].bytes,
    pulley: pulleyResult.projects,
    warnings: [...pulleyResult.warnings],
  });

  return {
    runId,
    source: "live",
    archiveDirectory: archive.directory,
    sourceAcquiredAt: manifest.createdAt,
    archiveFiles: manifest.files,
    ...parsed,
  };
}

// ---------- Replay ----------

async function replayArchive(options: AcquireOptions): Promise<AcquiredInputs> {
  const { config, log } = options;
  const archive = options.replayRunId
    ? await loadArchive(config.dataDir, options.replayRunId)
    : await loadLatestArchive(config.dataDir);
  if (!archive) {
    throw new SchemaError(
      options.replayRunId
        ? `No archived inputs for run ${options.replayRunId} under ${config.dataDir}/raw.`
        : `No archived inputs found under ${config.dataDir}/raw. Run without --dry-run at least once first.`,
    );
  }
  log.info(
    { directory: archive.directory, runId: archive.manifest.runId },
    "replaying archived inputs",
  );

  const one = (kind: ArchiveManifestFile["kind"]): ArchiveManifestFile => {
    const file = archive.manifest.files.find((entry) => entry.kind === kind);
    if (!file) throw new SchemaError(`Archive ${archive.directory} has no "${kind}" file`);
    return file;
  };
  const pageFiles = archive.manifest.files
    .filter((entry) => entry.kind === "pulley-page")
    .sort((a, b) => (a.page ?? 0) - (b.page ?? 0));
  if (pageFiles.length === 0) {
    throw new SchemaError(`Archive ${archive.directory} has no Pulley pages`);
  }

  const [projectRegister, siteDirectory, keyDates, ...pages] = await Promise.all([
    archive.read(one("project-register")),
    archive.read(one("site-directory")),
    archive.read(one("key-dates")),
    ...pageFiles.map((file) => archive.read(file)),
  ]);

  const decoder = new TextDecoder("utf-8");
  const pulley: PulleyProject[] = [];
  for (const [index, bytes] of pages.entries()) {
    let json: unknown;
    try {
      json = JSON.parse(decoder.decode(bytes));
    } catch (error) {
      throw new SchemaError(`Archived Pulley page ${index + 1} is not valid JSON`, {
        cause: error,
      });
    }
    const result = pulleyPageSchema.safeParse(json);
    if (!result.success) {
      throw new SchemaError(`Archived Pulley page ${index + 1} did not match the expected shape`, {
        details: { issues: result.error.issues.slice(0, 10).map((issue) => issue.message) },
      });
    }
    pulley.push(...result.data.projects);
  }

  const deduped = dedupeProjects(pulley);
  const parsed = parseAll({
    projectRegister,
    siteDirectory,
    keyDates,
    pulley: deduped.projects,
    warnings:
      deduped.duplicates > 0
        ? [`Archive: ${deduped.duplicates} duplicate project id(s) across pages were ignored`]
        : [],
  });
  return {
    runId: createRunId(options.now?.() ?? new Date()),
    source: "archive",
    archiveDirectory: archive.directory,
    sourceAcquiredAt: archive.manifest.createdAt,
    archiveFiles: archive.manifest.files,
    ...parsed,
  };
}

// ---------- Shared ----------

interface ParseAllInput {
  readonly projectRegister: Uint8Array;
  readonly siteDirectory: Uint8Array;
  readonly keyDates: Uint8Array;
  readonly pulley: readonly PulleyProject[];
  readonly warnings: string[];
}

function parseAll(
  input: ParseAllInput,
): Omit<
  AcquiredInputs,
  "runId" | "source" | "archiveDirectory" | "archiveFiles" | "sourceAcquiredAt"
> {
  const register = parseProjectRegister(input.projectRegister);
  const sites = parseSiteDirectory(input.siteDirectory);
  const keyDates = parseKeyDates(input.keyDates);
  const warnings = [
    ...input.warnings,
    ...register.warnings,
    ...sites.warnings,
    ...keyDates.warnings,
  ];

  const vocabulary: VocabularyWarning[] = [
    ...findUnknownValues("acme", "status", register.rows, (r) => r.status, ACME_STATUSES),
    ...findUnknownValues(
      "acme",
      "projectType",
      register.rows,
      (r) => r.projectType,
      ACME_PROJECT_TYPES,
    ),
    ...findUnknownValues("acme", "banner", sites.rows, (r) => r.banner, ACME_BANNERS),
    ...findUnknownValues(
      "pulley",
      "organization",
      input.pulley,
      (p) => p.organization,
      PULLEY_ORGANIZATIONS,
    ),
    ...findUnknownValues(
      "pulley",
      "accountPlan",
      input.pulley,
      (p) => p.accountPlan,
      PULLEY_ACCOUNT_PLANS,
    ),
    ...findUnknownValues("pulley", "status", input.pulley, (p) => p.status, PULLEY_STATUSES),
    ...findUnknownValues(
      "pulley",
      "projectType",
      input.pulley,
      (p) => p.projectType,
      PULLEY_PROJECT_TYPES,
    ),
  ];

  return {
    acme: { projects: register.rows, sites: sites.rows, keyDates: keyDates.rows },
    pulley: input.pulley,
    warnings,
    vocabulary,
  };
}
