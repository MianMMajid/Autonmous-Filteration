import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExitCode } from "../src/errors.ts";

const run = promisify(execFile);
const cli = new URL("../src/cli.ts", import.meta.url).pathname;

/** Spawn the real CLI with a controlled environment and return exit code and output. */
async function invoke(args: string[], env: Record<string, string>) {
  try {
    const { stdout, stderr } = await run(process.execPath, [cli, ...args], {
      env: { PATH: process.env["PATH"] ?? "", ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "cli-"));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("cli", () => {
  it("prints help and exits 0", async () => {
    const result = await invoke(["--help"], {});
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/sync/);
    expect(result.stdout).toMatch(/status/);
  });

  it("exits 2 with every missing variable named when configuration is absent", async () => {
    const result = await invoke(["sync"], {});
    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toMatch(/SITELEDGER_USERNAME is required/);
    expect(result.stderr).toMatch(/PULLEY_API_KEY is required/);
  });

  it("status exits 9 when nothing has been published", async () => {
    const result = await invoke(["status"], {
      SITELEDGER_USERNAME: "u",
      SITELEDGER_PASSWORD: "p",
      PULLEY_API_KEY: "k",
      DATA_DIR: dataDir,
    });
    expect(result.code).toBe(ExitCode.Stale);
    expect(result.stdout).toMatch(/No published result yet/);
  });

  it("status never asks for credentials (a clean scheduler environment)", async () => {
    const result = await invoke(["status"], { DATA_DIR: dataDir });
    expect(result.code).toBe(ExitCode.Stale);
    expect(result.stderr).not.toMatch(/is required/);
  });

  it("rejects a non-numeric --max-age-hours", async () => {
    const result = await invoke(["status", "--max-age-hours", "soon"], {
      SITELEDGER_USERNAME: "u",
      SITELEDGER_PASSWORD: "p",
      PULLEY_API_KEY: "k",
      DATA_DIR: dataDir,
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/positive number of hours/);
  });
});
