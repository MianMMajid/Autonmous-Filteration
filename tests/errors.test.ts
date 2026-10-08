import { describe, expect, it } from "vitest";
import {
  AuthError,
  ExitCode,
  NetworkError,
  SchemaError,
  SyncError,
  toError,
} from "../src/errors.ts";

describe("errors", () => {
  it("assigns distinct exit codes per failure class", () => {
    const codes = [new AuthError("a"), new NetworkError("n"), new SchemaError("s")].map(
      (e) => e.exitCode,
    );
    expect(new Set(codes).size).toBe(3);
    expect(codes).not.toContain(ExitCode.Ok);
  });

  it("preserves cause and details", () => {
    const cause = new Error("root");
    const error = new SchemaError("bad row", { cause, details: { report: "key-dates" } });
    expect(error.cause).toBe(cause);
    expect(error.details).toEqual({ report: "key-dates" });
    expect(error.name).toBe("SchemaError");
    expect(error).toBeInstanceOf(SyncError);
  });

  it("wraps non-Error throwables", () => {
    expect(toError("boom").message).toBe("boom");
    const original = new Error("x");
    expect(toError(original)).toBe(original);
  });
});
