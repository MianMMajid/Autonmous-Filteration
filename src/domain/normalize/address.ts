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
  /\b(?:SUITE|STE|UNIT|APT|APARTMENT|FLOOR|FL|ROOM|RM|SPACE|SPC|DEPT)\b\.?\s*#?\s*[A-Z0-9-]+/g;
const HASH_UNIT_PATTERN = /#\s*[A-Z0-9-]+/g;
const BUILDING_PATTERN = /\b(?:BLDG|BUILDING)\b\.?\s*#?\s*([A-Z0-9-]+)/g;

/**
 * Build a comparison key for a street address, or null when there is nothing
 * usable (missing, blank, or no house number and street).
 */
export function normalizeStreet(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const upper = dropVenuePrefix(raw.toUpperCase());
  // Buildings sharing a street address are not interchangeable. Preserve
  // designators even when they precede a comma and the house number.
  const buildings = [...new Set([...upper.matchAll(BUILDING_PATTERN)].map((m) => m[1]))].sort();
  let text = upper.replace(BUILDING_PATTERN, " ");
  text = text.replace(UNIT_PATTERN, " ").replace(HASH_UNIT_PATTERN, " ");
  text = text
    .replace(/[.,;:()'"]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text === "") return null;

  if (PLACEHOLDERS.has(text)) return null;
  const tokens = normalizeTokens(text.split(" "));
  const merged = mergeDirectionals(tokens);
  // A usable key has a house number followed by at least one street token;
  // "Main St" or "N/A" must never compare equal to anything.
  if (merged.length < 2 || !HOUSE_NUMBER.test(merged[0] ?? "")) return null;
  return [...merged, ...buildings.flatMap((building) => ["BLDG", building])].join(" ");
}

/** Normalize positions, not words inside a street's proper name. In
 * "100 North Street", North is the entire name, not a directional prefix.
 */
function normalizeTokens(tokens: string[]): string[] {
  const last = tokens.length - 1;
  const trailingDirection = tokens.length >= 3 && DIRECTIONALS[tokens[last] ?? ""] !== undefined;
  const suffix = trailingDirection ? last - 1 : last;
  const word = tokens[suffix] ?? "";
  const hasSuffix = SUFFIXES[word] !== undefined;
  tokens[suffix] = SUFFIXES[word] ?? word;
  if (trailingDirection) tokens[last] = DIRECTIONALS[tokens[last] ?? ""] ?? "";
  const nameEnd = hasSuffix ? suffix - 1 : suffix;
  if (nameEnd > 1) tokens[1] = DIRECTIONALS[tokens[1] ?? ""] ?? tokens[1] ?? "";
  if (
    nameEnd > 2 &&
    (tokens[1] === "N" || tokens[1] === "S") &&
    ["E", "W", "EAST", "WEST"].includes(tokens[2] ?? "")
  ) {
    tokens[2] = DIRECTIONALS[tokens[2] ?? ""] ?? "";
  }
  normalizeCompoundNames(tokens, hasSuffix ? suffix : null);
  return tokens;
}

function normalizeCompoundNames(tokens: string[], suffix: number | null): void {
  for (let i = 1; i < tokens.length - 1; i++) {
    const token = tokens[i] ?? "";
    // Numbered routes use a prefix, rather than a final street suffix.
    if (["HIGHWAY", "ROUTE"].includes(token) && HOUSE_NUMBER.test(tokens[i + 1] ?? ""))
      tokens[i] = SUFFIXES[token] ?? token;
    // Town Center Blvd is commonly abbreviated Town Ctr Blvd. Preserve a
    // sole proper name such as Center Street and all other internal words.
    if (suffix !== null && i > 1 && i < suffix && ["CENTER", "CENTRE"].includes(token))
      tokens[i] = "CTR";
  }
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
  const buildings = segments
    .slice(0, index)
    .filter((segment) => /^\s*(?:BLDG|BUILDING)\.?\s*#?\s*[A-Z0-9-]+\s*$/.test(segment));
  return [...segments.slice(index), ...buildings].join(",");
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
