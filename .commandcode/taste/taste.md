# Taste (Continuously Learned by [CommandCode][cmd])

[cmd]: https://commandcode.ai/

# workflow
- After making code changes, proactively rebuild the Docker image (docker compose build) and deploy it — do not wait for the user to ask whether the image is current. Confidence: 0.85

# workflow
See [workflow/taste.md](workflow/taste.md)
# react-query
- After any mutation (create, cancel, approve, etc.), use `queryClient.invalidateQueries({ queryKey: [...] })` to auto-refresh the affected data instead of `router.refresh()`, so tables and pages reflect changes immediately without requiring a manual page reload. Confidence: 0.85
- When using `invalidateQueries` to refresh a list after a mutation, the list component MUST fetch data via `useQuery` (TanStack Query) — not receive it as a static server prop. Invalidation is a no-op if the query key has no active query in the cache. To make this work, expose the server-side data-fetching logic as a server action (`"use server"` function) that the client passes to `useQuery` as `queryFn`. Confidence: 0.88

# error-handling
- Never suppress or hide errors when data insertion fails; show errors directly to the user without making them "seamless". Confidence: 0.85

# ui
- When building radio-button-style selection lists (e.g., payout options in a form), always render every option as an interactive, clickable element — never use a plain non-interactive `<div>` for a single option. Users need to positively confirm their selection before proceeding; auto-selecting or displaying without interaction leaves them unable to advance. Confidence: 0.80
- User-facing error and status messages should be enriched with practical explanations and a clear call to action — not just a terse/technical statement. Tell the user *what happened in plain terms*, *why it matters* (e.g., "not accepting payments"), and *what to do next* (e.g., "contact your agent"). Include a visual indicator (icon) that draws attention. Confidence: 0.80
- Dropdown/select inputs should default to the first available option (index 0), not an empty/"All" placeholder. The user should never have to manually pick when a logical default exists. Confidence: 0.80
- Use green (emerald-500 or similar) as the highlight/selected color for radio buttons and toggle-style UI elements — not blue/info. This aligns with green-as-positive-affirmation patterns elsewhere in the app (verified badges, completed statuses). Confidence: 0.70
- When a user selects an option in a form (radio button, dropdown, etc.), immediately trigger form validation (`form.trigger()`) so validation feedback appears right away — don't wait for form submission to reveal errors. Confidence: 0.70

# ui
See [ui/taste.md](ui/taste.md)
# sql
- When writing seed data, query the database via psql to fetch existing entity IDs instead of hardcoding fake UUIDs. Confidence: 0.65

# mocks
- Do not use MSW mocks in the UI project; mocks should be removed in favor of real API calls or backend-level mocks. Confidence: 0.70
- Never propose or include mock/fallback data in implementation plans, server.ts files, or any frontend code. All UI data must come from real backend API calls only. If the backend isn't available, the page should show an error/loading state — not mock data. Confidence: 0.85
- In dev/mock environments, prefer the simplest pragmatic fix (e.g., relaxing auth for localhost admin pages) over building separate authenticated endpoints or adding complexity — the mock exists to enable development velocity, not to replicate production security. Confidence: 0.65
- Mock/simulator services should NOT auto-transition payment/order states (e.g., `created` → `completed`) on first status query. Sessions should stay in their current state until the user interacts with the mock checkout page (clicks Complete, Fail, or Cancel). The mock should require explicit human interaction to advance state. Confidence: 0.80

# ui
- When an entity is selected via a search/picker (e.g., platform user in a payout form), always keep the entity's identifying attributes (e.g., platform name) visible as inline badges/tags next to the selected entity name — do not hide or collapse the attribute field once a selection is made. Confidence: 0.80
- Form dialogs that contain multiple fields, search results, or dropdowns should default to `sm:max-w-lg` or wider — not `sm:max-w-md` — to allow horizontal field alignment and prevent cramped layouts. Confidence: 0.70
- Status values in UI should be color-coded: Completed = green, Failed = red, Cancelled = grey/muted, Pending = amber. Confidence: 0.75
- Approve/reject/deny action buttons should only appear in the detail dialog, not as standalone inline buttons in table rows. Confidence: 0.70

# fee-storage
- Store per-transaction fee breakdown as individual nullable columns (feeMode, agencyMarkupPercent, agencyMarkupAmount, providerFeePercent, providerFeeAmount) rather than a single JSON blob column. Confidence: 0.70
- Do not hardcode default fee percentages in code; when no fee config exists for an agency, the fee resolver should return null and fees should be zero. Confidence: 0.75

# provider-config
- Allow fee rules (ruleType, value, currency, effectiveFrom) to be configured inline during provider creation, not added as a separate post-creation step. Confidence: 0.65

# nextjs
- When passing arrays of objects to Next.js server actions, serialize to JSON string (`JSON.stringify`) and parse server-side to avoid `[Object]` serialization corruption. Confidence: 0.70
- Fetch initial data (dropdowns, selectors, form dependencies) server-side in the page component and pass as props to the client component — do not fetch them client-side via `useQuery` on mount, because they won't be ready when the component first renders. Confidence: 0.80
- Prefer server actions over client-side `fetch()` through Next.js rewrites when calling internal backend APIs — server actions call the backend directly via `process.env.API_BASE_URL` and are more reliable because they don't depend on rewrite configuration or Docker networking between the Next.js runtime and the backend. Confidence: 0.75
- When `next.config.ts` reads an environment variable at build time (e.g., `API_BASE_URL` for rewrite targets), setting it as a container runtime `environment:` in docker-compose is insufficient — the variable must be passed as a Docker build arg. Add `ARG VAR_NAME` + `ENV VAR_NAME=$VAR_NAME` in the Dockerfile build stage AND `build.args` in docker-compose.yml. Otherwise the Next.js build silently bakes in the default (usually `localhost`), breaking inter-container networking. Confidence: 0.85
- The project's pinned Next.js version has breaking changes vs. the model's training data — APIs, conventions, and file structure may all differ. Before writing any Next.js code, read the relevant guide bundled in `node_modules/next/dist/docs/` and heed deprecation notices; do not rely on training-data knowledge of Next.js. Confidence: 0.80

# feature-removal
- When removing a feature that spans multiple projects (backend, frontend, mocks, Postman), proactively grep for ALL references to the deleted types across ALL layers — domain entities, service interfaces/DTOs/mappers/validators, persistence (EF entities, repositories, DI registrations, DbContext), API controllers, frontend features/routes/public pages, proxy/middleware route gates, sidebar navigation, audit log filter options, commission/analytics queries that reference the deleted feature, Postman collection endpoints/variables, **and project documentation (README, AGENTS.md, etc.)**. A thorough deletion leaves no dangling imports, broken builds, stale UI references, or outdated docs. Confidence: 0.88
- When deleting an entire feature folder from the frontend, check if other features import shared utility files from that folder (e.g., a `resolvePayInPage.ts` used by a different page). Re-create the shared utility in the surviving feature's folder rather than deleting it with the removed feature — or the build will break. Confidence: 0.80
- During/after large refactor passes, proactively delete stale and unused code — empty scaffolding projects, unreferenced domain entities, unused package references — rather than leaving them in place. The user explicitly asks for dead-code removal ("also delete stale and unused"), consistent with MVP scope discipline against keeping speculative enterprise scaffolding. Confidence: 0.70

# data-integrity
- When a user reports that a dashboard total or summary value "is incorrect", first check the raw data in the database (via psql query) to determine whether the issue is stale/corrupted test data or a genuine code bug — do not assume the code is wrong without verifying what's actually persisted. Confidence: 0.80
- When stale test records (left over from earlier buggy runs) are identified as the cause of incorrect dashboard totals, clean them up by running a direct SQL DELETE against the database — do not attempt to fix the symptom by changing code or adding filters. The correct code was already working; the data was the problem. Confidence: 0.80

# debugging
- When a computed/persisted value is unexpectedly 0 (or wrong) despite correct-looking code, trace ALL layers systematically before concluding the root cause: (1) business logic calculation, (2) repository/ORM persistence code (EF Core identity map / tracked-entity overwrites from multiple UpdateAsync calls), (3) Docker build freshness, (4) DB column defaults vs NULL semantics, (5) any clamping/min/max business rules that might zero out a valid value. Compound bugs with failures in multiple independent layers are common and need all layers fixed, not just one. Confidence: 0.85
- When diagnosing a 500 or stale-behavior bug in a Docker-deployed service, check the error's timestamp against the container's last restart/build time to determine if the error is from the old binary or the current deployment — do not assume a newly-restarted container still has the bug just because an error log exists in the output. Confidence: 0.80
- When a code fix doesn't seem to take effect in a Docker-deployed service, verify the compiled binary inside the running container (e.g., `docker exec <container> strings <dll> | grep <methodName>`) to confirm the fix was actually compiled in — do not trust build output or `docker compose up --build` alone to guarantee freshness. Confidence: 0.80
- When tracing why a variable holds an unexpected value despite passing partial correctness tests, inject a debug log statement (e.g., `Console.Error.WriteLine`) at the exact computation and persistence points, rebuild, and capture runtime values — this is faster than iterating on code analysis alone. Clean up debug logs after diagnosis. Confidence: 0.80
- When fixing a business logic bug (e.g., fee clamping against min/max values) found in one service/controller, proactively grep for the same code pattern in sibling services (e.g., pay-in vs payout fee calculation) and apply the same fix — the same domain issue likely exists wherever the pattern was replicated by convention. Confidence: 0.85

# ef-migrations
- When `dotnet ef migrations add` cannot run (e.g., design-time DbContext creation fails due to missing DI registrations or adapter config), write the migration class manually and update `AppDbContextModelSnapshot.cs` directly by removing the dropped entity blocks — do not leave the snapshot referencing deleted entities. Confidence: 0.80
- When `dotnet ef database update` cannot run (container has no SDK, design-time DI resolution fails, etc.), fall back to applying migrations as raw DDL SQL (`ALTER TABLE … ADD COLUMN IF NOT EXISTS`, etc.) directly against the database via `psql`, and manually insert corresponding entries into `__EFMigrationsHistory` so the app's startup `MigrateAsync()` call doesn't attempt to re-apply them. Confidence: 0.75
- When deleting entity classes from the codebase, proactively update `AppDbContextModelSnapshot.cs` to remove the snapshot's entity configuration blocks for those entities — the user will notice if the migration/snapshot still references deleted types, even if the code compiles. Confidence: 0.75
- After writing migration code, do not assume it was applied just because the app startup calls `MigrateAsync()`. Verify empirically by checking the actual running database — query table count, `__EFMigrationsHistory` entries, or table schemas — not just code analysis of migration files. Stale Docker layers or failed startup migrations can leave the DB out of sync with the code. Confidence: 0.80

# verification
See [verification/taste.md](verification/taste.md)

# status-gates
- When implementing a status-based access gate (e.g., blocking login for a suspended/pending agency), proactively handle ALL non-approving status values — not just the specific status the user mentioned. Each status should have its own distinct, user-facing error message that explains what's happening and what to do next. The user expects the gate to be comprehensive across all states that should block access, not a narrow check that misses related states. Confidence: 0.75
# docker
See [docker/taste.md](docker/taste.md)
# notifications
- Notification messages must be enriched with real contextual names and amounts — never generic status strings like "Pay-in completed". Include payer names, employee names, agent names, and agency names depending on context and role. Different roles should see role-appropriate context (e.g., admin sees agency name + agent name, employees see their own name). Confidence: 0.85

# security
- For public-facing payment/checkout pages that handle money, proactively implement layered security without being asked: short-lived session tokens (30-min TTL with countdown display), idempotency keys to prevent double-charge, per-endpoint rate limiting (stricter limits on mutation endpoints like payment start), origin/referer header validation, signed input tokens, HSTS/CSP/X-Frame-Options headers, and webhook signature verification for provider callbacks. Treat these as defaults, not negotiable features. Confidence: 0.85
- Origin/referer header validation should be permissive when headers are absent: only reject requests where the Origin or Referer header IS present but doesn't match the allowed origins. Server-to-server calls (Next.js server actions, cURL, mobile SDKs, webhook clients) do not send browser origin headers and must be allowed through. A validation that rejects requests with no origin/referer header will silently break all server-side consumers. Confidence: 0.85
- When real credentials are found committed to git (e.g., a DB password in appsettings.json), treat it as a blocking issue: scrub the values to placeholders pointing at env vars/user-secrets so the code is safe going forward. Do NOT purge git history or rotate the secret autonomously — flag rotation and history cleanup as the user's decision. Confidence: 0.65

# implementation-pattern
- When the user selects named sections from a categorized plan (e.g., "Modern checkout UX" and "Trust signals"), implement ALL items within those sections in one cross-layer pass (frontend + backend) — do not ask for further step-by-step approval on individual sub-items within a named section the user already endorsed. Confidence: 0.85
- When adding a new field to a backend DTO/record that is displayed in frontend UI, propagate it through ALL layers in the same coordinated pass: backend DTO definition → frontend TypeScript type → frontend response parser/extractor → UI component display → adjust CSS layout (grid columns, spacing, width) to accommodate the new element. Do not land a backend change and leave the frontend parsing it as an opaque blob or breaking layout. Confidence: 0.80
- When implementing checkout/payment flow UI improvements, apply both layers in parallel: backend changes (security, API, DTOs) and frontend changes (components, actions, pages) in the same pass — the user expects a coordinated ship, not separate frontend/backend phases. Confidence: 0.80
- When a brainstorm plan identifies "quick wins" (low-effort, high-impact items), implement them immediately alongside the primary feature work, not deferred to a separate follow-up task. Quick wins include: passing callback URLs to providers, adding idempotency keys, origin validation, stricter rate limiting, trust indicators, countdown timers, replacing insecure storage (sessionStorage), progress indicators, success animations, skeleton loading, and security headers middleware. Confidence: 0.80

# webhooks
- When implementing a webhook endpoint for an external payment provider, include: a webhook signature verification method on the provider interface (HMAC-SHA256 with `CryptographicOperations.FixedTimeEquals` for constant-time comparison), a `GetByExternalPaymentIdAsync` repository method (or equivalent) to look up the local record by the provider's payment ID, signature verification in the webhook handler that skips validation only when no secret is configured (dev mode), and automatic settlement/follow-on logic triggered on completion status within the webhook handler itself. Confidence: 0.85

# dto-evolution
- When extending a public-facing DTO to include a resolved reference (e.g., business name from the agency entity), add an optional string parameter to the existing `ToPublicDto()` extension method (defaulting to `""`) rather than creating a new DTO type. Resolve the reference in the service layer via the appropriate repository and pass it to the mapper — keep the mapping logic a simple data-passing function. Confidence: 0.80

# security-middleware
- Security headers middleware (HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, CSP) should be implemented as a dedicated middleware class in a `Middlewares/` folder, registered early in the pipeline right after `UseHttpsRedirection()`. Include HSTS with `max-age=31536000; includeSubDomains; preload`, frame-ancestors 'none', and suppress server headers. Confidence: 0.85

# rate-limiting
- For ASP.NET Core rate limiting with public-facing payment endpoints, use named policies: "Default" (100/min/IP) for general endpoints, "Strict" (5/min/IP) for payment creation/mutation endpoints, and "Moderate" (10/min/IP) for status-checking endpoints. Apply via `[EnableRateLimiting("PolicyName")]` attribute on individual controller actions, with a class-level `[EnableRateLimiting("Default")]` as the base. Confidence: 0.85

# api-integration
- When comparing string status/enum values returned from a backend API against expected values in frontend code, always normalize both sides to lowercase (`.toLowerCase()`) before comparing. Backend casing (e.g., `"Completed"`) can differ from frontend expectations (`"completed"`), causing silent comparison failures on check-status or polling flows. Confidence: 0.75

# api-pagination
- Paginated list endpoints should accept `page`, `pageSize`, `status`, `search` query params and return `{ records, totalCount, page, pageSize }`. Apply server-side filtering (by status, search text) in the repository layer via LINQ `Where` clauses before applying skip/take pagination — do not fetch all rows from the database just to paginate on the client. Confidence: 0.80

# api-routing
- When adding new ASP.NET Core API route templates, match the casing convention of existing controllers in the project — if existing routes use PascalCase (e.g., `api/PlatformUsers/...`), new controllers should use PascalCase too, not kebab-case (`api/platform-users/...`). Don't rely on ASP.NET Core's default case-insensitive routing; the configuration can make it case-sensitive, causing silent 404s with 0ms response times. Confidence: 0.80
- When resolving the authenticated user's ID from JWT claims in a controller, grep existing controllers to confirm which claim the app actually uses (this codebase stores the user ID in `ClaimTypes.NameIdentifier`, not the standard `"sub"` claim) and follow that convention — reading a claim the app never emits (e.g., `"sub"`) silently returns null and produces 401s. Verify data exists in the DB before redeploying to confirm the root cause is the claim, not missing data. Confidence: 0.80
- Place literal/static route segments (e.g., `[HttpGet("records")]`) BEFORE parameterized route segments (e.g., `[HttpGet("{slug}")]`) in the same controller. ASP.NET Core matches routes top-to-bottom and `{slug}` will catch static path values like "records", returning 404 when the expected resource isn't found. Confidence: 0.85
- When building a read-only records view, provide a dedicated aggregated backend endpoint (e.g., `GET /api/pay-in/records`) that collects data server-side, rather than making the frontend orchestrate multiple API calls to individual resources. This keeps the frontend thin and avoids per-resource authorization issues. Confidence: 0.70

# uniqueness-validation
- Duplicate/uniqueness checks on create APIs must be case-insensitive (Postgres `LOWER()`/`ToLower()` comparison), not exact-match — `"VIP Room"` and `"vip room"` must be treated as the same name. Audit every create path (game rooms, platforms, slugs, usernames, emails, legal names, provider names) for missing or case-sensitive checks and fix them consistently. Confidence: 0.85
- Enforce uniqueness at the database level too: add case-insensitive unique indexes (e.g., `CREATE UNIQUE INDEX ... ON game_rooms (agency_id, LOWER(name))`) as a backstop behind the service-layer checks, and handle Postgres unique-violation (SqlState `23505`) in the exception middleware so a DB conflict returns a clean 400 "already exists" message instead of a 500. Confidence: 0.8
- When extending repository interfaces with new check methods, update ALL fake repositories in the test project in the same pass so the test project builds and passes. Confidence: 0.8

# dto-evolution
- When a detail dialog displays a referenced entity's name (game room, platform, etc.), resolve the name server-side in the backend DTO — do not rely on the viewer's tenant-scoped lookup lists. Frontend lookup lists only return the current user's tenant's records, so cross-tenant references silently fail the lookup and fall back to showing raw GUIDs. Resolve via the appropriate repository in the service layer and pass to the mapper (extend the existing DTO with optional name parameters defaulting to `""`). Confidence: 0.8
- When a financial journal/ledger entry references an underlying business record (pay-in record, payout request) but stores no actor or status, resolve `Username` and `Status` server-side by joining the entry's `ReferenceId`/`ReferenceType` to the referenced record (payer name for pay-ins, employee username for payouts) rather than leaving the frontend to guess or show blanks. Confidence: 0.75

# communication
- When diagnosing a UI bug category (e.g., "unnecessary scroll", layout issues), present findings as a structured report with: numbered findings tables (Page/Component, Viewport, Scroll Type, Root Cause, Severity, Fix Direction), an "Uncertain / Needs a Decision" section for ambiguous items, and a severity-priority summary — then let the user confirm before implementing fixes. Confidence: 0.80

# docs
See [docs/taste.md](docs/taste.md)
