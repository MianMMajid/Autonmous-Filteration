import { performance } from "node:perf_hooks";
import { matchProjects } from "../src/domain/match/matcher.ts";
import { assertPublicationInvariants } from "../src/run/invariants.ts";
import { acme, inputs, pulley } from "../tests/domain/match/fixtures.ts";

// Synthetic inputs only. Run with Node 26: node scripts/benchmark-matching.ts.
// Excludes input construction; medians of three matcher + publication checks.
// This is a common-path benchmark, not a worst-case latency guarantee.
for (const mode of ["exact-id", "store"] as const) {
  for (const count of [1000, 4000]) {
    const register = Array.from({ length: count }, (_, i) =>
      acme({ store: 3000 + i, city: `City${i}`, street: `${i + 1} Main St` }),
    );
    const pool = register.map((a) =>
      pulley({
        name: `${mode === "exact-id" ? a.id : `Store ${a.store}`} Remodel 2027`,
        jurisdictionCity: a.site?.city ?? "",
        street: a.site?.streetAddress ?? null,
      }),
    );
    const normalized = inputs(register, pool);
    const samples: Array<{ matcherMs: number; publicationMs: number }> = [];
    for (let repeat = 0; repeat < 3; repeat++) {
      const start = performance.now();
      const result = matchProjects(normalized);
      const matchedAt = performance.now();
      assertPublicationInvariants(result.decisions, register, pool);
      const checkedAt = performance.now();
      if (result.counts.matched !== count) throw new Error("Benchmark acceptance changed");
      samples.push({ matcherMs: matchedAt - start, publicationMs: checkedAt - matchedAt });
    }
    const median = (field: "matcherMs" | "publicationMs") =>
      Math.round(samples.map((sample) => sample[field]).sort((a, b) => a - b)[1] ?? 0);
    process.stdout.write(
      `${JSON.stringify({
        mode,
        count,
        matcherMs: median("matcherMs"),
        publicationMs: median("publicationMs"),
      })}\n`,
    );
  }
}
