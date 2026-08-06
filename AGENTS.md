# Memory

## Project Overview

Model delivery tool for boutique SMA/model strategist firms distributing model portfolios to
sponsor platforms (TAMPs), starting with SMArtX.

See `docs/ARCHITECTURE.md` for the current implemented system (what is built and code-verified)
and `docs/PROJECT.md` for the target-state platform architecture (what NOT to build yet — the
next-gen platform is a future reference, not the MVP).

## Scope Discipline (read this before adding any feature)

This is a solo, part-time (10-20 hr/week) build with no funding. The single biggest risk to this
project is scope creep back toward the full enterprise doc before there are paying customers.

- Default to the smallest working version of any feature that matches the current implementation
  in `docs/ARCHITECTURE.md` unless a specific paying customer has asked for something beyond it.
- If a task belongs to the target-state `docs/PROJECT.md` (delivery runs, tracker state machine,
  compliance rule engine, event store, dead letters, RBAC, EMEA, CRD adapters, corporate actions),
  stop and confirm with me before implementing — don't build it just because it's documented.
- Prefer the smallest working version of any feature over the "correct" enterprise version.

## Code Style Guidelines

- Use descriptive variable and function names — this is finance-adjacent data, ambiguity here
  causes real bugs (e.g. `targetWeight` not `tw`, `sponsorConnectionId` not `scid`)
- Validate all uploaded model data (CSV/Excel) at ingestion, not downstream — fail fast with a
  specific, human-readable error naming the row and field
- No hardcoded business thresholds (tolerances, limits, retry counts) — these belong in
  configuration, not code, even at MVP scale, since they're the first thing a real customer will
  ask to change
- Never log API credentials or full request/response payloads containing sponsor credentials in
  plaintext — mask before logging
- Follow existing patterns in the codebase before introducing a new one

## Architecture Notes

- Single Postgres database for MVP — no data warehouse, no separate analytics store until the
  target state (see `docs/PROJECT.md`) demands it.
- Delivery is file-generation-only for MVP — no SFTP, SMB, or API integration (including
  SMArtX). A sponsor is just a name + a file-format config. Do not add credential storage or
  a delivery transport layer until a paying customer asks for it.
- Every file generation attempt (success or failure) must be logged to `delivery_log` — this is
  the core value proposition of the product, not an optional feature
- Static models only for MVP — dynamic/rule-driven models are explicitly out of scope until
  the target state (see `docs/PROJECT.md`)

## Performance Discipline (read before adding any API)

Before creating or integrating any API (new endpoint, server action, or frontend fetch), evaluate
the performance impact first and record the analysis in `docs/API-CONSOLIDATION-NOTES.md`:

- **Round-trip count** — how many HTTP calls does this add or remove? Each call is a TLS + JWT +
  network hop. If a page is fanning out per-row (N+1 pattern, e.g. one request per sponsor per
  config), prefer an aggregate endpoint (Controller → Service → Repository with a join or grouped
  query) that returns everything in one payload.
- **Payload cost** — is the response smaller, equal, or larger than what the page actually renders?
  Don't ship full detail (e.g. every position) to a surface that only needs counts.
- **DB query cost** — does the aggregate stay O(1) (joins, group-bys, COUNTs) or does it introduce
  N+1 DB queries? Push aggregation to SQL; compute business-derived fields (e.g. weight validity)
  in the service layer.
- **Sequential-by-design check** — don't merge calls that a user flow must keep separate (validate
  then confirm-then-upload, JSON ack vs file download, navigate-then-fetch).
- **Dedup** — reuse existing actions instead of duplicating wrappers (there is exactly one canonical
  `searchModels` in `import/actions.ts`); consider React `cache()` for read-heavy actions.

Every new API change must update `docs/API-CONSOLIDATION-NOTES.md` with the before/after call
counts and DB cost before the code is written.

## Pagination Configuration (read before adding any list endpoint)

- Every list/query endpoint must be paginated using the shared `PagedResultDto<T>` contract
  (`Records`, `TotalCount`, `Page`, `PageSize`).
- Page size is **not** hardcoded in controllers or repositories. It comes from the `Pagination`
  config section (`PaginationOptions` in `UTS.Core.Application`): `DefaultPage`, `DefaultPageSize`,
  `MaxPageSize`.
- Controllers default `page = 0` / `pageSize = 0` — a 0 means "use the configured default".
  The repository resolves the configured default and clamps `pageSize` to `MaxPageSize`. Do not
  reintroduce inline `Math.Clamp(pageSize, 1, 100)` or literal `pageSize = 50` defaults.
- In Docker, the values are env-tunable: `Pagination__DefaultPageSize` /
  `Pagination__MaxPageSize` (docker-compose passes `PAGINATION_DEFAULT_PAGE_SIZE` /
  `PAGINATION_MAX_PAGE_SIZE`).
- The frontend passes an explicit `pageSize` only when a screen genuinely needs a different page
  size (e.g. dashboard recent-runs uses 5); otherwise omit it and let the backend default apply.

## Common Workflows

Document actual commands here once the project is scaffolded (migrations, running the delivery
job locally, running tests). Placeholder until then:

- `# TODO: add db migration command`
- `# TODO: add local dev server command`
- `# TODO: add test command`
