import { describe, expect, it } from "vitest";
import { AuthError, SchemaError } from "../../../src/errors.ts";
import { HttpClient } from "../../../src/sources/http.ts";
import { filenameFrom, SiteLedgerClient } from "../../../src/sources/siteledger/client.ts";
import { json, mockFetch, noSleep, status } from "../../helpers/mock-fetch.ts";

const base = "https://sl.test";

function makeClient(fetch: ReturnType<typeof mockFetch>) {
  return new SiteLedgerClient({
    baseUrl: base,
    username: "user",
    password: "pass",
    http: new HttpClient({ fetch: fetch.fetch, retries: 0, sleep: noSleep }),
  });
}

describe("SiteLedgerClient.login", () => {
  it("posts JSON credentials and returns the session", async () => {
    const fetch = mockFetch(() => json({ token: "tok", expiresAt: "2026-10-09T00:00:00Z" }));
    const session = await makeClient(fetch).login();
    expect(session.token).toBe("tok");
    const call = fetch.calls[0];
    expect(call?.url).toBe(`${base}/api/auth/login`);
    expect(call?.init?.method).toBe("POST");
    expect(JSON.parse(String(call?.init?.body))).toEqual({ username: "user", password: "pass" });
  });

  it("raises AuthError on 401", async () => {
    const fetch = mockFetch(() => status(401));
    await expect(makeClient(fetch).login()).rejects.toBeInstanceOf(AuthError);
  });

  it("raises SchemaError when the body has no token", async () => {
    const fetch = mockFetch(() => json({ message: "weird" }));
    await expect(makeClient(fetch).login()).rejects.toBeInstanceOf(SchemaError);
  });
});

describe("SiteLedgerClient.downloadReport", () => {
  const session = { token: "tok", expiresAt: "x" };

  it("sends the bearer token and returns bytes with the server filename", async () => {
    const fetch = mockFetch(
      () =>
        new Response(new Uint8Array([1, 2, 3]), {
          headers: {
            "content-type": "text/csv",
            "content-disposition": 'attachment; filename="Acme_KeyDates_20261008.csv"',
          },
        }),
    );
    const report = await makeClient(fetch).downloadReport("key-dates", session);
    expect(fetch.calls[0]?.url).toBe(`${base}/api/reports/key-dates`);
    expect(new Headers(fetch.calls[0]?.init?.headers).get("authorization")).toBe("Bearer tok");
    expect(report.filename).toBe("Acme_KeyDates_20261008.csv");
    expect(report.contentType).toBe("text/csv");
    expect([...report.bytes]).toEqual([1, 2, 3]);
  });

  it("rejects an empty download", async () => {
    const fetch = mockFetch(() => new Response(new Uint8Array(0)));
    await expect(makeClient(fetch).downloadReport("key-dates", session)).rejects.toBeInstanceOf(
      SchemaError,
    );
  });

  it("downloadAll fetches the three reports", async () => {
    const fetch = mockFetch(() => new Response(new Uint8Array([9])));
    const all = await makeClient(fetch).downloadAll(session);
    expect(Object.keys(all).sort()).toEqual(["key-dates", "project-register", "site-directory"]);
    expect(fetch.calls).toHaveLength(3);
  });
});

describe("filenameFrom", () => {
  it("parses quoted and bare filenames", () => {
    expect(filenameFrom('attachment; filename="a.xls"', "f")).toBe("a.xls");
    expect(filenameFrom("attachment; filename=b.csv", "f")).toBe("b.csv");
  });
  it("falls back and strips path separators", () => {
    expect(filenameFrom(null, "key-dates")).toBe("key-dates");
    expect(filenameFrom('attachment; filename="../x.csv"', "f")).toBe(".._x.csv");
  });
});
