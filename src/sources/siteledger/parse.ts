import { parse as parseCsv } from "csv-parse/sync";
import { read as readWorkbook, utils as sheetUtils } from "xlsx";
import type { z } from "zod";
import { SchemaError } from "../../errors.ts";
import {
  type ColumnSpec,
  KEY_DATES_COLUMNS,
  type KeyDatesRow,
  keyDatesRowSchema,
  PROJECT_REGISTER_COLUMNS,
  type ProjectRegisterRow,
  projectRegisterRowSchema,
  SITE_DIRECTORY_COLUMNS,
  type SiteDirectoryRow,
  siteDirectoryRowSchema,
} from "./schemas.ts";

/**
 * Parsers for the three SiteLedger reports.
 *
 * Each parser: locate the header row, verify the header matches the contract
 * exactly, map cells to keyed objects, validate every row with Zod, and fail
 * with one `SchemaError` that lists the first problems. Warnings carry
 * non-fatal observations (for example a row-count banner that disagrees with
 * the rows actually present).
 */

export interface ParsedReport<T> {
  readonly rows: readonly T[];
  readonly warnings: readonly string[];
}

const MAX_REPORTED_PROBLEMS = 10;

// ---------- Public API ----------

/** Project Register: legacy BIFF8 `.xls` with a three-line banner above the header. */
export function parseProjectRegister(bytes: Uint8Array): ParsedReport<ProjectRegisterRow> {
  const grid = workbookGrid(bytes, "Project Register");
  return parseGrid("Project Register", grid, PROJECT_REGISTER_COLUMNS, projectRegisterRowSchema);
}

/** Site Directory: `.xlsx`, header on the first row. */
export function parseSiteDirectory(bytes: Uint8Array): ParsedReport<SiteDirectoryRow> {
  const grid = workbookGrid(bytes, "Site Directory");
  return parseGrid("Site Directory", grid, SITE_DIRECTORY_COLUMNS, siteDirectoryRowSchema);
}

/** Key Dates: CSV, header on the first row, US-formatted dates. */
export function parseKeyDates(bytes: Uint8Array | string): ParsedReport<KeyDatesRow> {
  const text = typeof bytes === "string" ? bytes : new TextDecoder("utf-8").decode(bytes);
  let grid: unknown[][];
  try {
    grid = parseCsv(text, {
      bom: true,
      columns: false,
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
    }) as unknown[][];
  } catch (error) {
    throw new SchemaError("Key Dates: could not parse CSV", { cause: error });
  }
  return parseGrid("Key Dates", grid, KEY_DATES_COLUMNS, keyDatesRowSchema);
}

// ---------- Internals ----------

function workbookGrid(bytes: Uint8Array, reportName: string): unknown[][] {
  if (bytes.byteLength === 0) {
    throw new SchemaError(`${reportName}: report is empty`);
  }
  let workbook: ReturnType<typeof readWorkbook>;
  try {
    workbook = readWorkbook(bytes, { type: "array", cellDates: false, raw: true });
  } catch (error) {
    throw new SchemaError(`${reportName}: could not read workbook`, { cause: error });
  }
  const sheetName = workbook.SheetNames[0];
  const sheet = sheetName === undefined ? undefined : workbook.Sheets[sheetName];
  if (!sheetName || !sheet) {
    throw new SchemaError(`${reportName}: workbook has no sheets`);
  }
  return sheetUtils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: true,
    defval: null,
    blankrows: false,
  });
}

function cellToText(cell: unknown): string {
  if (cell === null || cell === undefined) return "";
  return String(cell).trim();
}

function isBlankRow(row: unknown[]): boolean {
  return row.every((cell) => cellToText(cell) === "");
}

function parseGrid<S extends z.ZodType>(
  reportName: string,
  grid: unknown[][],
  columns: readonly ColumnSpec[],
  schema: S,
): ParsedReport<z.output<S>> {
  const warnings: string[] = [];
  const headerIndex = findHeaderRow(grid, columns);
  if (headerIndex === -1) {
    throw new SchemaError(`${reportName}: header row not found`, {
      details: {
        expectedFirstHeader: columns[0]?.header,
        firstRows: grid.slice(0, 5).map((row) => row.map(cellToText)),
      },
    });
  }

  const headerRow = (grid[headerIndex] ?? []).map(cellToText);
  const headerProblems = compareHeaders(headerRow, columns);
  if (headerProblems.length > 0) {
    throw new SchemaError(`${reportName}: header does not match the expected contract`, {
      details: {
        expected: columns.map((c) => c.header),
        actual: headerRow,
        problems: headerProblems,
      },
    });
  }

  const expectedCount = bannerRowCount(grid.slice(0, headerIndex));

  const rows: z.output<S>[] = [];
  const problems: string[] = [];
  for (let i = headerIndex + 1; i < grid.length; i++) {
    const raw = grid[i] ?? [];
    if (isBlankRow(raw)) continue;
    const record: Record<string, unknown> = {};
    columns.forEach((column, index) => {
      record[column.key] = raw[index] ?? null;
    });
    const result = schema.safeParse(record);
    if (result.success) {
      rows.push(result.data);
    } else if (problems.length < MAX_REPORTED_PROBLEMS) {
      const issues = result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      problems.push(`row ${i + 1}: ${issues}`);
    } else {
      problems.push("…");
      break;
    }
  }

  if (problems.length > 0) {
    throw new SchemaError(`${reportName}: ${problems.length} row(s) failed validation`, {
      details: { problems },
    });
  }

  if (expectedCount !== null && expectedCount !== rows.length) {
    warnings.push(
      `${reportName}: banner says ${expectedCount} rows but ${rows.length} data rows were found`,
    );
  }
  if (rows.length === 0) {
    warnings.push(`${reportName}: no data rows`);
  }

  return { rows, warnings };
}

function findHeaderRow(grid: unknown[][], columns: readonly ColumnSpec[]): number {
  const first = columns[0]?.header;
  if (!first) return -1;
  return grid.findIndex((row) => cellToText(row[0]) === first);
}

function compareHeaders(actual: readonly string[], columns: readonly ColumnSpec[]): string[] {
  const problems: string[] = [];
  columns.forEach((column, index) => {
    const found = actual[index] ?? "";
    if (found !== column.header) {
      problems.push(`column ${index + 1}: expected "${column.header}", found "${found}"`);
    }
  });
  const extra = actual.slice(columns.length).filter((cell) => cell !== "");
  if (extra.length > 0) problems.push(`unexpected extra column(s): ${extra.join(", ")}`);
  return problems;
}

/** Reports may carry a banner such as "Rows: 400" above the header. */
function bannerRowCount(preamble: unknown[][]): number | null {
  for (const row of preamble) {
    for (const cell of row) {
      const match = /\bRows:\s*(\d+)\b/.exec(cellToText(cell));
      if (match?.[1]) return Number(match[1]);
    }
  }
  return null;
}
