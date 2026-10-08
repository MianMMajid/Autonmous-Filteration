import type { FetchLike } from "../../src/sources/http.ts";

export interface RecordedCall {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

export interface MockFetch {
  readonly fetch: FetchLike;
  readonly calls: RecordedCall[];
}

type Handler = (
  url: string,
  init: RequestInit | undefined,
  callIndex: number,
) => Response | Promise<Response>;

/** Build a `fetch` double that records calls and delegates to `handler`. */
export function mockFetch(handler: Handler): MockFetch {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init, calls.length - 1);
  };
  return { fetch, calls };
}

/** A fetch double that returns the given responses in order, then throws. */
export function sequence(responses: ReadonlyArray<Response | Error>): MockFetch {
  return mockFetch((_url, _init, index) => {
    const next = responses[index];
    if (next === undefined) throw new Error(`unexpected call #${index + 1}`);
    if (next instanceof Error) throw next;
    return next;
  });
}

export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

export function status(code: number, headers: Record<string, string> = {}): Response {
  return new Response(`status ${code}`, { status: code, headers });
}

export const noSleep = async (): Promise<void> => {};
