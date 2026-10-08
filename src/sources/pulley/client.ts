import { SchemaError } from "../../errors.ts";
import type { Logger } from "../../logger.ts";
import type { HttpClient } from "../http.ts";
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
    const projects: PulleyProject[] = [];
    const pages: RawPage[] = [];
    const warnings: string[] = [];
    const seenIds = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    let duplicates = 0;

    for (;;) {
      if (pages.length >= this.#maxPages) {
        throw new SchemaError(
          `Pulley API: more than ${this.#maxPages} pages without reaching the end; pagination may be broken`,
        );
      }
      const page = await this.#fetchPage(cursor, pages.length + 1);
      pages.push({ cursor, body: page.body });

      for (const project of page.projects) {
        if (seenIds.has(project.id)) {
          duplicates++;
          continue;
        }
        seenIds.add(project.id);
        projects.push(project);
      }

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
    const body = await response.text();

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
