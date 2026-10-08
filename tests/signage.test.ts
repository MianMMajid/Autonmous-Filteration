import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { utils, write } from "xlsx";
import { matchProjects } from "../src/domain/match/matcher.ts";
import { Banner } from "../src/domain/model.ts";
import { createLogger } from "../src/logger.ts";
import { assertPublicationInvariants } from "../src/run/invariants.ts";
import { applyOverrides, parseOverrides } from "../src/run/overrides.ts";
import { runSync } from "../src/run/sync.ts";
import { HttpClient } from "../src/sources/http.ts";
import {
  KEY_DATES_COLUMNS,
  PROJECT_REGISTER_COLUMNS,
  SITE_DIRECTORY_COLUMNS,
} from "../src/sources/siteledger/schemas.ts";
import { acme, inputs, pulley } from "./domain/match/fixtures.ts";

const header = "acme_project_id,pulley_project_id,status,note\n";
const sign = (change: Parameters<typeof acme>[0] = {}) =>
  acme({ projectType: "Signage", name: "1556.1002 Reno Signage 2027", ...change });
const permit = (change: Parameters<typeof pulley>[0] = {}) =>
  pulley({
    id: "prj_sign",
    projectType: "Signage",
    name: "1556.1002 Reno Signage 2027",
    ...change,
  });
function override(n: ReturnType<typeof inputs>, target: string, note = "scope checked") {
  const a = n.acme[0];
  if (!a) throw new Error("Missing test project");
  return applyOverrides(
    matchProjects(n),
    parseOverrides(`${header}${a.id},${target},matched,${note}\n`),
    n,
  );
}
function valid(n: ReturnType<typeof inputs>) {
  const report = matchProjects(n);
  expect(() => assertPublicationInvariants(report.decisions, n.acme, n.pulley)).not.toThrow();
  return report;
}

// The expectations express the brief, independent of the compatibility helper.
describe("dedicated signage acceptance", () => {
  it.each([
    { name: "1556.1002 Reno Signage" },
    { name: "Store 1556 Signage 2027" },
    { name: "Signage 2027", street: "100 Main Street", jurisdictionCity: "Sparks" },
    { name: "Store 1556 Signage" },
    { name: "1556.1002 Reno Signage 2027", projectType: " signage " },
  ])("accepts dedicated signage with sufficient evidence: %j", (change) => {
    const n = inputs([sign()], [permit(change)]);
    expect(valid(n).decisions[0]).toMatchObject({ status: "matched", pulleyId: "prj_sign" });
  });

  it("matches a verified former store number", () => {
    const n = inputs(
      [sign({ formerLocationNumber: 2666 })],
      [permit({ name: "2666.1002 Signage 2027" })],
    );
    expect(valid(n).counts.matched).toBe(1);
  });

  it("keeps remodel and signage at one store/year on their separate permits in either order", () => {
    const a = acme({ sequence: 1001 });
    const s = sign();
    const p = pulley({ id: "prj_remodel", name: "1556.1001 Remodel 2027" });
    const q = permit();
    for (const reverse of [false, true]) {
      const n = inputs(reverse ? [s, a] : [a, s], reverse ? [q, p] : [p, q]);
      expect(new Map(valid(n).decisions.map((d) => [d.acmeId, d.pulleyId]))).toEqual(
        new Map([
          [a.id, p.id],
          [s.id, q.id],
        ]),
      );
    }
  });

  it("does not let a general permit sharing the full ID defeat the signage permit", () => {
    const n = inputs([sign()], [pulley({ name: "1556.1002 Remodel 2027" }), permit()]);
    expect(valid(n).decisions[0]?.pulleyId).toBe("prj_sign");
  });

  it("holds duplicate signage targets in either order and permits an explained selection", () => {
    const candidates = [permit(), permit({ id: "prj_second" })];
    for (const pool of [candidates, [...candidates].reverse()]) {
      const n = inputs([sign()], pool);
      expect(valid(n).decisions[0]).toMatchObject({ status: "needs_review", reason: "AMBIGUOUS" });
      const result = override(n, "prj_second");
      expect(result.applied).toBe(1);
      expect(() =>
        assertPublicationInvariants(result.report.decisions, n.acme, n.pulley),
      ).not.toThrow();
      expect(result.report.unmatchedPulley.map((p) => p.id)).toEqual(["prj_sign"]);
    }
  });

  it("requires evidence for an address-only yearless match, with a human resolution path", () => {
    const n = inputs([sign()], [permit({ name: "Signage", street: "100 Main St" })]);
    expect(valid(n).decisions[0]).toMatchObject({
      status: "needs_review",
      reason: "INSUFFICIENT_EVIDENCE",
    });
    expect(override(n, "prj_sign").applied).toBe(1);
  });

  it.each([
    ["Closed", "Canceled"],
    ["Canceled", "Canceled"],
    ["Closed", "Complete"],
  ])("accepts compatible ended lifecycles: %s / %s", (acmeStatus, pulleyStatus) => {
    expect(
      valid(inputs([sign({ status: acmeStatus })], [permit({ status: pulleyStatus })])).counts
        .matched,
    ).toBe(1);
  });
});

describe("signage hard boundaries through every acceptance path", () => {
  it.each([
    { accountPlan: "pathfinder" },
    { banner: Banner.WarehouseClub },
    { state: "CA" },
    { name: "2666.1002 Signage 2027" },
    { name: "1556.1002 Signage 2028" },
    { name: "1556.1002 Signage 2027 / Store 2666" },
    { name: "[Canceled] 1556.1002 Signage 2027" },
    { status: "Canceled" },
    { status: "Unexpected status" },
    { projectType: "Remodel", name: "1556.1002 Remodel 2027" },
    { projectType: "Signs", name: "1556.1002 Signs 2027" },
  ])("rejects unsafe targets automatically, by override and at publication: %j", (change) => {
    const n = inputs([sign()], [permit(change)]);
    const report = valid(n);
    expect(report.counts.matched).toBe(0);
    expect(override(n, "prj_sign").applied).toBe(0);
    const forged = report.decisions.map((d) => ({
      ...d,
      status: "matched" as const,
      pulleyId: "prj_sign",
      reason: "OVERRIDE" as const,
    }));
    expect(() => assertPublicationInvariants(forged, n.acme, n.pulley)).toThrow();
  });

  it.each([
    "Remodel",
    "Expansion",
    "New Build",
    "EV Charging",
    "Coffee Tenant",
    "Pharmacy Relocation",
    "Deli Remodel",
  ])("never folds %s into a signage permit, including a forced override", (projectType) => {
    const n = inputs([acme({ projectType })], [permit()]);
    expect(valid(n).counts.matched).toBe(0);
    const result = override(n, "prj_sign");
    expect(result.applied).toBe(0);
    expect(result.problems.join(" ")).toContain("Dedicated signage must match signage");
    const forged = result.report.decisions.map((d) => ({
      ...d,
      status: "matched" as const,
      pulleyId: "prj_sign",
      reason: "OVERRIDE" as const,
    }));
    expect(() => assertPublicationInvariants(forged, n.acme, n.pulley)).toThrow();
  });

  it("blocks a closed Acme signage row against a live permit", () => {
    const n = inputs([sign({ status: "Closed" })], [permit()]);
    expect(valid(n).counts.matched).toBe(0);
    expect(override(n, "prj_sign").applied).toBe(0);
  });

  it("holds source name/type contradictions even when a target would match", () => {
    const n = inputs(
      [acme({ name: "1556.1002 Signage 2027" })],
      [pulley({ name: "1556.1002 Remodel 2027" })],
    );
    expect(valid(n).decisions[0]?.reason).toBe("IDENTITY_DISPUTED");
    expect(override(n, n.pulley[0]?.id ?? "").applied).toBe(0);
  });

  it("does not use a reused sequence alone to choose a signage building", () => {
    const n = inputs(
      [sign()],
      [permit({ name: "Sequence 1002 Signage", jurisdictionCity: "Unknown" })],
    );
    expect(valid(n).counts.matched).toBe(0);
  });

  it("does not share signage across years or let an override steal another year's explicit owner", () => {
    const a = sign();
    const b = sign({ sequence: 1003, name: "1556.1003 Signage 2028", programYear: 2028 });
    for (const register of [
      [a, b],
      [b, a],
    ]) {
      const n = inputs(register, [permit()]);
      const decisions = valid(n).decisions;
      expect(decisions.find((d) => d.acmeId === a.id)?.status).toBe("matched");
      expect(decisions.find((d) => d.acmeId === b.id)?.status).not.toBe("matched");
    }
    expect(override(inputs([b, a], [permit()]), "prj_sign").applied).toBe(0);
  });

  it("keeps mixed remodel/sign scope on the human-confirmation path", () => {
    const n = inputs([sign()], [permit({ name: "1556.1002 Remodel + exterior signs 2027" })]);
    expect(valid(n).decisions[0]?.reason).toBe("EVIDENCE_CONFLICT");
    expect(override(n, "prj_sign", "").applied).toBe(0);
    const result = override(n, "prj_sign");
    expect(result.applied).toBe(1);
    expect(() =>
      assertPublicationInvariants(result.report.decisions, n.acme, n.pulley),
    ).not.toThrow();
  });
});

describe("signage fallback ownership and soft evidence", () => {
  it.each(["sequence", "dates"])("requires a unique signage owner for the %s fallback", (kind) => {
    const a = sign({ dates: { constructionStart: "2027-06-01" } });
    const p = permit({
      name: kind === "sequence" ? "RENO-NV-SUP-SIGN-2027 (1002)" : "Project Larkspur",
      constructionStart: "2027-06-02",
    });
    const remodel = acme({ store: 2666, dates: { constructionStart: "2027-06-01" } });
    expect(valid(inputs([a, remodel], [p])).decisions.find((d) => d.acmeId === a.id)).toMatchObject(
      {
        status: "matched",
        tier: kind === "sequence" ? 3 : 5,
      },
    );
    const competing = sign({
      store: 2666,
      name: "2666.1002 Signage 2027",
      dates: { constructionStart: "2027-06-01" },
    });
    for (const register of [
      [a, competing],
      [competing, a],
    ])
      expect(valid(inputs(register, [p])).counts.matched).toBe(0);
  });

  it.each([
    { site: null },
    { identityDisputed: "conflicting source rows" },
    { status: "Unknown lifecycle" },
    { name: "1556.1002 Signage 2028" },
  ])("does not waive missing identity or source conflicts for signage: %j", (change) => {
    const n = inputs([sign(change)], [permit()]);
    expect(valid(n).counts.matched).toBe(0);
    expect(override(n, "prj_sign").applied).toBe(0);
  });

  it.each([{ street: "100 Other Road" }, { constructionStart: "2028-06-01" }])(
    "holds soft conflicts and requires an explained override: %j",
    (change) => {
      const n = inputs([sign({ dates: { constructionStart: "2027-06-01" } })], [permit(change)]);
      expect(valid(n).decisions[0]?.reason).toBe("EVIDENCE_CONFLICT");
      expect(override(n, "prj_sign", "").applied).toBe(0);
      const result = override(n, "prj_sign");
      expect(result.applied).toBe(1);
      expect(() =>
        assertPublicationInvariants(result.report.decisions, n.acme, n.pulley),
      ).not.toThrow();
    },
  );

  it("keeps a valid live signage permit over a canceled duplicate", () => {
    const n = inputs([sign()], [permit(), permit({ id: "prj_canceled", status: "Canceled" })]);
    expect(valid(n).decisions[0]?.pulleyId).toBe("prj_sign");
  });

  it("blocks sharing one signage permit across two buildings at publication", () => {
    const a = sign();
    const b = sign({ store: 2666, name: "2666.1002 Signage 2027", street: "200 Second St" });
    const n = inputs([a, b], [permit()]);
    const report = valid(n);
    const forged = report.decisions.map((d) => ({
      ...d,
      status: "matched" as const,
      pulleyId: "prj_sign",
      reason: "OVERRIDE" as const,
    }));
    expect(() => assertPublicationInvariants(forged, n.acme, n.pulley)).toThrow();
  });
});

function workbook(
  columns: readonly { header: string }[],
  rows: unknown[][],
  bookType: "biff8" | "xlsx",
) {
  const book = utils.book_new();
  utils.book_append_sheet(
    book,
    utils.aoa_to_sheet([columns.map((c) => c.header), ...rows]),
    "Report",
  );
  return write(book, { type: "buffer", bookType }) as Buffer;
}

it("publishes parsed signage inputs, replays identically, and revalidates an override after upstream scope changes", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "signage-"));
  try {
    const config = {
      dataDir,
      retainRuns: 60,
      overridesFile: join(dataDir, "overrides.csv"),
      logLevel: "error" as const,
      siteLedger: { baseUrl: "https://sl.test", username: "fixture", password: "fixture" },
      pulley: { baseUrl: "https://p.test", apiKey: "fixture" },
    };
    await writeFile(
      config.overridesFile,
      `${header}1556.1002,prj_sign,matched,permit scope checked\n`,
    );
    const reports = {
      "project-register": workbook(
        PROJECT_REGISTER_COLUMNS,
        [["1556.1002", "ST-1556", "1556.1002 Signage 2027", 2027, "Signage", "Active"]],
        "biff8",
      ),
      "site-directory": workbook(
        SITE_DIRECTORY_COLUMNS,
        [["ST-1556", "Acme Market", 1556, "", "100 Main St", "Reno", "NV", "89501", "Washoe"]],
        "xlsx",
      ),
      "key-dates": Buffer.from(
        `${KEY_DATES_COLUMNS.map((c) => c.header).join(",")}\n1556.1002,,,,,2027-06-01\n`,
      ),
    };
    let projectType = "Signage";
    const http = new HttpClient({
      retries: 0,
      fetch: async (url) => {
        if (url.endsWith("/api/auth/login"))
          return Response.json({ token: "fixture", expiresAt: "2099-01-01T00:00:00Z" });
        for (const [name, bytes] of Object.entries(reports))
          if (url.endsWith(`/api/reports/${name}`)) return new Response(bytes);
        return Response.json({
          projects: [
            {
              id: "prj_sign",
              name: "1556.1002 Signage 2027",
              organization: "Acme Market",
              account_plan: "full_service",
              status: "In Progress",
              project_type: projectType,
              jurisdiction_city: "Reno",
              state: "NV",
              street_address: "100 Main St",
              permit_submitted: null,
              permit_approved: null,
              construction_start: "2027-06-01",
              created_at: "2026-10-01T00:00:00Z",
            },
          ],
          next_cursor: null,
        });
      },
    });
    const run = (minute: number, dryRun: boolean, acceptInputChange = false) =>
      runSync({
        config,
        http,
        log: createLogger("error", false),
        dryRun,
        acceptInputChange,
        now: () => new Date(Date.UTC(2026, 9, 8, 12, minute)),
      });
    const first = await run(0, false);
    expect(first.report.counts.matched).toBe(1);
    expect(first.summary).toContain("1 signage eligible only for Acme signage");
    const mapping = await readFile(join(first.outputDirectory, "mapping.csv"), "utf8");
    expect(mapping).toBe("acme_pcroject_id,pulley_project_id,status\n1556.1002,prj_sign,matched\n");
    const replay = await run(1, true);
    expect(await readFile(join(replay.outputDirectory, "mapping.csv"), "utf8")).toBe(mapping);
    const pointer = await readFile(join(dataDir, "out", "latest.json"), "utf8");
    projectType = "Remodel";
    await expect(run(2, false)).rejects.toThrow("matched rows fell from 1 to 0");
    expect(await readFile(join(dataDir, "out", "latest.json"), "utf8")).toBe(pointer);
    const changed = await run(3, false, true);
    expect(changed.report.counts.matched).toBe(0);
    expect(changed.summary).toContain("Dedicated signage must match signage");
    const record = JSON.parse(await readFile(join(changed.outputDirectory, "run.json"), "utf8"));
    expect(record.overrides.applied).toBe(0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
