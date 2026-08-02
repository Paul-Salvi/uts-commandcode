# Memory

## Project Overview

Model delivery tool for boutique SMA/model strategist firms distributing model portfolios to
sponsor platforms (TAMPs), starting with SMArtX.

See @PROJECT.md for the MVP scope (what to actually build first) and @PROJECT_FULL_SCOPE.md for
the long-term target-state architecture (what NOT to build yet).

## Scope Discipline (read this before adding any feature)

This is a solo, part-time (10-20 hr/week) build with no funding. The single biggest risk to this
project is scope creep back toward the full enterprise doc before there are paying customers.

- Default to the MVP scope in @PROJECT.md unless a specific paying customer has asked for
  something beyond it.
- If a task looks like it belongs to Phase 2/3 in @PROJECT_FULL_SCOPE.md (multi-sponsor,
  compliance rule engine, dynamic models, corporate actions, SSO/RBAC, EMEA), stop and confirm
  with me before implementing — don't build it just because it's documented.
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

- Single Postgres database for MVP — no data warehouse, no separate analytics store until
  Phase 2+ demands it (see @PROJECT_FULL_SCOPE.md Section 9.4)
- Delivery is file-generation-only for MVP — no SFTP, SMB, or API integration (including
  SMArtX). A sponsor is just a name + a file-format config. Do not add credential storage or
  a delivery transport layer until Phase 2 (see @PROJECT.md Section 5)
- Every file generation attempt (success or failure) must be logged to `delivery_log` — this is
  the core value proposition of the product, not an optional feature
- Static models only for MVP — dynamic/rule-driven models are explicitly out of scope until
  Phase 2 (see @PROJECT_FULL_SCOPE.md Section 3.3-3.4)

## Common Workflows

Document actual commands here once the project is scaffolded (migrations, running the delivery
job locally, running tests). Placeholder until then:

- `# TODO: add db migration command`
- `# TODO: add local dev server command`
- `# TODO: add test command`
