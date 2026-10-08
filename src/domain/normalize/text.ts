/**
 * Low-level text helpers shared by the name and address normalizers.
 */

/** Unicode dashes that people paste into names. */
const DASHES = /[‐-―−]/g;

/** Leading symbols and emoji (including variation selectors) before any real content. */
const LEADING_DECORATION = /^[^\p{L}\p{N}#[(]+/u;

const BRACKET_MARKER = /^\[([^\]]+)\]\s*/;

export interface Decorated {
  readonly text: string;
  /** Bracketed prefixes such as `[Canceled]`, in order, without brackets. */
  readonly markers: readonly string[];
  readonly canceledMarker: boolean;
}

/**
 * Strip emoji, leading symbols, and bracketed status markers from a name.
 * Dashes are normalized to ASCII and whitespace collapsed.
 */
export function stripDecorations(raw: string): Decorated {
  let text = raw.replace(DASHES, "-").replace(/\s+/g, " ").trim();
  const markers: string[] = [];
  for (;;) {
    text = text.replace(LEADING_DECORATION, "");
    const marker = BRACKET_MARKER.exec(text);
    if (!marker?.[1]) break;
    markers.push(marker[1].trim());
    text = text.slice(marker[0].length);
  }
  return {
    text: text.trim(),
    markers,
    canceledMarker: markers.some((marker) => /cancel/i.test(marker)),
  };
}

export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Case-insensitive, whitespace-insensitive equality for labels such as city names. */
export function labelKey(value: string): string {
  return collapseWhitespace(value).toUpperCase();
}
