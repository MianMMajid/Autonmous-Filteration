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

/** A non-empty string whose absence is reported as "required" rather than a type error. */
function required(name: string): z.ZodString {
  const message = `${name} is required`;
  return z.string({ error: message }).trim().min(1, message);
}

const envSchema = z.object({
  SITELEDGER_BASE_URL: z.url().default(DEFAULT_BASE_URL),
  SITELEDGER_USERNAME: required("SITELEDGER_USERNAME"),
  SITELEDGER_PASSWORD: required("SITELEDGER_PASSWORD"),
  PULLEY_BASE_URL: z.url().default(DEFAULT_BASE_URL),
  PULLEY_API_KEY: required("PULLEY_API_KEY"),
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
  DATA_DIR: z.string().trim().min(1).default("./data"),
});

export interface Config {
  readonly siteLedger: {
    readonly baseUrl: string;
    readonly username: string;
    readonly password: string;
  };
  readonly pulley: {
    readonly baseUrl: string;
    readonly apiKey: string;
  };
  readonly logLevel: LogLevel;
  readonly dataDir: string;
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
  if (!result.success) {
    const problems = result.error.issues.map((issue) => {
      const key = issue.path.join(".") || "(root)";
      return `${key}: ${issue.message}`;
    });
    throw new ConfigError(
      `Invalid configuration. Copy .env.example to .env and fill it in.\n  - ${problems.join("\n  - ")}`,
      { details: { problems } },
    );
  }
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
  };
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
