# Pulley audit, round 3

> **Resolved in the working tree: tool 0.1.1, rules 2026-10-08.5.**
> The findings below describe the audited revision, not the fixed code.
> Correctness regressions and related edge cases now live in
> `tests/audit-round-3.test.ts`. The reproduction command below runs those
> regressions instead of asserting the historical defects. The recovery mutex
> now deliberately fails closed if abandoned; see `docs/OPERATIONS.md` for
> safe cleanup. See `CHANGELOG.md` for the implementation changes.

**Revision:** `f1c9c57`, reviewed 2026-10-08 against the Pulley brief and
the current matching/operations contracts.

**Result: 10 reproduced findings — four P1, five P2, one P3.**
Several are new failure modes in areas repaired after round two; others
are previously unexamined acquisition and transport defects. They are not
a restatement of the previous ten examples.

Production-readiness judgment remains **5/10 for unattended publication**.
There are real improvements, including the final invariant check, safer
handling of conflicting anchors, credential-free status, and retention of
replayed source archives. However, source identity conflicts still permit
wrong automatic matches, stale recovery still has a mutual-exclusion
failure, and authenticated redirects cross an unvalidated trust boundary.
The rating is an engineering judgment, not a measured accuracy score.

## Verification and limits

- Existing tests: **251 passed, 22 files**, including the round-two regression
  cases. Lint and type checking pass.
- An isolated fixture run still produces **332 matched, 18 needs_review,
  50 no_match**. This is coverage, not a precision measurement.
- All ten findings are reproduced by
  [`audit-round-3/reproduce.mjs`](audit-round-3/reproduce.mjs).
- The probes exercise real matching, normalization, override and invariant
  functions; filesystem lock behavior; the full archive/publication/replay
  pipeline; and actual Node HTTP redirect behavior.
- No application code, live upstream system, `.env`, or operational data was
  modified. The only HTTP servers contacted were two temporary loopback
  servers using a synthetic API key. Other upstream exchanges were mocked.
- Lock timeout advancement and HTTP waiting use controlled test seams; the
  report explicitly identifies those conditions. These tests establish
  reachable failures, not their frequency in production.

```sh
node docs/audit-round-3/reproduce.mjs
```

At audit time the script asserted the observed **defective** behavior.
After repair it was converted into an entry point for correctness regressions;
a successful exit now means those regressions pass. Temporary directories
and local servers are cleaned up, and Git history is no longer required.

Priority meanings: P1 should be resolved before unattended production; P2
is a substantive correctness/reliability defect; P3 is a lower-impact
traceability defect. Preconditions below are part of each severity judgment.

## R3-01 — P1: a known site-join mismatch becomes authority to match the wrong store

**Locations:** `src/domain/normalize/build.ts:165`,
`src/domain/normalize/build.ts:175`; `acmeStoreNumbers` in
`src/domain/match/compat.ts`.

Normalization recognizes when an Acme project's store number matches neither
the joined site's current nor former location number. It increments a warning
counter but does not mark the project disputed. `acmeStoreNumbers` then adds
the joined site's location number to the project's matching identities.

**Reproduction:** project `1556.1002` references Site ID `ST-9999`, whose
location number is 9999 and whose former number is null. The only Pulley
candidate is `#9999 Remodel 2027`. The project is confidently `matched` to
that permit. `identityDisputed` remains null, publication invariants pass,
and the input-count quality gate has no blockers.

**Impact:** an inconsistent join can produce a wrong-building mapping. The
tool already knows the source identity is contradictory but treats the
contradicting number as additional matching evidence. An aggregate warning
does not make the accepted row a review task.

**Required repair:** treat a current/former-number mismatch as disputed
identity, and do not expand trusted identity from that join. Require review
or an explicit correction before automatic matching. Keep a positive test
for legitimate renumbering through the recorded former number.

## R3-02 — P1: conflicting Pulley duplicates silently use the first lifecycle

**Location:** `src/sources/pulley/client.ts:40`.

`dedupeProjects` tracks only project IDs. It does not distinguish an identical
repeat from a second record with changed status, organization, plan, or
address. The first record wins in both live acquisition and replay.

**Reproduction:** two records for the same Pulley ID differ only in status:
`In Progress` and `Canceled`. For an active Acme project, live-first order
produces `matched`; canceled-first order produces `needs_review /
STATUS_CONFLICT`. Both outputs pass publication invariants because the
contradicting Pulley record has already been discarded.

**Precondition:** duplicate IDs with different content arrive, for example
while a paginated source changes during collection. The code already
explicitly supports duplicate IDs across pages, so the missing distinction
between identical and conflicting duplicates matters.

**Impact:** cancellation eligibility and other identity rules depend on page
order. Matching live and replay behavior to each other does not make this
first-record policy correct.

**Required repair:** collapse identical repeats, but quarantine conflicting
versions or reacquire a consistent authoritative record. Preserve the
conflicting fields and affected rows for review. Test status, organization,
and account-plan conflicts in both orders.

## R3-03 — P1: the reclaim mutex can expire while a live reclaimer still owns it

**Locations:** `src/run/lock.ts:90`, `src/run/lock.ts:113`.

The new reclaim mutex fixes the original stale-read interleaving while its
ownership remains intact. However, another contender deletes the mutex
solely because its modification time is more than 60 seconds old. The
original holder can then resume and execute its previously authorized
removal of the main lock. There is no ownership/fencing check preventing it.

**Reproduced schedule:**

1. A obtains the reclaim mutex and reads the stale main-lock owner.
2. A pauses during that owner's liveness check.
3. The mutex age exceeds 60 seconds. B deletes it, reclaims the main lock,
   and becomes the new live owner.
4. A resumes, deletes B's main lock, and acquires ownership itself.
5. Both callers have successfully acquired the lock; B has not released it.

The probe uses a worker and the public liveness callback, then advances the
mutex mtime by 61 seconds instead of waiting. It observes owner 2002 replaced
by owner 2001 while both acquisition calls have succeeded. The filesystem
operations are real; the PID identifiers and scheduling are controlled.

**Precondition:** a reclaimer is suspended or delayed past the mutex timeout.
Age alone does not prove process death. This is a different interleaving from
the round-two test, which pauses before acquiring the reclaim mutex.

**Impact:** concurrent syncs can publish and prune without mutual exclusion.

**Required repair:** use an ownership-safe recovery protocol that also covers
the recovery mutex. An expired holder must be unable to mutate the protected
resource after ownership changes. Do not rely on a longer timeout as proof
of exclusivity. Retain this deterministic suspension/resumption regression.

## R3-04 — P1: an authenticated redirect forwards the API key to another origin

**Locations:** `src/sources/http.ts:113`; authenticated request construction
in `src/sources/pulley/client.ts`.

The HTTP wrapper uses the default redirect behavior and does not validate
redirect destinations. Pulley authentication uses the custom `X-API-Key`
header. Actual Node fetch forwards that header across a cross-origin redirect.

**Reproduction:** local server A, configured as the Pulley base URL, responds
with HTTP 302 to local server B on a different port. B receives the complete
synthetic API key. The client accepts B's valid-shaped project response.
This test uses the actual HTTP stack, not a mocked fetch.

**Precondition:** the authenticated endpoint returns a cross-origin redirect,
whether due to routing misconfiguration, an unintended redirect, or malicious
behavior. This audit does not claim such a redirect exists on the real
service or that an attacker can trigger one there.

**Impact:** credentials leave the configured API origin before any input
quality or publication check can intervene. Generic assumptions about
special handling of `Authorization` do not protect this custom header.

**Required repair:** reject redirects for authenticated API requests unless
explicitly needed. If redirects are required, validate each destination
before sending credentials and prohibit unapproved origin changes and
transport downgrades. Test with two separate origins and a synthetic key.

## R3-05 — P2: a saved override on a newly disputed row aborts the entire sync

**Locations:** `src/run/overrides.ts:325`, `src/run/invariants.ts:77`.

The matcher correctly holds `identityDisputed` rows for review. Override
reconfirmation checks scope, temporal compatibility, and lifecycle, but
does not check that dispute. It accepts the saved match, after which the
publication invariant rejects it.

**Reproduction:** an Acme row with a conflicting-register identity dispute
has a compatible exact-ID Pulley target and a saved matched override. The
matcher returns `needs_review`. `applyOverrides` reports one applied override
and zero problems, changing the row to `matched`. The final invariant throws
`InvariantError`, exit **10**.

**Impact:** the new invariant successfully prevents an unsafe mapping, but
one ordinary source conflict plus a previously saved decision prevents
publication for every project. This should be a reconfirmation task, like
other stale overrides, rather than an internally generated invariant failure.

**Required repair:** reject or hold the disputed matched override before
publication validation, preserve the review decision, and give an actionable
reconfirmation message. Verify both newly recorded and previously valid
overrides after source identity changes.

## R3-06 — P2: disputed register rows still disappear from review depending on order

**Location:** `src/domain/match/matcher.ts:267`.

The dispute guard changes only decisions that would otherwise be `matched`.
If the retained first source row produces `no_match`, it returns immediately,
even though another conflicting version supports a candidate.

**Reproduction:** provide duplicate `1556.1002` register rows that differ in
program year, 2027 versus 2028, and a store-only Pulley project named
`#1556 Remodel 2027`. With 2027 first, the result is `needs_review /
IDENTITY_DISPUTED`. Reverse the same facts: it is `no_match / UNRELATED_ONLY`.
Both results pass final publication validation.

**Impact:** source ordering still decides whether a human sees the disputed
case in `review.csv`. The round-two Active/Closed regression no longer
auto-matches, but it does not prove the claimed order-independent review
behavior for other conflicting fields.

**Required repair:** unresolved source identity disputes should produce an
explicit review decision regardless of the provisional decision from the
first row. Preserve evidence from conflicting variants, and test program
year, site, type, and lifecycle permutations.

## R3-07 — P2: override conflict resolution stops before reaching consistency

**Location:** `src/run/overrides.ts:257`.

Withdrawing one override restores an automatic mapping that can conflict
with another override. The code correctly recognizes this dependency, but
limits propagation to ten passes instead of a bound derived from the number
of overrides or continuing until no changes remain.

**Reproduction:** create 13 independently matched projects A0 through A12.
Give each of A0 through A11 an override to the next project's permit. A12
keeps its automatic match. Resolving the last conflict creates the preceding
one, and so on. The function withdraws ten overrides, leaves two applied,
and returns an inconsistent assignment. Publication then fails with exit 10.

**Impact:** a supported batch of saved decisions can block the whole run even
though the documented withdrawal policy has a consistent outcome: restore
all original automatic assignments. This requires only twelve overrides,
not a large-scale stress input.

**Required repair:** continue while there is progress, bounded by the count
of still-applicable overrides, or use a dependency work queue. Test chains
longer than ten and ensure the postcondition is consistency on return.

## R3-08 — P2: downloaded filenames can overwrite other archive inputs

**Locations:** `src/run/archive.ts:88`, `src/run/acquire.ts`'s concurrent
archive writes; `filenameFrom` in `src/sources/siteledger/client.ts`.

Archive paths are derived from upstream download filenames, without a unique
report-kind namespace or exclusive file creation. Separate reports can
therefore share the same path, while the manifest records different hashes
for that path.

**End-to-end reproduction:** all three valid fixture reports arrive with
`Content-Disposition: attachment; filename="export.bin"`. The live run
successfully publishes 332 matches because parsing uses the original bytes
in memory. The archive manifest contains three `export.bin` entries. A replay
immediately fails hash verification because the files overwrote one another.

**Impact:** a successful run can create an unreplayable archive without
external tampering. The later error misleadingly describes an altered archive.
This also applies to collisions with reserved archive filenames.

**Required repair:** assign unique internal paths from report identity/page
number, retain the original download filename as metadata, and reject any
duplicate or reserved output path. Test identical and sanitization-colliding
download names across report types.

## R3-09 — P2: the retry policy retries before Retry-After permits recovery

**Location:** `src/sources/http.ts:140`.

The ten-second exponential-backoff cap is also applied to an explicit
`Retry-After` value. A longer server-requested delay is shortened instead
of respected or reported as exceeding the client's waiting budget.

**Reproduction:** a synthetic service responds with HTTP 429 and
`Retry-After: 120` until 120 seconds have elapsed. With the default three
retries and an injected virtual clock, observed waits are **10, 10, 10
seconds**. All four attempts occur before the service recovers, and the
client throws `NetworkError` after only 30 seconds of waiting.

**Impact:** recoverable rate limits cause avoidable sync failures and repeated
requests during the requested cooldown. The same error affects date-valued
Retry-After headers whose calculated delay exceeds the cap.

**Required repair:** separate the jittered-backoff ceiling from an explicit
server cooldown. Honor that cooldown when within the total request budget;
otherwise fail/defer explicitly rather than retrying prematurely. Test both
seconds and date forms above the default cap.

## R3-10 — P3: materially different matching rules share the same provenance version

**Location:** `src/domain/match/matcher.ts:57`; `package.json`.

Both `0b7e1e5` and `f1c9c57` identify their rules as **2026-10-08.4** and tool
as **0.1.0**, although the intervening commit changes acceptance selection,
scope rules, disputed identity handling, assignment anchors, and overrides.
`run.json` does not record the source commit.

**Reproduction:** the probe compares the two revisions' declared versions
and confirms that the acceptance algorithm changed from ties against the
display leader to ties against the maximum decisive score. The round-two
score example is specifically a behavior change under that same rules ID.

**Impact:** historical results cannot be attributed to one matching algorithm
using the recorded rule/tool versions. Replaying under the allegedly same
version can change a decision. This is a traceability defect, not a claim
that replay intentionally executes old code; replay uses current code.

**Required repair:** bump the rules version for this behavioral release, as
AGENTS.md requires. Record an immutable implementation revision/build digest
as well, and automate a check that rule changes update their provenance.

## What the previous fixes accomplished

The current suite includes successful regressions for the previous exact
examples: conflicting strong anchors are demoted; the original lock
interleaving is refused; status can run without credentials; the tested
identity disputes no longer auto-match; temporal overrides are rejected;
decisive-score selection is corrected; unknown banners are excluded; retained
replay outputs protect their archives; collision indexes are scoped.

Those improvements matter. R3-03 and R3-06 demonstrate adjacent cases the
new tests do not cover, rather than proving the original examples still fail.
The final invariant check also limits the harm from R3-05 and R3-07: they
stop publication rather than publishing the invalid result.

## Recommended release gates

1. Make contradictory join identities and conflicting upstream duplicates
   explicit review conditions before evidence is used for matching.
2. Establish a lock protocol that remains safe after suspension/recovery,
   and restrict authenticated redirects to approved destinations.
3. Make override validation produce a consistent result for every supported
   batch, and preserve disputed rows in the review queue regardless of order.
4. Guarantee collision-free archive paths, respect server cooldowns, and
   record a unique implementation identity in provenance.
5. Convert these probes into correctness regressions and rerun the complete
   suite. Then validate automatic-match precision and review workload on an
   independently adjudicated, held-out dataset. Passing unit tests and 83%
   auto-match coverage still do not establish production accuracy.

No application fixes are included. This report and its reproduction script
are the audit deliverables; previous reports remain historical records.
