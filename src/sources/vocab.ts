/**
 * Vocabulary checks for categorical fields.
 *
 * Upstream enums (status, project type, banner) are accepted as plain strings
 * at the boundary so an updated dataset with a new value degrades gracefully.
 * This module reports which values are outside the known set so the run log
 * and summary can surface them loudly.
 */

export interface VocabularyWarning {
  readonly source: string;
  readonly field: string;
  readonly value: string;
  readonly count: number;
}

export function findUnknownValues<T>(
  source: string,
  field: string,
  items: readonly T[],
  pick: (item: T) => string | null | undefined,
  known: readonly string[],
): VocabularyWarning[] {
  const knownSet = new Set(known);
  const counts = new Map<string, number>();
  for (const item of items) {
    const value = pick(item);
    if (value === null || value === undefined || knownSet.has(value)) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([value, count]) => ({ source, field, value, count }));
}
