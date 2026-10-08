# Submission notes

## 1. Mapping CSV

`data/out/latest/mapping.csv` from the most recent run (produced by
`pnpm sync`; columns `acme_pcroject_id,pulley_project_id,status`, one row per
Acme project, 400 rows on the 2026-10-08 dataset).

## 2a. Estimated match percentage

**About 81% of Acme projects are correctly matched** to a Pulley project,
and about 94% of all rows carry the right outcome.

Basis, from `docs/VALIDATION.md`: the tool reports 334 of 400 rows as
`matched` (84%). A hand-checked stratified sample across every matching tier
plus a sweep of every matched row with two or more soft concerns puts the
precision of those rows at roughly 96%, so about 320 are right. The 50
`no_match` rows are mostly correct outcomes: 21 have nothing in Pulley that
relates, 24 only relate to another year's permit or another line at the same
store, and 5 are referenced only by pathfinder projects, which the brief
excludes. The 16 `needs_review` rows are real questions (duplicate Pulley
projects with no dates, canceled on one side only, two ids filed under the
wrong banner, two lines competing for one permit across years), not matcher
weakness.

## 2b. Message to the Account Lead

> Hi! Thanks for the detailed notes, they shaped most of this.
>
> I've built a small tool that does the Monday line-up automatically. One
> command, `pnpm sync`, signs in to SiteLedger, pulls the Project Register,
> Site Directory and Key Dates, pulls our projects from the Pulley API, and
> writes the mapping CSV in the format you need. It takes a few seconds, so
> it can run as often as the data changes; I've included a schedule that runs
> it three times a day on weekdays, and it can also be run by hand.
>
> Where things stand on today's data: of Acme's 400 projects, 334 are
> matched to a Pulley project, 50 have no match (mostly projects Pulley hasn't
> opened, or lines that fold into a different year's permit), and 16 need a
> human look. Every row carries a reason, so the review file tells you *why*
> it's asking: the 16 today are things like two Pulley projects for the same
> store and type with no dates, a project that's canceled on our side but
> still active on Acme's, or an Acme id that someone filed under Warehouse
> Club instead of Market. It also lists the 33 matched projects where our
> status and theirs disagree, which I suspect is the list your team actually
> wants on a Monday. My estimate is that around 81% of Acme's projects
> are correctly matched, and about 94% of rows have the right answer overall.
>
> The rules you gave me are all in there: store.sequence is only trusted as a
> whole, Warehouse Club and Market numbers never mix, state and street beat
> city, several Acme lines can point at one of our permits when it's the same
> store and year, signage stays separate, Pathfinder is skipped, and canceled
> only counts when it's canceled or closed on both sides. Two things the data
> taught me that you didn't mention: our project dates track Acme's key dates
> very closely, which turned out to be the best tie-breaker after the id
> itself, and a few stores have been renumbered, which the tool handles
> through the Site Directory's former location number.
>
> To keep the weekly check small, once your team settles a review row they
> can record it in a one-line overrides file and it won't come back.
>
> Could we find 30 minutes this week to get you set up? I'd like to walk
> through the summary it prints, run it live on the current data, and hear
> whether the review reasons make sense to your team before you rely on it.
>
> Thanks again!

## What was built, in one paragraph

A TypeScript command-line tool (Node 26, strict TypeScript 7, 184 tests)
with five parts: acquisition (SiteLedger sign-in and report download, Pulley
API pagination, every byte archived for replay), normalization (a name
parser covering all 116 observed name shapes, a street normalizer, joins
to the Site Directory and Key Dates), a deterministic five-tier matcher with
evidence scoring and stable reason codes, outputs (mapping CSV, review and
audit CSVs, a summary with a diff against the previous run), and operations
(single-run lock, atomic output directories, overrides file, scheduled
workflow). Design decisions and the full matching rules are in `docs/`.
