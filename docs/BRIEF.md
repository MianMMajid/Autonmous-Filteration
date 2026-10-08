# Brief (redacted)

Original: Pulley AI Ops take-home, "SiteLedger Project Matching". Credentials
and the API key are omitted here; they live only in `.env`.

## Context

Pulley's Pro Permitting helps customers pull permits. Strategic customers often
have their own project-tracking system, and Pulley needs to sync data between
that system and Pulley's.

## The request from the Account Lead

> Every Monday someone on my team spends half a day lining up Acme's SiteLedger
> reports with our projects, and we'd love to stop doing that. We'd also like to
> do the matching more often: the data updates a few times a day, but weekly is
> the most often we can do it by hand.
>
> Acme IDs are store.sequence (1556.1002 = store 1556). Sequences get reused all
> over the place, so don't trust one on its own. Warehouse Club has its own
> numbering, so club 4356 and store 4356 are two different buildings.
>
> We name our projects after the jurisdiction we file with, so our city won't
> always match theirs. Street and state are more reliable.
>
> Acme logs every piece of work as its own line (pharmacy, EV, deli...), but if
> it's the same store and same year, we usually file it as one permit, so
> several of their rows can point to one of ours. Signs go the other way: we
> usually open a separate signage project.
>
> You can skip the Pathfinder projects for now. And canceled projects only count
> if they're canceled/closed on both sides.
>
> If not everything matches, my team can check a few a week, but not many!

## Systems

**SiteLedger** (web portal, username/password). Reports available after
sign-in: Project Register (XLS), Site Directory (XLSX), Key Dates (CSV).

**Pulley API** (simulated), `GET /api/pulley/v1/projects` with an `X-API-Key`
header. 100 projects per page, `?cursor=<next_cursor>` for the next page,
`next_cursor` is `null` on the last page. Missing or invalid key returns 401.

| Field | Notes |
|---|---|
| `id` | Opaque, e.g. `prj_7f3k2q`; never encodes Acme IDs |
| `name` | Free text typed by whoever opened the project; shapes vary a lot |
| `organization` | `Acme Market` or `Acme Warehouse Club` |
| `account_plan` | `full_service` or `pathfinder` |
| `status` | `In Progress`, `On Hold`, `Draft`, `Canceled`, `Complete` |
| `project_type` | Acme's vocabulary plus `Signage` |
| `jurisdiction_city`, `state` | Filing jurisdiction and its state |
| `street_address` | Sometimes missing |
| `permit_submitted`, `permit_approved`, `construction_start` | ISO dates or null |
| `created_at` | ISO timestamp |

## Required output

A CSV with exactly these columns in this order:

```
acme_pcroject_id,pulley_project_id,status
1556.1002,prj_7f3k2q,matched
1556.1004,,no_match
2210.1001,,needs_review
```

`status` is one of `matched`, `needs_review`, `no_match`. Note the column name
`acme_pcroject_id` is spelled exactly as the brief specifies.

## Submission

Upload the mapping CSV, plus notes containing an estimated match percentage and
a short message to the Account Lead describing what was built, how to use it, a
status update, and a request to meet for onboarding. If accepted, a live demo
runs the tool on an updated dataset.
