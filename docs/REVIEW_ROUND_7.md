# Review round 7 — rules 2026-10-08.11

The ten reported findings were reproduced or traced through the affected paths.
Fixes are covered by 49 new regression cases plus updated expectations for
explicitly disputed composite IDs, empty override inputs and Center/Ctr aliases.
No customer decisions were invented, no upstream data was changed, and no live
publication was replaced during this repair.

## Disposition

| Finding | Implemented behavior |
|---|---|
| 1. Store/year/house-number confusion | Punctuated brand prefixes identify stores across 2000–2100. Recognizable embedded street and numbered-route addresses claim house numbers before year/store extraction. Genuine explicit years remain evidence. |
| 2. Signage scope hard-blocks remodel | Mixed work such as Remodel + exterior signs produces a soft scope-confirmation hold. An explained override can resolve it. Signage-only/separate markers, sign permit/package labels, structured Signage, and other hard conflicts remain blocked. |
| 3. Full ID loses to a stale former number | Exact lookup uses the complete verified alias plus sequence. Another site's former number with a different sequence no longer defeats it. Two sites owning the same full alias still both go to review, even if locality favors one. |
| 4. Safety ignores uniquely agreeing city | Shared-number safety accepts uniquely agreeing city evidence consistently with candidate selection. Same-city ambiguity and another site's exact address remain protected. |
| 5. Missing overrides silent | Bootstrap absence appears in logs, summary and run-record problems. If the prior publication recorded a file, disappearance blocks sync before acquisition, preserving the previous pointer. |
| 6. Current-number alias marked unknown | Diagnostic IDs now include register, current and former numbers, using the same alias set as matching. |
| 7. Residual address aliases | Center/Centre/Ctr works as a standalone street-name component before a suffix; BLDG-3 equals BLDG 3. Different building IDs and internal ID hyphens stay distinct. North Street remains distinct from N Street. |
| 8. Header-only malformed CSV | Headers are validated independently of row count. Wrong, missing, duplicate and blank headers fail. An intentional empty decision set requires the valid header. |
| 9. UTC offsets rejected | ISO decision timestamps accept Z and explicit offsets, preserving the supplied value. Impossible dates, invalid offsets and zoneless timestamps are rejected with a specific message. |
| 10. Path resolution differs | Default data/override locations use the project root. Explicit relative paths use the working directory through the same configuration parser in preflight and CLI. Invalid preflight configuration uses exit 2 without an uncaught stack trace. |

## Safeguards and intentional behavior

A complete ID still cannot override an explicitly different program year, another
registered owner's exact address, banner/state/scope/status constraints, or a true
collision of full composite aliases. A shared store-only number still needs evidence
distinguishing its building. A street-name bonus alone cannot resolve two buildings
in the same city. These negative controls remain in the regression suite.

Mixed sign scope is not accepted automatically: the reviewer must explain the
permit scope. Bootstrap without an overrides file remains allowed with a visible
warning; later loss of a previously recorded file is fatal. To intentionally withdraw
all decisions, supply a valid header-only file rather than deleting or truncating it.

Explicit relative settings remain relative to the shell's working directory;
only unset defaults are anchored to the project root. Node's env-file argument is
also shell-relative unless absolute. Scheduled deployments should use absolute paths.

## Verification

- Preflight, lint, typecheck, and **528 tests across 31 files** pass.
- Coverage thresholds pass: **94.84% lines, 87.84% branches**.
- Rules .11 replay archive `2026-10-08T20-23-30-750Z` with **324 matched,
  26 review, 50 no-match**. Mapping bytes are identical to the published .10 run;
  no accepted target or output status changes in the current snapshot.
- Exact normalized street hits remain **256**. This is a normalization observation,
  not an accuracy measurement.
- New tests exercise year-range store markers, house numbers, numbered roads,
  mixed-scope overrides, distinct/same composite aliases, unique-city and exact-
  address conflicts, lost-file publication preservation, header validation, offset
  timestamps, and CLI/preflight calls from another working directory.
- Offline replay evidence is in ignored `data/audits/round-7/replay.json`. The live
  pointer remains on the original .10 publication; no fresh sync was performed.

The fixes address reachable edge cases without increasing accepted decisions in
this snapshot. They do not establish independent matching accuracy or a deployed
scheduler; those previously documented validation requirements remain open.
