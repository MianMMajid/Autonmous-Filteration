import { AuthError, NetworkError, SchemaError, type SyncError } from "../errors.ts";
import type { Logger } from "../logger.ts";

/**
 * Thin wrapper over `fetch` that turns transport problems into typed errors.
 *
 * Policy:
 * - 2xx: returned to the caller.
 * - 401 / 403: `AuthError` immediately. Retrying bad credentials is pointless.
 * - 404: `SchemaError`. The endpoint we rely on has moved; that is a contract change.
 * - 408 / 425 / 429 / 5xx and thrown network errors (including timeouts):
 *   retried with exponential backoff and jitter, honoring `Retry-After`,
 *   then `NetworkError`.
 * - Any other status: `NetworkError` without retry.
 *
 * Error messages include the upstream JSON `message` when one is present, so
 * "HTTP 400: The cursor parameter is not valid." reaches the operator intact.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpClientOptions {
  readonly fetch?: FetchLike;
  /** Number of retries after the first attempt. Default 3. */
  readonly retries?: number;
  /** Per-attempt timeout. Default 30 s. */
  readonly timeoutMs?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly log?: Logger;
}

export interface RequestContext {
  readonly system: "siteledger" | "pulley";
  /** Human description used in error messages, e.g. "SiteLedger sign-in". */
  readonly what: string;
}

type Attempt =
  | { readonly kind: "response"; readonly response: Response }
  | { readonly kind: "failure"; readonly error: unknown };

const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 425, 429, 500, 502, 503, 504]);

export class HttpClient {
  readonly #fetch: FetchLike;
  readonly #retries: number;
  readonly #timeoutMs: number;
  readonly #baseDelayMs: number;
  readonly #maxDelayMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #log: Logger | undefined;

  constructor(options: HttpClientOptions = {}) {
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#retries = options.retries ?? 3;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#baseDelayMs = options.baseDelayMs ?? 500;
    this.#maxDelayMs = options.maxDelayMs ?? 10_000;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#log = options.log;
  }

  async request(url: string, init: RequestInit, context: RequestContext): Promise<Response> {
    const details = { system: context.system, url: redactQuery(url) };
    for (let attempt = 0; ; attempt++) {
      const isLastAttempt = attempt >= this.#retries;
      const outcome = await this.#attempt(url, init);

      if (outcome.kind === "failure") {
        const failure = describeFailure(outcome.error);
        if (isLastAttempt) {
          throw new NetworkError(
            `${context.what}: request failed after ${attempt + 1} attempt(s) (${failure})`,
            { cause: outcome.error, details },
          );
        }
        await this.#backoff(attempt, undefined, context, failure);
        continue;
      }

      const { response } = outcome;
      if (response.ok) return response;
      if (RETRYABLE_STATUSES.has(response.status) && !isLastAttempt) {
        await this.#backoff(attempt, retryAfterMs(response), context, `HTTP ${response.status}`);
        continue;
      }
      throw await statusError(response, context, attempt, details);
    }
  }

  async #attempt(url: string, init: RequestInit): Promise<Attempt> {
    try {
      const response = await this.#fetch(url, {
        ...init,
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      return { kind: "response", response };
    } catch (error) {
      return { kind: "failure", error };
    }
  }

  async #backoff(
    attempt: number,
    retryAfter: number | undefined,
    context: RequestContext,
    reason: string,
  ): Promise<void> {
    const exponential = Math.min(this.#maxDelayMs, this.#baseDelayMs * 2 ** attempt);
    const jittered = exponential * (0.5 + Math.random() * 0.5);
    const delay = Math.min(this.#maxDelayMs, retryAfter ?? jittered);
    this.#log?.warn(
      { system: context.system, attempt: attempt + 1, delayMs: Math.round(delay), reason },
      `${context.what}: retrying`,
    );
    await this.#sleep(delay);
  }
}

// ---------- Helpers ----------

/** Build the typed error for a non-2xx response that will not be retried. */
async function statusError(
  response: Response,
  context: RequestContext,
  attempt: number,
  details: Readonly<Record<string, unknown>>,
): Promise<SyncError> {
  const status = response.status;
  const reason = await upstreamMessage(response);
  const suffix = reason ? `: ${reason}` : "";
  const errorDetails = { ...details, status };

  if (status === 401 || status === 403) {
    return new AuthError(
      `${context.what}: ${context.system} rejected the credentials (HTTP ${status}${suffix})`,
      { details: errorDetails },
    );
  }
  if (status === 404) {
    return new SchemaError(
      `${context.what}: endpoint not found (HTTP 404${suffix}). The ${context.system} interface may have changed.`,
      { details: errorDetails },
    );
  }
  const attempts = RETRYABLE_STATUSES.has(status) ? ` after ${attempt + 1} attempt(s)` : "";
  return new NetworkError(`${context.what}: unexpected HTTP ${status}${attempts}${suffix}`, {
    details: errorDetails,
  });
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeFailure(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(header);
  if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  return undefined;
}

/**
 * Best-effort human-readable reason from an error response body.
 * Prefers a JSON `message` field, falls back to a short text snippet.
 */
async function upstreamMessage(response: Response): Promise<string | undefined> {
  let text: string;
  try {
    text = (await response.text()).trim();
  } catch {
    return undefined;
  }
  if (!text) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && "message" in parsed) {
      const message = (parsed as { message: unknown }).message;
      if (typeof message === "string" && message.trim()) return message.trim();
    }
  } catch {
    // not JSON; fall through to the snippet
  }
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/** Strip query strings from URLs before they reach logs or error details. */
function redactQuery(url: string): string {
  const index = url.indexOf("?");
  return index === -1 ? url : `${url.slice(0, index)}?[redacted]`;
}
