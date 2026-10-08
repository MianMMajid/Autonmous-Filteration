// Defect probes were converted to regression tests asserting safe behavior.
import { spawnSync } from "node:child_process";

const result = spawnSync("pnpm", ["exec", "vitest", "run", "tests/audit-round-4.test.ts"], {
  stdio: "inherit",
  cwd: new URL("../../", import.meta.url),
});
process.exit(result.status ?? 1);
