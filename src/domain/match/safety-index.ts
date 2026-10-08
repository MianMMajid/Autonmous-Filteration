import type { AcmeProject, PulleyRecord } from "../model.ts";
import { labelKey } from "../normalize/text.ts";
import {
  acmeState,
  acmeStoreNumbers,
  cityMatches,
  dateProximityDays,
  isInScope,
  statusesAgree,
  storeContradicts,
  Temporal,
  temporalVerdict,
  typesCompatible,
} from "./compat.ts";

function add<T>(index: Map<string, T[]>, key: string, value: T): void {
  const bucket = index.get(key);
  if (bucket) bucket.push(value);
  else index.set(key, [value]);
}
const scope = (banner: string | null, state: string | null, value: string | number): string =>
  `${banner}|${state}|${value}`;

/** Per-run indexes. No cross-run cache: refreshed inputs always rebuild ownership. */
export function createSafetyIndex(register: readonly AcmeProject[], pool: readonly PulleyRecord[]) {
  const sites = new Map<string, AcmeProject[]>();
  const ids = new Map<string, AcmeProject[]>();
  const stores = new Map<string, AcmeProject[]>();
  const streets = new Map<string, AcmeProject[]>();
  const cities = new Map<string, AcmeProject[]>();
  const candidateIds = new Map<string, PulleyRecord[]>();
  const candidateStores = new Map<string, PulleyRecord[]>();
  const candidateStreets = new Map<string, PulleyRecord[]>();
  const candidateCities = new Map<string, PulleyRecord[]>();
  for (const a of register) {
    const key = (v: string | number) => scope(a.banner, acmeState(a), v);
    add(sites, a.siteId, a);
    for (const store of acmeStoreNumbers(a)) {
      add(ids, key(`${store}.${a.sequence}`), a);
      add(stores, key(store), a);
    }
    if (a.site?.streetKey) add(streets, key(a.site.streetKey), a);
    if (a.site) add(cities, key(labelKey(a.site.city)), a);
  }
  for (const p of pool.filter((candidate) => !candidate.isPathfinder && !candidate.isSignage)) {
    const key = (v: string | number) => scope(p.banner, p.state, v);
    for (const id of p.parsedName.fullIds) add(candidateIds, key(id), p);
    for (const store of p.parsedName.storeNumbers) add(candidateStores, key(store), p);
    if (p.parsedName.storeNumbers.length > 0) continue;
    if (p.streetKey) add(candidateStreets, key(p.streetKey), p);
    for (const city of cityKeys(p)) add(candidateCities, key(city), p);
  }
  return {
    exactCandidates: (a: AcmeProject): readonly PulleyRecord[] =>
      (candidateIds.get(scope(a.banner, acmeState(a), a.id)) ?? []).filter((p) => isInScope(a, p)),
    storeCandidates: (a: AcmeProject): readonly PulleyRecord[] =>
      [
        ...new Set(
          acmeStoreNumbers(a).flatMap(
            (n) => candidateStores.get(scope(a.banner, acmeState(a), n)) ?? [],
          ),
        ),
      ].filter((p) => isInScope(a, p)),
    siteProjects: (a: AcmeProject): readonly AcmeProject[] => sites.get(a.siteId) ?? [],
    related(a: AcmeProject, p: PulleyRecord): readonly AcmeProject[] {
      const key = (v: string | number) => scope(p.banner, p.state, v);
      const relevant = new Set(sites.get(a.siteId) ?? []);
      const include = (values: readonly AcmeProject[] | undefined) => {
        for (const value of values ?? []) relevant.add(value);
      };
      for (const id of p.parsedName.fullIds) include(ids.get(key(id)));
      for (const store of p.parsedName.storeNumbers) include(stores.get(key(store)));
      if (p.streetKey) include(streets.get(key(p.streetKey)));
      if (p.parsedName.storeNumbers.length === 0)
        for (const city of cityKeys(p)) include(cities.get(key(city)));
      return [...relevant];
    },
    compatibleCandidates(a: AcmeProject): readonly PulleyRecord[] {
      const key = (v: string | number) => scope(a.banner, acmeState(a), v);
      const candidates = new Set(
        acmeStoreNumbers(a).flatMap((n) => candidateStores.get(key(n)) ?? []),
      );
      if (a.site?.streetKey)
        for (const p of candidateStreets.get(key(a.site.streetKey)) ?? []) candidates.add(p);
      if (a.site) {
        for (const p of candidateCities.get(key(labelKey(a.site.city))) ?? []) {
          const gap = dateProximityDays(a, p);
          if (
            cityMatches(a, p) &&
            (p.parsedName.sequences.includes(a.sequence) || (gap !== null && gap <= 7))
          )
            candidates.add(p);
        }
      }
      return [...candidates].filter(
        (p) =>
          isInScope(a, p) &&
          !storeContradicts(a, p) &&
          typesCompatible(a.projectType, p.projectType) &&
          statusesAgree(a.status, p.status) &&
          temporalVerdict(a, p) !== Temporal.Conflict,
      );
    },
  };
}

function cityKeys(p: PulleyRecord): readonly string[] {
  const named = p.parsedName.cityState?.city ?? p.parsedName.canonical?.city;
  return [...new Set([p.jurisdictionCity, ...(named ? [named] : [])].map(labelKey))];
}
export type SafetyIndex = ReturnType<typeof createSafetyIndex>;
