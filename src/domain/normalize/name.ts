import { collapseWhitespace, stripDecorations } from "./text.ts";

/**
 * Project-name parser.
 *
 * Pulley names are free text typed by whoever opened the project. As of
 * 2026-10-08 there are 116 distinct shapes across 449 names. Rather than one
 * regex per shape, this extracts the facts that matter for matching and lets
 * the matcher decide what to trust:
 *
 * - full Acme ids           `1556.1002`
 * - store numbers           `#1570`, `Store 1570`, `Acme 1570 -`, `AM-1570`, `| 1570,`
 * - sequences               `.1004`, `Seq 1005`, `Proj 1001`, trailing `(1001)`
 * - years                   `-2027` in canonical names, `Remodel 2027`
 * - canonical structure     `STORE.SEQ-CITY-ST-BANNER-TYPE-YEAR`, used on both sides
 * - decorations             emoji, `[Canceled]`, `– Signage`
 *
 * Acme's own project names use the canonical structure, so the same parser
 * serves both sides.
 */

export interface CanonicalName {
  readonly store: number | null;
  readonly sequence: number | null;
  readonly city: string;
  readonly state: string;
  readonly bannerCode: string;
  readonly typeCode: string;
  readonly year: number;
}

export interface ParsedName {
  readonly raw: string;
  /** Cleaned text: no emoji, no bracket markers, ASCII dashes, single spaces. */
  readonly text: string;
  readonly markers: readonly string[];
  readonly canceledMarker: boolean;
  readonly signageHint: boolean;
  /** Mixed work scope needs review, not a hard signage-only classification. */
  readonly signageScopeHint: boolean;
  /** `store.sequence` ids, in order of appearance, deduplicated. */
  readonly fullIds: readonly string[];
  /** Store numbers, including those inside full ids. */
  readonly storeNumbers: readonly number[];
  /** Sequences found on their own (not inside a full id). */
  readonly sequences: readonly number[];
  readonly years: readonly number[];
  readonly canonical: CanonicalName | null;
  /** Trailing `City, ST` when present. */
  readonly cityState: { readonly city: string; readonly state: string } | null;
}

const FULL_ID = /\b(\d{4})\.(\d{4})\b/g;
const CANONICAL =
  /(?:\b(\d{4})\.(\d{4})-)?\b([A-Z][A-Z .'-]*?)-([A-Z]{2})-([A-Z]{3})-([A-Z]{2})-(\d{4})\b(?:\s*\((\d{4})\))?/;
const SEQUENCE_ONLY = /(?<![\d.])\.(\d{4})\b/g;
const SEQUENCE_WORD = /\b(?:SEQ|SEQUENCE|PROJ|PROJECT)\s*#?\s*(\d{4})\b/g;
const TRAILING_PAREN_SEQUENCE = /\((\d{4})\)\s*$/;
const FOUR_DIGITS = /\b(\d{4})\b/g;
const STORE_MARKER_BEFORE =
  /(?:#|\bSTORE\b|\bCLUB\b|\bAM-|\bACME\b(?:\s+(?:WC|MKT|MARKET|WAREHOUSE CLUB))?\s*[-|:]?|\|)\s*#?\s*$/;
// Same supported program-year range as the register schema. Bare numbers
// in this range are ambiguous years, never proof of a building identity.
const YEAR_MIN = 2000;
const YEAR_MAX = 2100;
const CITY_STATE = /([A-Za-z][A-Za-z .'-]*?),\s*([A-Z]{2})\b/g;

export function parseProjectName(raw: string): ParsedName {
  const { text, markers, canceledMarker } = stripDecorations(raw);
  // Decorations may contain real identity/exclusion evidence. Keep them in
  // extraction even though the cleaned display text omits bracket prefixes.
  const upper = [...markers, text].join(" ").toUpperCase();
  const facts = new Facts();

  extractFullIds(upper, facts);
  const canonical = parseCanonical(upper);
  if (canonical) {
    facts.addYear(canonical.year);
    if (canonical.sequence !== null && canonical.store === null) {
      facts.addSequence(canonical.sequence);
    }
  }
  extractSequences(upper, facts);
  claimStreetNumbers(upper, facts);
  classifyRemainingNumbers(upper, facts);
  const signage = signageEvidence(upper, markers);

  return {
    raw,
    text,
    markers,
    canceledMarker,
    signageHint: signage.hard,
    signageScopeHint: signage.scope,
    fullIds: facts.fullIds,
    storeNumbers: facts.storeNumbers,
    sequences: facts.sequences,
    years: facts.years,
    canonical,
    cityState: parseCityState(text),
  };
}

function signageEvidence(
  upper: string,
  markers: readonly string[],
): { hard: boolean; scope: boolean } {
  const marker = markers.some((value) => /^(?:signage|sign|signs)$/i.test(value.trim()));
  const words =
    /\bSIGNAGE\b|\bSIGNS?\s+(?:PERMIT|PACKAGE|INSTALLATION|REPLACEMENT|REMODEL)\b|\b(?:MONUMENT|PYLON|EXTERIOR|WALL)\s+SIGNS?\b/.test(
      upper,
    );
  const mixed =
    /\b(?:REMODEL|EXPANSION|NEW BUILD|RM|EX|NB)\b/.test(upper) &&
    /[+&]|\b(?:WITH|INCLUDING|INCLUDES|AND)\b/.test(upper);
  const dedicated =
    marker ||
    /\b(?:ONLY|SEPARATE|DEDICATED)\s+(?:SIGNAGE|SIGNS?)\b|\b(?:SIGNAGE|SIGNS?)\s+(?:ONLY|PERMIT|PACKAGE)\b/.test(
      upper,
    );
  const scope = words && mixed && !dedicated;
  return { hard: marker || (words && !scope), scope };
}

/** House numbers embedded in a recognizable street address are neither years nor stores. */
function claimStreetNumbers(upper: string, facts: Facts): void {
  const street =
    /\b\d{1,6}[A-Z]?\s+(?:(?:[A-Z][A-Z'.-]*|\d+(?:ST|ND|RD|TH))\s+){1,5}(?:STREET|ST|ROAD|RD|AVENUE|AVE|BOULEVARD|BLVD|DRIVE|DR|LANE|LN|WAY|COURT|CT|PARKWAY|PKWY|PIKE|PLACE|PL|TRAIL|TRL)\b/g;
  const route =
    /\b\d{1,6}[A-Z]?\s+(?:(?:US|STATE|COUNTY)\s+)?(?:HIGHWAY|HWY|ROUTE|RTE)\s+\d+[A-Z]?\b/g;
  for (const match of [...upper.matchAll(street), ...upper.matchAll(route)]) {
    if (facts.isClaimed(match.index)) continue;
    if (STORE_MARKER_BEFORE.test(upper.slice(Math.max(0, match.index - 64), match.index))) continue;
    facts.claim(match.index, match[0].length);
  }
}

/** Accumulates extracted facts and the character ranges already explained by a stronger pattern. */
class Facts {
  readonly fullIds: string[] = [];
  readonly storeNumbers: number[] = [];
  readonly sequences: number[] = [];
  readonly years: number[] = [];
  readonly #claimed: Array<readonly [number, number]> = [];

  claim(start: number, length: number): void {
    this.#claimed.push([start, start + length]);
  }

  isClaimed(index: number): boolean {
    return this.#claimed.some(([start, end]) => index >= start && index < end);
  }

  addFullId(id: string): void {
    pushUnique(this.fullIds, id);
  }
  addStore(value: number): void {
    pushUnique(this.storeNumbers, value);
  }
  addSequence(value: number): void {
    pushUnique(this.sequences, value);
  }
  addYear(value: number): void {
    pushUnique(this.years, value);
  }
}

function extractFullIds(upper: string, facts: Facts): void {
  for (const match of upper.matchAll(FULL_ID)) {
    facts.addFullId(match[0]);
    facts.addStore(Number(match[1]));
    facts.claim(match.index, match[0].length);
  }
}

function extractSequences(upper: string, facts: Facts): void {
  for (const match of upper.matchAll(SEQUENCE_ONLY)) {
    if (facts.isClaimed(match.index + 1)) continue;
    facts.addSequence(Number(match[1]));
    facts.claim(match.index, match[0].length);
  }
  for (const match of upper.matchAll(SEQUENCE_WORD)) {
    const digitsAt = match.index + match[0].length - 4;
    if (facts.isClaimed(digitsAt)) continue;
    facts.addSequence(Number(match[1]));
    facts.claim(match.index, match[0].length);
  }
  const trailing = TRAILING_PAREN_SEQUENCE.exec(upper);
  if (trailing?.[1] && !facts.isClaimed(trailing.index + 1)) {
    facts.addSequence(Number(trailing[1]));
    facts.claim(trailing.index, trailing[0].length);
  }
}

/** Every unclaimed 4-digit token is a store (when marked or out of the year range) or a year. */
function classifyRemainingNumbers(upper: string, facts: Facts): void {
  for (const match of upper.matchAll(FOUR_DIGITS)) {
    if (facts.isClaimed(match.index)) continue;
    const value = Number(match[1]);
    const before = upper.slice(Math.max(0, match.index - 64), match.index);
    const marked = STORE_MARKER_BEFORE.test(before);
    if (!marked && value >= YEAR_MIN && value <= YEAR_MAX) facts.addYear(value);
    else facts.addStore(value);
  }
}

function parseCanonical(upper: string): CanonicalName | null {
  const match = CANONICAL.exec(upper);
  if (!match) return null;
  const [, store, sequence, city, state, bannerCode, typeCode, year, parenSequence] = match;
  if (!city || !state || !bannerCode || !typeCode || !year) return null;
  return {
    store: store ? Number(store) : null,
    sequence: sequence ? Number(sequence) : parenSequence ? Number(parenSequence) : null,
    city: collapseWhitespace(city),
    state,
    bannerCode,
    typeCode,
    year: Number(year),
  };
}

/** Segments are split on ` - `, ` | `, `/`, and parentheses so a prefix like "Acme Market - " never leaks into the city. */
const SEGMENT_SEPARATOR = /\s[-|/]\s|[()|/]/;

function parseCityState(text: string): ParsedName["cityState"] {
  let last: ParsedName["cityState"] = null;
  for (const segment of text.split(SEGMENT_SEPARATOR)) {
    for (const match of segment.matchAll(CITY_STATE)) {
      const city = collapseWhitespace(match[1] ?? "");
      const state = match[2] ?? "";
      if (city && state) last = { city, state };
    }
  }
  return last;
}

function pushUnique<T>(list: T[], value: T): void {
  if (!list.includes(value)) list.push(value);
}
