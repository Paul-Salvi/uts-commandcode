# API Consolidation — Performance Impact Notes

**Date:** 2026-08-05
**Scope:** Reduce frontend round-trips by adding aggregate backend endpoints, matching existing UTS patterns (Controller → Service → Repository → EF Core/Postgres).

## Pagination pass (2026-08-05)

**Evaluation before paginating list endpoints:**
- **Payload cost** — list endpoints today return full collections (DeliveryRequests, DeliveryRuns, events, securities, sponsors). As rows grow (every delivery run appends entries + logs), the payload and DB transfer grow linearly. Pagination bounds each response.
- **DB query cost** — all list queries filter on user-owned/FK columns and map to `LIMIT`/`OFFSET` via EF `Skip`/`Take`. No schema change needed; no N+1 introduced.
- **Contract** — reuse the existing `PagedResultDto<T>` (`Records`, `TotalCount`, `Page`, `PageSize`) already used by `Models/search`, and the frontend's existing paginated-action pattern.

**Endpoints paginated in this pass:**
- `GET /api/Sponsors/overview` → `PagedResultDto<SponsorOverviewDto>`
- `GET /api/DeliveryRequests` → `PagedResultDto<DeliveryRequestItemDto>`
- `GET /api/DeliveryRequests/pending` → `PagedResultDto<DeliveryRequestItemDto>`
- `GET /api/DeliveryRuns` → `PagedResultDto<DeliveryRunDto>`
- `GET /api/DeliveryRuns/{id}/events` → `PagedResultDto<RunEventDto>`
- `GET /api/Securities` + `GET /api/Securities/search` → `PagedResultDto<SecurityDto>`

All paginated endpoints accept `page` (default 1) and `pageSize` (default 50, clamped 1–100), and return the shared `PagedResultDto<T>` contract. Frontend consumers were updated to unwrap `.records`; `listSecurities` now fetches pageSize=100 and a `getSecurityCount()` helper was added for the models/import count displays.

**Not paginated (single-entity / bounded / already-aggregated):** detail GETs, `Sponsors/{id}/detail`, `FileFormatConfigs`, `DeliverySchedules`, `FileDeliveries/status`, `dashboard/summary`, `Models/search` (already paginated), `pending/count`.

**Database:** no redesign needed. All list queries filter on user-owned/FK columns and use EF `Skip`/`Take` → SQL `LIMIT`/`OFFSET`. Only future index candidates if volume grows: `DeliveryRequests (UserId, Status, CreatedAt)` and `DeliveryLogs (SponsorModelId, RequestedAt DESC)`.

## Delivery Runs date + status filter (2026-08-05)

`GET /api/DeliveryRuns` now accepts `from`, `to` (inclusive date range on `CreatedAt`, end-of-day inclusive), and `status` query params, threaded through service → repository → EF WHERE. The runs page gained a filter bar (from/to date pickers + status dropdown) and Prev/Next pagination (pageSize 25).

- **DB cost:** filters push to SQL (`CreatedAt >= from`, `CreatedAt < to+1d`, `Status = status`) before count + skip/take — no N+1, no client-side filtering.
- **Index candidate:** if run volume grows, add composite index `DeliveryRuns (UserId, CreatedAt DESC)` so the date-range + user filter stays an index seek.

## Configurable pagination (2026-08-05)

Page settings are no longer hardcoded literals. A `PaginationOptions` class (`UTS.Core.Application`) binds to the `Pagination` config section (`DefaultPage`, `DefaultPageSize`, `MaxPageSize`) with DataAnnotations validation. Repositories that paginate inject `IOptions<PaginationOptions>` and resolve: `page`/`pageSize` of 0 → configured default; `pageSize` clamped to `MaxPageSize`. Controllers default both query params to 0 (use-default).

- **appsettings.json:** `Pagination: { DefaultPage: 1, DefaultPageSize: 50, MaxPageSize: 100 }`
- **docker-compose.yml:** env-tunable via `Pagination__DefaultPageSize=${PAGINATION_DEFAULT_PAGE_SIZE:-50}` and `Pagination__MaxPageSize=${PAGINATION_MAX_PAGE_SIZE:-100}` (host env vars `PAGINATION_DEFAULT_PAGE_SIZE` / `PAGINATION_MAX_PAGE_SIZE`).
- Frontend passes an explicit `pageSize` only where a screen needs a different size (e.g. dashboard recent-runs = 5); otherwise it omits it and the backend default applies.

## Evaluation before any API was created/integrated

Each endpoint was evaluated on:
1. **Round-trip reduction** — how many HTTP calls collapse into one (each is a TLS + JWT + network hop).
2. **Payload cost** — is the combined payload smaller, equal, or larger than the sum of parts?
3. **DB query cost** — does the aggregate add N+1 DB queries, or stay O(1) with joins/group-bys?
4. **Caching/revalidation** — does it play well with `revalidatePath` and `cache: no-store`?
5. **Sequential-by-design check** — is there a user step (confirm, download, navigate) that must stay separate?

## Endpoint-by-endpoint evaluation

### 1. `GET /api/Sponsors/overview` (N+1 fix — HIGH IMPACT) ✅ implemented
- **Before:** `listSponsors()` + per-sponsor `getFileFormatConfig(id)` + `listSponsorModels(id)` = **1 + 2N** round trips (21 calls for 10 sponsors).
- **After:** 1 round trip. Detail popup fetches full config lazily on row select (1 call, not 2N).
- **Payload:** each row carries sponsor + fileType + mappedModelCount. Smaller than the sum.
- **DB cost:** one query (sponsors + config left join) + one grouped count query. No N+1.

### 2. `GET /api/Sponsors/{id}/detail` (MEDIUM IMPACT) ✅ implemented
- **Before:** 3 parallel calls (sponsor, config, markings).
- **After:** 1 call.
- **DB cost:** one Include query + one markings query. No N+1.

### 3. `GET /api/Models/dashboard/summary` (MEDIUM IMPACT) ✅ implemented
- **Before:** `listModelsWithPositions()` (heavy — every model + every position) + `listSecurities()`.
- **After:** 1 lightweight call returning the 4 counts.
- **DB cost:** 2 aggregate COUNT queries + one grouped SUM — far cheaper than materializing all positions.

### 4. `GET /api/FileDeliveries/status` + pending count (LOW IMPACT) ✅ implemented
- **Before:** 2 calls on the deliveries page.
- **After:** 1 call (status endpoint returns `pendingRequestCount` too).
- **DB cost:** the status query already ran; pending count is one extra scalar query.

## What was NOT combined (sequential-by-design)
- `validateImport` → `uploadImport` — separate user confirmation steps.
- `markDownloaded` → `download` — JSON ack vs file-stream route.
- `initiateDelivery` → `getRunDetail` — navigate-then-fetch.
- `searchModels` → `getModelDrift` — user-driven navigation.

## Additional cleanup (no new API)
- ✅ **Deduped three duplicate `searchModels` wrappers** — import/actions.ts is now the single canonical action; sponsors ModelMapping and model-drift client import it.
- Remaining opportunity: add React `cache()` around read-heavy actions (securities, sponsors, runs) so identical in-render calls dedupe (Next.js server dedup).
- `authFetch` uses `cache: "no-store"` — keep for freshness on status/delivery data.

## Verification
- `dotnet build UTS.slnx` — clean, 0 warnings.
- `dotnet test UTS.Test.Unit` — 190 passed.
- `tsc --noEmit`, `eslint src`, `npm run build` — all clean.
