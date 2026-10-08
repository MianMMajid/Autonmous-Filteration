/**
 * Typed errors with stable process exit codes.
 *
 * Every failure the CLI can surface maps to one code so that an operator (or a
 * scheduler) can tell at a glance whether a run failed because of credentials,
 * the network, or a change in the shape of the data. Codes are part of the
 * public contract and documented in README.md.
 */

export const ExitCode = {
  Ok: 0,
  Unknown: 1,
  Config: 2,
  Auth: 3,
  Network: 4,
  Schema: 5,
  Locked: 6,
  Io: 7,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

export interface SyncErrorOptions {
  readonly cause?: unknown;
  /** Extra structured context for logs. Never put secrets here. */
  readonly details?: Readonly<Record<string, unknown>>;
}

/** Base class for all errors raised by this tool. */
export class SyncError extends Error {
  readonly exitCode: ExitCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(message: string, exitCode: ExitCode, options: SyncErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.exitCode = exitCode;
    this.details = options.details ?? {};
  }
}

/** Missing or malformed configuration (environment variables, flags). */
export class ConfigError extends SyncError {
  constructor(message: string, options?: SyncErrorOptions) {
    super(message, ExitCode.Config, options);
  }
}

/** Rejected credentials or expired session on either upstream system. */
export class AuthError extends SyncError {
  constructor(message: string, options?: SyncErrorOptions) {
    super(message, ExitCode.Auth, options);
  }
}

/** Transport-level failure that persisted after retries. */
export class NetworkError extends SyncError {
  constructor(message: string, options?: SyncErrorOptions) {
    super(message, ExitCode.Network, options);
  }
}

/** Upstream data did not match the expected shape. */
export class SchemaError extends SyncError {
  constructor(message: string, options?: SyncErrorOptions) {
    super(message, ExitCode.Schema, options);
  }
}

/** Another run holds the lock. */
export class LockedError extends SyncError {
  constructor(message: string, options?: SyncErrorOptions) {
    super(message, ExitCode.Locked, options);
  }
}

/** Local filesystem failure (unwritable output directory, disk full). */
export class IoError extends SyncError {
  constructor(message: string, options?: SyncErrorOptions) {
    super(message, ExitCode.Io, options);
  }
}

/** Narrow an unknown thrown value to an Error for logging. */
export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
