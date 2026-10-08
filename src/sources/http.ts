import { setTimeout as delay } from "node:timers/promises";
import { AuthError, NetworkError, SchemaError, type SyncError } from "../errors.ts";
import type { Logger } from "../logger.ts";

/**
 * Thin wrapper over `fetch` that turns transport problems into typed errors.
 *
 * The whole exchange, headers *and* body, happens inside the retry loop: a
 * connection that drops while the body streams is a transport failure and is
 * retried like any other, instead of surfacing as a parse error later.
 *
 * Policy:
 * - 2xx: returned to the caller with the body already read.
 * - 3xx: refused without following the redirect or forwarding credentials.
 * - 401 / 403: `AuthError` immediately. Retrying bad credentials is pointless.
 * - 404: `SchemaError`. The endpoint we rely on has moved; that is a contract change.
 * - 408 / 425 / 429 / 5xx and thrown network errors (including timeouts and
 *   body-read failures): retried with exponential backoff and jitter,
 *   honoring `Retry-After` within a cumulative waiting budget, then `NetworkError`.
 * - Any other status: `NetworkError` without retry.
 *
 * Error messages use static descriptions of recognized upstream error codes.
 * Arbitrary response bodies and transport messages never reach logs.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpClientOptions {
  readonly fetch?: FetchLike;
  /** Number of retries after the first attempt. Default 3. */
  readonly retries?: number;
  /** Per-attempt timeout, covering headers and body. Default 30 s. */
  readonly timeoutMs?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  /** Total retry waiting budget per request. Longer server cooldowns fail explicitly. */
  readonly maxRetryWaitMs?: number;
  readonly maxResponseBytes?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly log?: Logger;
}

export interface RequestContext {
  readonly system: "siteledger" | "pulley";
  /** Human description used in error messages, e.g. "SiteLedger sign-in". */
  readonly what: string;
}

/** A completed exchange: status, headers, and the full body. */
export interface HttpResult {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: Headers;
  readonly bytes: Uint8Array;
  text(): string;
}

type Attempt =
  | { readonly kind: "response"; readonly result: HttpResult }
  | { readonly kind: "failure"; readonly error: unknown };

const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 425, 429, 500, 502, 503, 504]);

export class HttpClient {
  readonly #maxResponseBytes: number;
  readonly #fetch: FetchLike;
  readonly #retries: number;
  readonly #timeoutMs: number;
  readonly #baseDelayMs: number;
  readonly #maxDelayMs: number;
  readonly #maxRetryWaitMs: number;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly #log: Logger | undefined;

  constructor(options: HttpClientOptions = {}) {
    this.#maxResponseBytes = options.maxResponseBytes ?? 32 * 1024 * 1024;
    if (
      !Number.isSafeInteger(this.#maxResponseBytes) ||
      this.#maxResponseBytes < 1 ||
      this.#maxResponseBytes > 128 * 1024 * 1024
    )
      throw new RangeError("maxResponseBytes must be between 1 and 134217728");
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#retries = options.retries ?? 3;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#baseDelayMs = options.baseDelayMs ?? 500;
    this.#maxDelayMs = options.maxDelayMs ?? 10_000;
    this.#maxRetryWaitMs = options.maxRetryWaitMs ?? 300_000;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#log = options.log;
    for (const [name, value] of Object.entries({
      retries: this.#retries,
      timeoutMs: this.#timeoutMs,
      baseDelayMs: this.#baseDelayMs,
      maxDelayMs: this.#maxDelayMs,
      maxRetryWaitMs: this.#maxRetryWaitMs,
    })) {
      if (
        !Number.isSafeInteger(value) ||
        value < 0 ||
        (name === "timeoutMs" && value === 0) ||
        (name !== "retries" && value > 2_147_483_647)
      ) {
        throw new RangeError(
          `${name} must be a ${name === "timeoutMs" ? "positive" : "nonnegative"} safe integer within the supported timer range`,
        );
      }
    }
  }

  async request(url: string, init: RequestInit, context: RequestContext): Promise<HttpResult> {
    const details = { system: context.system, url: redactQuery(url) };
    let remainingWait = this.#maxRetryWaitMs;
    for (let attempt = 0; ; attempt++) {
      checkCanceled(init.signal, context);
      const isLastAttempt = attempt >= this.#retries;
      const outcome = await this.#attempt(url, init);

      if (outcome.kind === "failure") {
        checkCanceled(init.signal, context);
        if (outcome.error instanceof SchemaError) throw outcome.error;
        const failure = describeFailure(outcome.error);
        if (isLastAttempt) {
          throw new NetworkError(
            `${context.what}: request failed after ${attempt + 1} attempt(s) (${failure})`,
            { cause: outcome.error, details },
          );
        }
        remainingWait -= await this.#backoff(
          attempt,
          undefined,
          context,
          failure,
          remainingWait,
          init.signal ?? undefined,
        );
        continue;
      }

      const { result } = outcome;
      if (result.status >= 300 && result.status < 400) {
        throw new SchemaError(
          `${context.what}: HTTP ${result.status} redirect refused; verify the configured endpoint`,
          { details: { ...details, status: result.status } },
        );
      }
      if (result.ok) return result;
      if (RETRYABLE_STATUSES.has(result.status) && !isLastAttempt) {
        remainingWait -= await this.#backoff(
          attempt,
          retryAfterMs(result.headers),
          context,
          `HTTP ${result.status}`,
          remainingWait,
          init.signal ?? undefined,
        );
        continue;
      }
      throw statusError(result, context, attempt, details);
    }
  }

  /** One exchange including the body; any throw along the way is a transport failure. */
  async #attempt(url: string, init: RequestInit): Promise<Attempt> {
    try {
      const response = await this.#fetch(url, {
        ...init,
        redirect: "manual",
        signal: init.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(this.#timeoutMs)])
          : AbortSignal.timeout(this.#timeoutMs),
      });
      const isRedirect = response.status >= 300 && response.status < 400;
      if (isRedirect) await response.body?.cancel().catch(() => undefined);
      const bytes = isRedirect
        ? new Uint8Array()
        : await boundedBody(response, this.#maxResponseBytes);
      const result: HttpResult = {
        ok: response.ok,
        status: response.status,
        headers: response.headers,
        bytes,
        text: () => new TextDecoder("utf-8").decode(bytes),
      };
      return { kind: "response", result };
    } catch (error) {
      return { kind: "failure", error };
    }
  }

  async #backoff(
    attempt: number,
    retryAfter: number | undefined,
    context: RequestContext,
    reason: string,
    remainingWait: number,
    signal?: AbortSignal,
  ): Promise<number> {
    const exponential = Math.min(this.#maxDelayMs, this.#baseDelayMs * 2 ** attempt);
    const jittered = exponential * (0.5 + Math.random() * 0.5);
    const delay = retryAfter ?? jittered;
    if (delay > remainingWait) {
      throw new NetworkError(
        `${context.what}: retry delay ${delay} ms exceeds remaining wait budget ${remainingWait} ms; retry later`,
        {
          details: { retryAfterMs: delay, remainingWaitMs: remainingWait },
        },
      );
    }
    this.#log?.warn(
      { system: context.system, attempt: attempt + 1, delayMs: Math.round(delay), reason },
      `${context.what}: retrying`,
    );
    try {
      await this.#sleep(delay, signal);
    } catch (error) {
      throw new NetworkError(
        `${context.what}: retry wait ${signal?.aborted ? "canceled" : "failed"}`,
        { cause: error },
      );
    }
    return delay;
  }
}

// ---------- Helpers ----------

/** Build the typed error for a non-2xx response that will not be retried. */
function statusError(
  result: HttpResult,
  context: RequestContext,
  attempt: number,
  details: Readonly<Record<string, unknown>>,
): SyncError {
  const status = result.status;
  const reason = upstreamMessage(result.text());
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

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  await delay(ms, undefined, signal ? { signal } : {});
}

function describeFailure(error: unknown): string {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))
    return error.name;
  return "fetch failed";
}

async function boundedBody(response: Response, limit: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new SchemaError(`HTTP response exceeds ${limit} byte limit`);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > limit) {
        await reader.cancel().catch(() => undefined);
        throw new SchemaError(`HTTP response exceeds ${limit} byte limit`);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function retryAfterMs(headers: Headers): number | undefined {
  const header = headers.get("retry-after");
  if (!header) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(header.trim())) return Number(header) * 1000;
  if (!/[A-Za-z]/.test(header)) return undefined;
  const at = Date.parse(header);
  if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  return undefined;
}

/**
 * Static descriptions for recognized error codes; never reflects upstream text.
 */
function upstreamMessage(raw: string): string | undefined {
  // Never echo arbitrary upstream text: it can contain reflected credentials.
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      if (parsed.error === "invalid_credentials") return "Invalid username or password.";
      if (parsed.error === "invalid_cursor") return "The cursor parameter is not valid.";
    }
  } catch {
    /* HTTP status is sufficient for unknown bodies. */
  }
  return undefined;
}

/** Strip query strings from URLs before they reach logs or error details. */
function redactQuery(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}${parsed.search ? "?[redacted]" : ""}`;
  } catch {
    return "[invalid URL]";
  }
}

function checkCanceled(signal: AbortSignal | null | undefined, context: RequestContext): void {
  if (signal?.aborted) throw new NetworkError(`${context.what}: request canceled`);
}
