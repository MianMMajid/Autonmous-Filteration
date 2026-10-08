import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/cli.ts", "src/preflight.ts", "src/**/*.test.ts"],
      reporter: ["text", "html"],
      thresholds: {
        // Domain logic (matching, normalization) is held to a higher bar in
        // vitest.config.ts once those modules exist. Global floor for now.
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
  },
});
