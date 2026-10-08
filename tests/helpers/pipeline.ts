import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../../src/logger.ts";
import { runSync } from "../../src/run/sync.ts";
import { HttpClient } from "../../src/sources/http.ts";

export const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url));
export function pipeline(dataDir: string) {
  let projects = JSON.parse(fixture("pulley/projects-all.json").toString()) as Record<
    string,
    unknown
  >[];
  let calls = 0;
  const config = {
    siteLedger: { baseUrl: "https://sl.test", username: "fixture", password: "fixture" },
    pulley: { baseUrl: "https://p.test", apiKey: "fixture" },
    logLevel: "error" as const,
    dataDir,
    retainRuns: 60,
    overridesFile: join(dataDir, "overrides.csv"),
  };
  const http = new HttpClient({
    retries: 0,
    fetch: async (url) => {
      calls++;
      if (url.endsWith("/api/auth/login"))
        return Response.json({ token: "fixture", expiresAt: "2099-01-01T00:00:00Z" });
      for (const [route, file] of [
        ["project-register", "project-register.xls"],
        ["site-directory", "site-directory.xlsx"],
        ["key-dates", "key-dates.csv"],
      ]) {
        if (url.endsWith(`/api/reports/${route}`))
          return new Response(fixture(`siteledger/${file}`));
      }
      return Response.json({ projects, next_cursor: null });
    },
  });
  return {
    config,
    calls: () => calls,
    collapse: () => {
      projects = projects.slice(0, 1);
    },
    run: (time = "2026-10-08T10:00:00Z") =>
      runSync({
        config,
        http,
        log: createLogger("error", false),
        dryRun: false,
        now: () => new Date(time),
      }),
  };
}
