import { describe, expect, it } from "vitest";
import { AuthError, NetworkError, SchemaError } from "../../src/errors.ts";
import { HttpClient } from "../../src/sources/http.ts";
import { json, noSleep, sequence, status } from "../helpers/mock-fetch.ts";

const ctx = { system: "pulley", what: "test request" } as const;

function client(responses: ReadonlyArray<Response | Error>, retries = 3) {
  const mock = sequence(responses);
  return {
    mock,
    http: new HttpClient({ fetch: mock.fetch, retries, sleep: noSleep, baseDelayMs: 1 }),
  };
}

describe("HttpClient", () => {
  it("returns a 2xx response without retrying", async () => {
    const { mock, http } = client([json({ ok: true })]);
    const response = await http.request("https://x.test/a", {}, ctx);
    expect(response.status).toBe(200);
    expect(mock.calls).toHaveLength(1);
  });

  it("maps 401 and 403 to AuthError immediately", async () => {
    for (const code of [401, 403]) {
      const { mock, http } = client([status(code)]);
      await expect(http.request("https://x.test/a", {}, ctx)).rejects.toBeInstanceOf(AuthError);
      expect(mock.calls).toHaveLength(1);
    }
  });

  it("maps 404 to SchemaError (contract change)", async () => {
    const { http } = client([status(404)]);
    await expect(http.request("https://x.test/a", {}, ctx)).rejects.toBeInstanceOf(SchemaError);
  });

  it("retries 5xx and 429 then succeeds", async () => {
    const { mock, http } = client([
      status(503),
      status(429, { "retry-after": "0" }),
      json({ ok: true }),
    ]);
    const response = await http.request("https://x.test/a", {}, ctx);
    expect(response.ok).toBe(true);
    expect(mock.calls).toHaveLength(3);
  });

  it("gives up after the configured retries with NetworkError", async () => {
    const { mock, http } = client([status(502), status(502), status(502)], 2);
    await expect(http.request("https://x.test/a", {}, ctx)).rejects.toBeInstanceOf(NetworkError);
    expect(mock.calls).toHaveLength(3);
  });

  it("retries thrown network errors and reports the last failure", async () => {
    const { http } = client([new TypeError("fetch failed"), new TypeError("fetch failed")], 1);
    await expect(http.request("https://x.test/a", {}, ctx)).rejects.toThrow(/fetch failed/);
  });

  it("does not retry other 4xx responses", async () => {
    const { mock, http } = client([status(418)]);
    await expect(http.request("https://x.test/a", {}, ctx)).rejects.toBeInstanceOf(NetworkError);
    expect(mock.calls).toHaveLength(1);
  });

  it("retries when the body fails to stream after a 200, then gives up as NetworkError", async () => {
    const broken = () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.error(new TypeError("terminated"));
          },
        }),
        { status: 200 },
      );
    const recovers = client([broken(), json({ ok: true })], 2);
    const result = await recovers.http.request("https://x.test/a", {}, ctx);
    expect(result.text()).toBe('{"ok":true}');
    expect(recovers.mock.calls).toHaveLength(2);

    const exhausted = client([broken(), broken(), broken()], 2);
    await expect(exhausted.http.request("https://x.test/a", {}, ctx)).rejects.toBeInstanceOf(
      NetworkError,
    );
    expect(exhausted.mock.calls).toHaveLength(3);
  });

  it("surfaces the upstream message for auth and non-retryable failures", async () => {
    const auth = client([
      json(
        { error: "invalid_credentials", message: "Invalid username or password." },
        { status: 401 },
      ),
    ]);
    await expect(auth.http.request("https://x.test/a", {}, ctx)).rejects.toThrow(
      /Invalid username or password/,
    );
    const cursor = client([
      json(
        { error: "invalid_cursor", message: "The cursor parameter is not valid." },
        { status: 400 },
      ),
    ]);
    await expect(cursor.http.request("https://x.test/a", {}, ctx)).rejects.toThrow(
      /cursor parameter is not valid/,
    );
    const plain = client([new Response("Service unavailable, try later", { status: 418 })]);
    await expect(plain.http.request("https://x.test/a", {}, ctx)).rejects.toThrow(/HTTP 418/);
  });

  it("redacts query strings in error details", async () => {
    const { http } = client([status(418)]);
    const error = await http
      .request("https://x.test/a?cursor=secret", {}, ctx)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NetworkError);
    expect(String((error as NetworkError).details["url"])).not.toContain("secret");
  });
});
