import { z } from "zod";
import { SchemaError } from "../../errors.ts";
import type { Logger } from "../../logger.ts";
import type { HttpClient } from "../http.ts";

/**
 * SiteLedger portal client.
 *
 * The portal has no documented API. These endpoints are the ones its own
 * front-end script calls (`/js/siteledger.js`): a JSON sign-in that returns a
 * bearer token valid for 24 hours, and one download endpoint per report.
 */

export const REPORT_IDS = ["project-register", "site-directory", "key-dates"] as const;
export type ReportId = (typeof REPORT_IDS)[number];

export interface SiteLedgerSession {
  readonly token: string;
  readonly expiresAt: string;
}

export interface DownloadedReport {
  readonly id: ReportId;
  readonly filename: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

export interface SiteLedgerClientOptions {
  readonly baseUrl: string;
  readonly username: string;
  readonly password: string;
  readonly http: HttpClient;
  readonly log?: Logger;
}

const loginResponseSchema = z.object({
  token: z.string().min(1),
  expiresAt: z.string().min(1),
});

export class SiteLedgerClient {
  readonly #baseUrl: string;
  readonly #username: string;
  readonly #password: string;
  readonly #http: HttpClient;
  readonly #log: Logger | undefined;

  constructor(options: SiteLedgerClientOptions) {
    this.#baseUrl = options.baseUrl;
    this.#username = options.username;
    this.#password = options.password;
    this.#http = options.http;
    this.#log = options.log;
  }

  async login(): Promise<SiteLedgerSession> {
    const response = await this.#http.request(
      `${this.#baseUrl}/api/auth/login`,
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ username: this.#username, password: this.#password }),
      },
      { system: "siteledger", what: "SiteLedger sign-in" },
    );
    const body: unknown = await response.json().catch(() => undefined);
    const parsed = loginResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new SchemaError("SiteLedger sign-in succeeded but returned an unexpected body", {
        details: { issues: parsed.error.issues.map((issue) => issue.message) },
      });
    }
    this.#log?.info({ expiresAt: parsed.data.expiresAt }, "SiteLedger signed in");
    return parsed.data;
  }

  async downloadReport(id: ReportId, session: SiteLedgerSession): Promise<DownloadedReport> {
    const response = await this.#http.request(
      `${this.#baseUrl}/api/reports/${encodeURIComponent(id)}`,
      { method: "GET", headers: { authorization: `Bearer ${session.token}` } },
      { system: "siteledger", what: `SiteLedger report "${id}"` },
    );
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0) {
      throw new SchemaError(`SiteLedger report "${id}" downloaded but is empty`);
    }
    const report: DownloadedReport = {
      id,
      filename: filenameFrom(response.headers.get("content-disposition"), id),
      contentType: response.headers.get("content-type") ?? "application/octet-stream",
      bytes,
    };
    this.#log?.info(
      { report: id, bytes: bytes.byteLength, filename: report.filename },
      "report downloaded",
    );
    return report;
  }

  async downloadAll(session: SiteLedgerSession): Promise<Record<ReportId, DownloadedReport>> {
    const [projectRegister, siteDirectory, keyDates] = await Promise.all([
      this.downloadReport("project-register", session),
      this.downloadReport("site-directory", session),
      this.downloadReport("key-dates", session),
    ]);
    return {
      "project-register": projectRegister,
      "site-directory": siteDirectory,
      "key-dates": keyDates,
    };
  }
}

/** Extract the filename from a Content-Disposition header, falling back to the report id. */
export function filenameFrom(header: string | null, fallback: string): string {
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header ?? "");
  const name = match?.[1]?.trim();
  if (!name) return fallback;
  // Defensive: never let an upstream header produce a path.
  return name.replace(/[\\/]/g, "_");
}
