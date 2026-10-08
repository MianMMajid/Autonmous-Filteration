// Synthetic matcher capacity probe; excludes upstream latency and spreadsheet parsing.
import { performance } from "node:perf_hooks";
import { matchProjects } from "../src/domain/match/matcher.ts";
import { assertPublicationInvariants } from "../src/run/invariants.ts";
import { acme, inputs, pulley } from "../tests/domain/match/fixtures.ts";

const size = Number(process.argv[2] ?? 4000);
if (!Number.isSafeInteger(size) || size < 1 || size > 8000)
  throw new Error("Use 1–8000 synthetic stores");
for (const mode of ["exact", "ambiguous"]) {
  const projects = Array.from({ length: size }, (_, index) =>
    acme({ store: 1000 + index, street: `${100 + index} Main St` }),
  );
  const targets = projects.flatMap((project, index) => {
    const first = pulley({
      id: `prj_capacity${index}`,
      name: `${project.store}.${project.sequence} Remodel 2027`,
      street: project.site?.streetAddress,
    });
    return mode === "ambiguous" ? [first, { ...first, id: `${first.id}duplicate` }] : [first];
  });
  const normalized = inputs(projects, targets);
  const start = performance.now();
  const report = matchProjects(normalized);
  assertPublicationInvariants(report.decisions, normalized.acme, normalized.pulley);
  if (mode === "exact" && report.counts.matched !== size)
    throw new Error("Capacity fixture lost exact matches");
  if (mode === "ambiguous" && report.counts.needs_review !== size)
    throw new Error("Capacity fixture guessed through duplicate targets");
  process.stdout.write(
    `${JSON.stringify({ mode, acme: size, pulley: targets.length, elapsedMs: Math.round(performance.now() - start), processPeakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024), counts: report.counts })}\n`,
  );
}
