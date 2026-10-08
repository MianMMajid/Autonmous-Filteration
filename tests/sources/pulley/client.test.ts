import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AuthError, SchemaError } from "../../../src/errors.ts";
import { HttpClient } from "../../../src/sources/http.ts";
import { PulleyClient } from "../../../src/sources/pulley/client.ts";
import { pulleyPageSchema } from "../../../src/sources/pulley/schema.ts";
import { json, mockFetch, noSleep, status } from "../../helpers/mock-fetch.ts";

const fixturePage = JSON.parse(
  readFileSync(new URL("../../fixtures/pulley/page-1.json", import.meta.url), "utf8"),
) as { projects: Record<string, unknown>[] };

function makeClient(fetch: ReturnType<typeof mockFetch>, maxPages?: number) {
  return new PulleyClient({
    baseUrl: "https://p.test",
    apiKey: "key",
    http: new HttpClient({ fetch: fetch.fetch, retries: 0, sleep: noSleep }),
    ...(maxPages === undefined ? {} : { maxPages }),
  });
}

/** Split the fixture page into N synthetic pages linked by cursors. */
function pagesOf(sizes: number[]): Record<string, unknown>[] {
  let offset = 0;
  return sizes.map((size, index) => {
    const projects = fixturePage.projects.slice(offset, offset + size);
    offset += size;
    return { projects, next_cursor: index === sizes.length - 1 ? null : `c${index + 1}` };
  });
}

describe("pulleyPageSchema", () => {
  it("parses the real first page", () => {
    const parsed = pulleyPageSchema.parse(fixturePage);
    expect(parsed.projects).toHaveLength(100);
    expect(parsed.next_cursor).toBe("bzoxMDA");
    const first = parsed.projects[0];
    expect(first?.id).toBe("prj_en9ng6");
    expect(first?.accountPlan).toBe("full_service");
    expect(first?.permitSubmitted).toBe("2027-01-19");
    expect(first?.streetAddress).toBeNull();
  });

  it("rejects a malformed date", () => {
    const bad = {
      projects: [{ ...fixturePage.projects[0], permit_submitted: "19/01/2027" }],
      next_cursor: null,
    };
    expect(pulleyPageSchema.safeParse(bad).success).toBe(false);
  });
});

describe("PulleyClient.fetchAllProjects", () => {
  it("follows cursors until null and sends the API key", async () => {
    const pages = pagesOf([3, 3, 2]);
    const fetch = mockFetch((_url, _init, i) => json(pages[i]));
    const result = await makeClient(fetch).fetchAllProjects();
    expect(result.projects).toHaveLength(8);
    expect(result.pages).toHaveLength(3);
    expect(result.pages.map((p) => p.cursor)).toEqual([null, "c1", "c2"]);
    expect(fetch.calls[0]?.url).toBe("https://p.test/api/pulley/v1/projects");
    expect(fetch.calls[1]?.url).toBe("https://p.test/api/pulley/v1/projects?cursor=c1");
    expect(new Headers(fetch.calls[0]?.init?.headers).get("x-api-key")).toBe("key");
  });

  it("raises AuthError on 401", async () => {
    const fetch = mockFetch(() => status(401));
    await expect(makeClient(fetch).fetchAllProjects()).rejects.toBeInstanceOf(AuthError);
  });

  it("detects a looping cursor", async () => {
    const page = { projects: fixturePage.projects.slice(0, 1), next_cursor: "same" };
    const fetch = mockFetch(() => json(page));
    await expect(makeClient(fetch).fetchAllProjects()).rejects.toThrow(/looping/);
  });

  it("stops at the page cap", async () => {
    const fetch = mockFetch((_url, _init, i) => json({ projects: [], next_cursor: `c${i}` }));
    await expect(makeClient(fetch, 3).fetchAllProjects()).rejects.toThrow(/more than 3 pages/);
  });

  it("ignores duplicate ids across pages and warns", async () => {
    const dup = fixturePage.projects.slice(0, 2);
    const fetch = mockFetch((_url, _init, i) =>
      json(i === 0 ? { projects: dup, next_cursor: "c1" } : { projects: dup, next_cursor: null }),
    );
    const result = await makeClient(fetch).fetchAllProjects();
    expect(result.projects).toHaveLength(2);
    expect(result.warnings[0]).toMatch(/2 duplicate/);
  });

  it("raises SchemaError on non-JSON and on a changed shape", async () => {
    const bad = mockFetch(() => new Response("<html>", { status: 200 }));
    await expect(makeClient(bad).fetchAllProjects()).rejects.toBeInstanceOf(SchemaError);
    const changed = mockFetch(() => json({ items: [] }));
    await expect(makeClient(changed).fetchAllProjects()).rejects.toBeInstanceOf(SchemaError);
  });
});
