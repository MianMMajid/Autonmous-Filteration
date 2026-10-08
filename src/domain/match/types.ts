/**
 * Matcher output types. One `MatchDecision` per Acme project; this is the
 * row that becomes `mapping.csv`. Candidates and evidence feed `review.csv`.
 */

export const OutputStatus = {
  Matched: "matched",
  NeedsReview: "needs_review",
  NoMatch: "no_match",
} as const;
export type OutputStatus = (typeof OutputStatus)[keyof typeof OutputStatus];

export const Tier = {
  ExactId: 1,
  Store: 2,
  Sequence: 3,
  Address: 4,
  Dates: 5,
  Locality: 6,
} as const;
export type Tier = (typeof Tier)[keyof typeof Tier];

/**
 * Why a decision came out the way it did. Stable strings: they appear in
 * review.csv and operators learn them.
 */
export const ReasonCode = {
  /** Full store.sequence found in exactly one candidate name. */
  ExactId: "EXACT_ID",
  /** Store number (current or former) plus compatible type and year narrowed to one candidate. */
  StoreTypeYear: "STORE_TYPE_YEAR",
  /** No store in the Pulley name, but sequence plus city and state identify one Acme project uniquely. */
  SequenceLocality: "SEQUENCE_LOCALITY",
  /** No usable number in the Pulley name; exact street match narrowed to one candidate. */
  Address: "ADDRESS",
  /** No usable number or street, but milestone dates within a week in the same city identify one Acme project uniquely. */
  DateLocality: "DATE_LOCALITY",
  /** More than one candidate survived the deciding tier. */
  Ambiguous: "AMBIGUOUS",
  /** The only candidate has an incompatible project type. */
  TypeMismatch: "TYPE_MISMATCH",
  /** One side is canceled or closed and the other is not. */
  StatusConflict: "STATUS_CONFLICT",
  /** Weak evidence only: same street name (house number differs) or same locality, type, and year. */
  WeakEvidence: "WEAK_EVIDENCE",
  /** Nothing in the candidate pool relates to this project. */
  NoCandidate: "NO_CANDIDATE",
  /** Projects at this store exist, but each is explicitly another line (different sequence or year) of another type. */
  UnrelatedOnly: "UNRELATED_ONLY",
  /** The only project carrying this id or store is pathfinder or signage, which the brief excludes. */
  ExcludedOnly: "EXCLUDED_ONLY",
} as const;
export type ReasonCode = (typeof ReasonCode)[keyof typeof ReasonCode];

export const SequenceRelation = {
  Equal: "equal",
  Unknown: "unknown",
  Different: "different",
} as const;
export type SequenceRelation = (typeof SequenceRelation)[keyof typeof SequenceRelation];

export const YearSignal = {
  /** Year written in the Pulley name equals the Acme program year. */
  NameEqual: "name_equal",
  /** A Pulley date falls in the Acme program year. */
  DateEqual: "date_equal",
  /** No usable year on the Pulley side. */
  None: "none",
  /** A Pulley date exists but is in a different year. */
  DateDifferent: "date_different",
  /** Year written in the Pulley name differs from the Acme program year. */
  NameDifferent: "name_different",
} as const;
export type YearSignal = (typeof YearSignal)[keyof typeof YearSignal];

export interface Evidence {
  readonly exactId: boolean;
  readonly storeMatch: boolean;
  /** Smallest gap in days between corresponding milestone dates; null when none overlap. */
  readonly proximityDays: number | null;
  /** Combined year-and-date verdict; see `compat.ts`. */
  readonly temporal: "same" | "near" | "unknown" | "conflict";
  readonly typeCompatible: boolean;
  readonly typeEqual: boolean;
  readonly year: YearSignal;
  readonly sequence: SequenceRelation;
  readonly streetExact: boolean;
  readonly streetName: boolean;
  readonly cityMatch: boolean;
  /** Statuses pass the brief's canceled-on-both-sides rule. */
  readonly statusAgree: boolean;
}

export interface Candidate {
  readonly pulleyId: string;
  readonly pulleyName: string;
  readonly pulleyStatus: string;
  readonly pulleyType: string;
  readonly tier: Tier;
  readonly evidence: Evidence;
  /** Higher is better within a tier. Deterministic; ties are real ties. */
  readonly score: number;
}

export interface MatchDecision {
  readonly acmeId: string;
  readonly acmeName: string;
  readonly acmeStatus: string;
  readonly acmeType: string;
  readonly programYear: number;
  readonly status: OutputStatus;
  readonly pulleyId: string | null;
  readonly reason: ReasonCode;
  readonly tier: Tier | null;
  /** Best candidates first; the winner (if any) is first. */
  readonly candidates: readonly Candidate[];
  /** One-line human explanation for the review file. */
  readonly note: string;
}

export interface MatchReport {
  readonly decisions: readonly MatchDecision[];
  /** Candidate-pool Pulley projects that no Acme project matched. */
  readonly unmatchedPulley: readonly {
    readonly id: string;
    readonly name: string;
    readonly status: string;
  }[];
  /** Full ids written in Pulley names that do not exist in the register. */
  readonly pulleyIdsNotInRegister: readonly {
    readonly pulleyId: string;
    readonly acmeId: string;
  }[];
  readonly counts: Readonly<Record<OutputStatus, number>>;
  readonly reasons: Readonly<Record<string, number>>;
}
