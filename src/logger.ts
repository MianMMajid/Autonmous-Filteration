import { type Logger, type LoggerOptions, pino } from "pino";
import type { LogLevel } from "./config.ts";

export type { Logger };

/**
 * Structured logger. JSON on non-TTY (CI, cron), pretty-printed on a terminal.
 *
 * Secrets must never be passed as log fields. Redaction paths below are a
 * backstop, not a license.
 */
export function createLogger(
  level: LogLevel,
  pretty: boolean = Boolean(process.stdout.isTTY),
): Logger {
  const options: LoggerOptions = {
    level,
    redact: {
      paths: [
        "password",
        "apiKey",
        "token",
        "*.password",
        "*.apiKey",
        "*.token",
        "headers.authorization",
      ],
      censor: "[redacted]",
    },
  };
  if (pretty) {
    options.transport = {
      target: "pino-pretty",
      options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" },
    };
  }
  return pino(options);
}
