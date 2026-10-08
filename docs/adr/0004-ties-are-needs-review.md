# ADR 0004: Ambiguity produces needs_review, never a best guess

Date: 2026-10-08. Status: accepted.

## Context

The Account Lead's team can hand-check "a few a week, but not many." A wrong
`matched` row silently corrupts the sync between the two systems and is
expensive to notice. A `needs_review` row costs a minute of a reviewer's time.

## Decision

When a tier yields more than one surviving candidate, or when statuses
conflict, the matcher emits `needs_review` with all candidates listed. No
probabilistic scoring picks a winner among near-equals.

## Consequences

- Precision over recall. The match percentage estimate must be derived from a
  hand-checked sample, not from the tool's own confidence.
- The review file must make the decision fast: reason code, candidates, tier.
- Narrowing rules (type, year, address) exist to reduce ties, and they are
  only added when the data shows they are reliable.
