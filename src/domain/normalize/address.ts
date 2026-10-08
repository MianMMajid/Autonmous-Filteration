/**
 * Street address normalization for equality matching.
 *
 * Goal: "3546 SYCAMORE RD." and "3546 Sycamore Road, Suite A" produce the same
 * key. This is deliberately a key builder, not a geocoder: it standardizes
 * case, punctuation, directionals, suffixes, and unit designators, and
 * nothing else. Two different streets must never collapse to one key.
 */

const SUFFIXES: Readonly<Record<string, string>> = {
  ALLEY: "ALY",
  ALY: "ALY",
  AVENUE: "AVE",
  AV: "AVE",
  AVE: "AVE",
  BOULEVARD: "BLVD",
  BLVD: "BLVD",
  BOUL: "BLVD",
  CENTER: "CTR",
  CENTRE: "CTR",
  CTR: "CTR",
  CIRCLE: "CIR",
  CIR: "CIR",
  COURT: "CT",
  CT: "CT",
  CROSSING: "XING",
  XING: "XING",
  DRIVE: "DR",
  DR: "DR",
  EXPRESSWAY: "EXPY",
  EXPY: "EXPY",
  FREEWAY: "FWY",
  FWY: "FWY",
  HIGHWAY: "HWY",
  HWY: "HWY",
  LANE: "LN",
  LN: "LN",
  LOOP: "LOOP",
  PARKWAY: "PKWY",
  PKWY: "PKWY",
  PKY: "PKWY",
  PIKE: "PIKE",
  PLACE: "PL",
  PL: "PL",
  PLAZA: "PLZ",
  PLZ: "PLZ",
  ROAD: "RD",
  RD: "RD",
  ROUTE: "RTE",
  RTE: "RTE",
  SQUARE: "SQ",
  SQ: "SQ",
  STREET: "ST",
  STR: "ST",
  ST: "ST",
  TERRACE: "TER",
  TER: "TER",
  TRAIL: "TRL",
  TRL: "TRL",
  TURNPIKE: "TPKE",
  TPKE: "TPKE",
  WAY: "WAY",
};

const DIRECTIONALS: Readonly<Record<string, string>> = {
  NORTH: "N",
  SOUTH: "S",
  EAST: "E",
  WEST: "W",
  NORTHEAST: "NE",
  NORTHWEST: "NW",
  SOUTHEAST: "SE",
  SOUTHWEST: "SW",
  N: "N",
  S: "S",
  E: "E",
  W: "W",
  NE: "NE",
  NW: "NW",
  SE: "SE",
  SW: "SW",
};

const HOUSE_NUMBER = /^\d+[A-Z]?$/;
const PLACEHOLDERS: ReadonlySet<string> = new Set([
  "N/A",
  "NA",
  "N A",
  "NONE",
  "UNKNOWN",
  "TBD",
  "-",
  "--",
  "?",
]);

/** Unit designators and the token that follows them are not part of the street. */
const UNIT_PATTERN =
  /\b(?:SUITE|STE|UNIT|APT|APARTMENT|BLDG|BUILDING|FLOOR|FL|ROOM|RM|SPACE|SPC|DEPT)\b\.?\s*#?\s*[A-Z0-9-]+/g;
const HASH_UNIT_PATTERN = /#\s*[A-Z0-9-]+/g;

/**
 * Build a comparison key for a street address, or null when there is nothing
 * usable (missing, blank, or no house number and street).
 */
export function normalizeStreet(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  let text = dropVenuePrefix(raw.toUpperCase());
  text = text.replace(UNIT_PATTERN, " ").replace(HASH_UNIT_PATTERN, " ");
  text = text
    .replace(/[.,;:()'"]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text === "") return null;

  if (PLACEHOLDERS.has(text)) return null;
  const tokens = text.split(" ").map((token) => DIRECTIONALS[token] ?? SUFFIXES[token] ?? token);
  const merged = mergeDirectionals(tokens);
  // A usable key has a house number followed by at least one street token;
  // "Main St" or "N/A" must never compare equal to anything.
  if (merged.length < 2 || !HOUSE_NUMBER.test(merged[0] ?? "")) return null;
  return merged.join(" ");
}

/**
 * Street name without the house number, for the weaker "same street" signal.
 *
 * Observed 2026-10-08: 39 of 43 Pulley addresses that miss the directory
 * exactly are the right street with a mistyped house number (411 vs 501,
 * 3288 vs 3688). This key lets the matcher use that as corroboration while
 * never treating it as proof on its own.
 */
export function streetNameKey(raw: string | null | undefined): string | null {
  const key = normalizeStreet(raw);
  if (key === null) return null;
  const withoutNumber = key.replace(/^\d+[A-Z]?\s+/, "");
  return withoutNumber === "" || withoutNumber === key ? null : withoutNumber;
}

/**
 * "Lakeview Crossing, 3688 NW Sunset Way" carries a venue name before the
 * street. When a comma-separated segment starts with a house number, keep
 * from that segment on and drop what precedes it.
 */
function dropVenuePrefix(text: string): string {
  const segments = text.split(",");
  if (segments.length < 2) return text;
  const index = segments.findIndex((segment) => /^\s*\d+[A-Z]?\s+\S/.test(segment));
  if (index <= 0) return text;
  return segments.slice(index).join(",");
}

/** "N E" (from "N.E.") becomes "NE"; only single-letter pairs are merged. */
function mergeDirectionals(tokens: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const current = tokens[i] ?? "";
    const next = tokens[i + 1];
    if ((current === "N" || current === "S") && (next === "E" || next === "W")) {
      out.push(`${current}${next}`);
      i++;
      continue;
    }
    out.push(current);
  }
  return out;
}
