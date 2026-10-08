import { SchemaError } from "../../errors.ts";
import type { Logger } from "../../logger.ts";
import type { HttpClient } from "../http.ts";
import { MAX_ROWS } from "../limits.ts";
import { type PulleyProject, pulleyPageSchema } from "./schema.ts";

/**
 * Pulley projects API client with cursor pagination.
 *
 * Guards against the two ways pagination can go wrong on a changed backend:
 * a cursor that repeats (infinite loop) and a page count that never ends.
 * Both are reported as `SchemaError` because they mean the contract changed.
 */

export interface PulleyClientOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly http: HttpClient;
  readonly log?: Logger;
  /** Upper bound on pages before the run is aborted. Default 200 (20,000 projects). */
  readonly maxPages?: number;
}

export interface RawPage {
  /** Cursor used to request this page; null for the first page. */
  readonly cursor: string | null;
  /** Exact response text, for archiving. */
  readonly body: string;
}

export interface PulleyFetchResult {
  readonly projects: readonly PulleyProject[];
  readonly pages: readonly RawPage[];
  readonly warnings: readonly string[];
}

/**
 * Collapse identical repeats only. Conflicting versions mean the snapshot is
 * inconsistent: refuse it rather than let page order decide identity or status.
 * Shared by live acquisition and replay.
 */
export function dedupeProjects(projects: readonly PulleyProject[]): {
  readonly projects: PulleyProject[];
  readonly duplicates: number;
} {
  const seen = new Map<string, PulleyProject>();
  const unique: PulleyProject[] = [];
  let duplicates = 0;
  for (const project of projects) {
    const first = seen.get(project.id);
    if (first) {
      const fields = (Object.keys(first) as Array<keyof PulleyProject>)
        .filter((key) => first[key] !== project[key])
        .sort();
      if (fields.length > 0) {
        throw new SchemaError(
          `Pulley project ${project.id} has conflicting duplicate records (${fields.join(", ")}); retry acquisition or correct the source before publishing`,
          { details: { projectId: project.id, conflictingFields: fields } },
        );
      }
      duplicates++;
      continue;
    }
    seen.set(project.id, project);
    unique.push(project);
  }
  return { projects: unique, duplicates };
}

export class PulleyClient {
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #http: HttpClient;
  readonly #log: Logger | undefined;
  readonly #maxPages: number;

  constructor(options: PulleyClientOptions) {
    this.#baseUrl = options.baseUrl;
    this.#apiKey = options.apiKey;
    this.#http = options.http;
    this.#log = options.log;
    this.#maxPages = options.maxPages ?? 200;
  }

  async fetchAllProjects(): Promise<PulleyFetchResult> {
    const all: PulleyProject[] = [];
    const pages: RawPage[] = [];
    const warnings: string[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    let totalBytes = 0;

    for (;;) {
      if (pages.length >= this.#maxPages) {
        throw new SchemaError(
          `Pulley API: more than ${this.#maxPages} pages without reaching the end; pagination may be broken`,
        );
      }
      const page = await this.#fetchPage(cursor, pages.length + 1);
      totalBytes += Buffer.byteLength(page.body);
      if (totalBytes > 96 * 1024 * 1024)
        throw new SchemaError("Pulley snapshot exceeds 96 MiB total byte limit");
      pages.push({ cursor, body: page.body });
      if (all.length + page.projects.length > MAX_ROWS)
        throw new SchemaError(`Pulley projects exceed ${MAX_ROWS} row limit`);
      all.push(...page.projects);

      const next: string | null = page.nextCursor;
      if (next === null) break;
      if (seenCursors.has(next)) {
        throw new SchemaError(
          `Pulley API: cursor "${next}" was returned twice; pagination is looping`,
        );
      }
      seenCursors.add(next);
      cursor = next;
    }

    const { projects, duplicates } = dedupeProjects(all);
    if (duplicates > 0) {
      warnings.push(`Pulley API: ${duplicates} duplicate project id(s) across pages were ignored`);
    }
    this.#log?.info({ projects: projects.length, pages: pages.length }, "Pulley projects fetched");
    return { projects, pages, warnings };
  }

  async #fetchPage(
    cursor: string | null,
    pageNumber: number,
  ): Promise<{ projects: PulleyProject[]; nextCursor: string | null; body: string }> {
    const url = new URL("/api/pulley/v1/projects", this.#baseUrl);
    if (cursor !== null) url.searchParams.set("cursor", cursor);

    const response = await this.#http.request(
      url.toString(),
      { method: "GET", headers: { "x-api-key": this.#apiKey, accept: "application/json" } },
      { system: "pulley", what: `Pulley projects page ${pageNumber}` },
    );
    const body = response.text();

    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch (error) {
      throw new SchemaError(`Pulley projects page ${pageNumber}: response is not valid JSON`, {
        cause: error,
      });
    }

    const parsed = pulleyPageSchema.safeParse(json);
    if (!parsed.success) {
      const problems = parsed.error.issues
        .slice(0, 10)
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`);
      throw new SchemaError(
        `Pulley projects page ${pageNumber}: response did not match the expected shape`,
        {
          details: { problems },
        },
      );
    }
    return { projects: parsed.data.projects, nextCursor: parsed.data.next_cursor, body };
  }
}
