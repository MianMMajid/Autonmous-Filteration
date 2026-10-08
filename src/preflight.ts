#!/usr/bin/env node
/**
 * Environment health check. Run this first on a new machine.
 *
 * Prints one line per check and exits non-zero if anything blocking is wrong.
 * It never prints secret values, only whether they are present.
 *
 *   pnpm preflight              full check
 *   pnpm preflight --skip-env   skip credential checks (used in CI)
 */

import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalConfig, REQUIRED_ENV_VARS } from "./config.ts";
import { ExitCode } from "./errors.ts";

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly blocking: boolean;
}

const MIN_NODE_MAJOR = 26;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skipEnv = process.argv.includes("--skip-env");

const checks: Check[] = [];

// Node version. Native type stripping must be available and stable.
const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
checks.push({
  name: "node",
  ok: nodeMajor >= MIN_NODE_MAJOR,
  detail: `v${process.versions.node} (need >= ${MIN_NODE_MAJOR})`,
  blocking: true,
});

// Package manager pin.
const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as {
  packageManager?: string;
};
const userAgent = process.env["npm_config_user_agent"] ?? "";
const expectedPm = pkg.packageManager ?? "pnpm";
checks.push({
  name: "pnpm",
  ok: userAgent.startsWith("pnpm/") || !userAgent,
  detail: userAgent ? `invoked via ${userAgent.split(" ")[0]}` : `expected ${expectedPm}`,
  blocking: false,
});

// Dependencies installed.
checks.push({
  name: "node_modules",
  ok: existsSync(resolve(repoRoot, "node_modules", ".pnpm")),
  detail: "run `pnpm install`",
  blocking: true,
});

// Vendored SheetJS tarball present and unchanged (not on npm; see docs/adr/0003).
const TARBALL = resolve(repoRoot, "vendor", "xlsx-0.20.3.tgz");
const TARBALL_SHA256 = "8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8";
const tarballHash = existsSync(TARBALL)
  ? createHash("sha256").update(readFileSync(TARBALL)).digest("hex")
  : null;
checks.push({
  name: "vendor/xlsx",
  ok: tarballHash === TARBALL_SHA256,
  detail:
    tarballHash === null
      ? "vendor/xlsx-0.20.3.tgz is missing; see docs/adr/0003-vendored-sheetjs.md"
      : tarballHash === TARBALL_SHA256
        ? "sha256 verified against docs/adr/0003"
        : `sha256 ${tarballHash.slice(0, 12)}… does not match docs/adr/0003; do not use this tarball`,
  blocking: true,
});

// Credentials present (values never printed).
if (skipEnv) {
  checks.push({ name: "env", ok: true, detail: "skipped (--skip-env)", blocking: false });
} else {
  const missing = REQUIRED_ENV_VARS.filter((name) => !process.env[name]?.trim());
  checks.push({
    name: "env",
    ok: missing.length === 0,
    detail:
      missing.length === 0 ? "all required variables present" : `missing: ${missing.join(", ")}`,
    blocking: true,
  });
}

// Data directory writable.
let dataOk = true;
let dataDetail = "";
try {
  const dataDir = loadLocalConfig().dataDir;
  dataDetail = dataDir;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  accessSync(dataDir, constants.W_OK);
} catch (error) {
  dataOk = false;
  dataDetail = `Data configuration or directory check failed: ${error instanceof Error ? error.message : String(error)}`;
}
checks.push({ name: "data dir", ok: dataOk, detail: dataDetail, blocking: true });

let failed = false;
for (const check of checks) {
  const mark = check.ok ? "ok  " : check.blocking ? "FAIL" : "warn";
  console.log(`${mark}  ${check.name.padEnd(14)} ${check.detail}`);
  if (!check.ok && check.blocking) failed = true;
}

if (failed) {
  console.error("\nSome checks failed. Fix the FAIL lines above and run `pnpm preflight` again.");
  process.exit(ExitCode.Config);
}
console.log("\nEnvironment looks good.");
