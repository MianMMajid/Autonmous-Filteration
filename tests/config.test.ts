import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
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
    expect(config.logLevel).toBe("info");
    expect(config.dataDir).toBe("./data");
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

  it("rejects an invalid log level", () => {
    expect(() => loadConfig({ ...validEnv, LOG_LEVEL: "loud" })).toThrow(ConfigError);
  });

  it("rejects a malformed base URL", () => {
    expect(() => loadConfig({ ...validEnv, SITELEDGER_BASE_URL: "not a url" })).toThrow(
      ConfigError,
    );
  });
});
