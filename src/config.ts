import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ConfigError } from "./errors.ts";

/**
 * Runtime configuration, parsed once from environment variables.
 *
 * Node loads `.env` itself (`--env-file-if-exists=.env` in the pnpm scripts),
 * so there is no dotenv dependency. Validation fails fast with every problem
 * listed at once rather than one at a time.
 */

const LOG_LEVELS = ["trace", "debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const DEFAULT_BASE_URL = "https://pulley-siteledger.vercel.app";
export const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));

/** A non-empty string whose absence is reported as "required" rather than a type error. */
function required(name: string): z.ZodString {
  const message = `${name} is required`;
  return z.string({ error: message }).trim().min(1, message);
}

/** Settings a local command (status, replay) needs; no credentials. */
const localSchema = z.object({
  LOG_LEVEL: z.enum(LOG_LEVELS).default("warn"),
  DATA_DIR: z
    .string()
    .trim()
    .min(1)
    .default(resolve(PROJECT_ROOT, "data"))
    .transform((path) => resolve(path)),
  RETAIN_RUNS: z.coerce.number().int().min(1).default(60),
  OVERRIDES_FILE: z
    .string()
    .trim()
    .min(1)
    .default(resolve(PROJECT_ROOT, "overrides.csv"))
    .transform((path) => resolve(path)),
});

const endpoint = z.url().refine((value) => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
}, "must be an HTTPS URL without credentials, query, or fragment");

const envSchema = localSchema.extend({
  SITELEDGER_BASE_URL: endpoint.default(DEFAULT_BASE_URL),
  SITELEDGER_USERNAME: required("SITELEDGER_USERNAME"),
  SITELEDGER_PASSWORD: required("SITELEDGER_PASSWORD"),
  PULLEY_BASE_URL: endpoint.default(DEFAULT_BASE_URL),
  PULLEY_API_KEY: required("PULLEY_API_KEY"),
});

export interface LocalConfig {
  readonly logLevel: LogLevel;
  readonly dataDir: string;
  /** How many past runs to keep under data/raw and data/out. */
  readonly retainRuns: number;
  /** Human decisions file; tracked in the repository by default, unlike data/. */
  readonly overridesFile: string;
}

export interface Config extends LocalConfig {
  readonly siteLedger: {
    readonly baseUrl: string;
    readonly username: string;
    readonly password: string;
  };
  readonly pulley: {
    readonly baseUrl: string;
    readonly apiKey: string;
  };
}

/** Names of the variables an operator must supply. Used by `preflight`. */
export const REQUIRED_ENV_VARS = [
  "SITELEDGER_USERNAME",
  "SITELEDGER_PASSWORD",
  "PULLEY_API_KEY",
] as const;

/**
 * Parse configuration from an environment map.
 *
 * @throws {ConfigError} listing every invalid or missing variable.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) return fail(result.error.issues);
  const parsed = result.data;
  return {
    siteLedger: {
      baseUrl: stripTrailingSlash(parsed.SITELEDGER_BASE_URL),
      username: parsed.SITELEDGER_USERNAME,
      password: parsed.SITELEDGER_PASSWORD,
    },
    pulley: {
      baseUrl: stripTrailingSlash(parsed.PULLEY_BASE_URL),
      apiKey: parsed.PULLEY_API_KEY,
    },
    logLevel: parsed.LOG_LEVEL,
    dataDir: parsed.DATA_DIR,
    retainRuns: parsed.RETAIN_RUNS,
    overridesFile: parsed.OVERRIDES_FILE,
  };
}

function fail(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): never {
  const problems = issues.map((issue) => {
    const key = issue.path.join(".") || "(root)";
    return `${key}: ${issue.message}`;
  });
  throw new ConfigError(
    `Invalid configuration. Copy .env.example to .env and fill it in.\n  - ${problems.join("\n  - ")}`,
    { details: { problems } },
  );
}

/** Configuration for commands that only read local state; never asks for credentials. */
export function loadLocalConfig(env: NodeJS.ProcessEnv = process.env): LocalConfig {
  const result = localSchema.safeParse(env);
  if (!result.success) return fail(result.error.issues);
  return {
    logLevel: result.data.LOG_LEVEL,
    dataDir: result.data.DATA_DIR,
    retainRuns: result.data.RETAIN_RUNS,
    overridesFile: result.data.OVERRIDES_FILE,
  };
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/** Only live acquisition requires credentials. */
export function isLiveConfig(config: LocalConfig | Config): config is Config {
  return "siteLedger" in config && "pulley" in config;
}
