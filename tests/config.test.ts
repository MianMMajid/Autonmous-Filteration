import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, PROJECT_ROOT } from "../src/config.ts";
import { ConfigError, ExitCode } from "../src/errors.ts";

const validEnv = {
  SITELEDGER_USERNAME: "acme.ops",
  SITELEDGER_PASSWORD: "secret",
  PULLEY_API_KEY: "pk_test",
};

describe("loadConfig", () => {
  it("parses a complete environment and applies defaults", () => {
    const config = loadConfig(validEnv);
    expect(config.siteLedger.username).toBe("acme.ops");
    expect(config.siteLedger.baseUrl).toBe("https://pulley-siteledger.vercel.app");
    expect(config.pulley.apiKey).toBe("pk_test");
    expect(config.logLevel).toBe("warn");
    expect(config.dataDir).toBe(resolve(PROJECT_ROOT, "data"));
    expect(config.retainRuns).toBe(60);
    expect(config.overridesFile).toBe(resolve(PROJECT_ROOT, "overrides.csv"));
  });

  it("strips trailing slashes from base URLs", () => {
    const config = loadConfig({ ...validEnv, PULLEY_BASE_URL: "https://example.test/" });
    expect(config.pulley.baseUrl).toBe("https://example.test");
  });

  it("lists every missing variable in one error", () => {
    expect.assertions(4);
    try {
      loadConfig({ SITELEDGER_USERNAME: "x" });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const configError = error as ConfigError;
      expect(configError.exitCode).toBe(ExitCode.Config);
      expect(configError.message).toContain("SITELEDGER_PASSWORD");
      expect(configError.message).toContain("PULLEY_API_KEY");
    }
  });

  it("parses RETAIN_RUNS and rejects nonsense", () => {
    expect(loadConfig({ ...validEnv, RETAIN_RUNS: "10" }).retainRuns).toBe(10);
    expect(() => loadConfig({ ...validEnv, RETAIN_RUNS: "0" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...validEnv, RETAIN_RUNS: "many" })).toThrow(ConfigError);
  });

  it("rejects an invalid log level", () => {
    expect(() => loadConfig({ ...validEnv, LOG_LEVEL: "loud" })).toThrow(ConfigError);
  });

  it("rejects a malformed base URL", () => {
    expect(() => loadConfig({ ...validEnv, SITELEDGER_BASE_URL: "not a url" })).toThrow(
      ConfigError,
    );
  });
});
