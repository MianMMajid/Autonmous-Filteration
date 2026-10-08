// The historical bug probes have been converted to correctness regressions.
// This compatibility entry point runs them without contacting upstream services.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const result = spawnSync("pnpm", ["exec", "vitest", "run", "tests/audit-round-3.test.ts"], {
  cwd: fileURLToPath(new URL("../../", import.meta.url)),
  stdio: "inherit",
});
if (result.error) process.stderr.write(`Could not start regressions: ${result.error.message}\n`);
process.exitCode = result.status ?? 1;
