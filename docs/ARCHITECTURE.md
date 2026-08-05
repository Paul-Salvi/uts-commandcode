# UTS Architecture — Current Implementation

> **Status**: live, code-verified document of what is built today.
> **Future state**: `PROJECT.md` describes the larger target platform (delivery runs, tracker entries, compliance engine, event store, dead letters, RBAC, EMEA). The system below is the working MVP that the target state will grow into. This document is the source of truth for the current codebase.

---

## 1. Overview

UTS ("Model Delivery Tool") is a full-stack app for boutique SMA/model strategist firms to distribute model portfolio files to sponsor platforms (TAMPs). It is ledger-first for the MVP in one specific way: **every file generation attempt is written to `delivery_log`** — success or failure — with a status lifecycle (`QUEUED → GENERATING → GENERATED/FAILED`) and download tracking. Nothing fails silently.

- **Backend**: ASP.NET Core 10 (Clean/Onion architecture) + EF Core 10 + PostgreSQL (Npgsql).
- **Frontend**: Next.js 16 (App Router) + Tailwind v4, in `uts-ui/`.
- **Deploy**: Docker Compose (`scripts/docker-compose.yml`) — `uts-api` (port 8001) + `uts-ui` (port 8000), Postgres on the host.

---

## 2. Project layout

### `UTS/src` (backend, `UTS.slnx`)
| Project | Responsibility |
|---------|----------------|
| `UTS.Core.Domain` | Entities, constants, exceptions (`DomainException`, `ValidationException`, `NotFoundException`, `ConflictException`) |
| `UTS.Core.Application` | Repository interfaces (`IRepository<T>` + specific repos), DTOs |
| `UTS.Service` | Business services (interfaces + impls), `ImportOptions`/`DeliveryOptions` config |
| `UTS.Adapter.Data` | EF Core `ApplicationDbContext`, repositories, migrations (schema `MIS`) |
| `UTS.Host.API` | Controllers, middleware (`ExceptionMiddleware`, `CorrelationIdMiddleware`), JWT auth, Program.cs |
| `UTS.Test.Unit` | xUnit unit tests + in-memory fakes (137 passing) |
| `UTS.Test.Integration` | (scaffolded, no tests yet) |

### `uts-ui/src` (frontend)
- `app/(authenticated)/`: route group for logged-in pages.
- `components/layout/`: `AppShell` (sidebar + header), `nav-config.ts`.
- `components/ui/`: shared `PageHeader`, `InlineStatBar`, `ModalShell`.
- `lib/auth.ts`: server-side `authFetch` wrapper (JWT from httpOnly cookie).

---

## 3. Domain model (current tables)

Schema: `MIS` (Postgres default schema). Identity keys via `UseIdentityByDefaultColumn`.

| Entity / table | Purpose | Key fields |
|----------------|---------|-----------|
| `StrategistUser` | Firm user (single login per firm for MVP) | `Id`, `Email` (unique), `PasswordHash` (bcrypt), `FirmName`, `CreatedAt` |
| `Sponsor` | A recipient firm you deliver files to | `Id`, `UserId` (FK), `SponsorCode` (unique per user), `Name`, `IsActive`, `CreatedAt` |
| `FileFormatConfig` | How files are formatted for a sponsor (1:1 with Sponsor) | `SponsorId` (PK/FK), `FileType` (CSV/EXCEL), `DecimalPlaces`, `PerModelFile`, `FileNamingPattern`, `ColumnMapping` (jsonb) |
| `Model` | An investment model | `Id`, `ModelCode` (unique), `Name`, `Status`, `Positions` |
| `Position` | A holding in a model | `Id`, `ModelId`, `Symbol`, `SecurityName`, `TargetAllocation`, `AsOfDate`, `SecurityId?` |
| `Security` | Reference list of known securities | `Id`, `Ticker` (unique), `Cusip`, `Sedol`, `Isin`, `SecurityName` |
| `SponsorModel` | "Mark this model for this sponsor" pairing | `Id`, `SponsorId` (FK), `ModelId` (FK), unique `(SponsorId, ModelId)`, `SponsorModelCode?` (sponsor's own name/code), `IsActive` |
| `DeliverySchedule` | Cron schedule for a pairing (one per SponsorModel) | `Id`, `SponsorModelId` (unique FK), `CronExpression?` (null = manual), `IsActive` |
| `DeliveryLog` | One generation attempt (the audit trail) | `Id`, `SponsorModelId` (FK), `TriggerType` (MANUAL/SCHEDULED), `Status` (QUEUED/GENERATING/GENERATED/FAILED), `FileName`, `FilePath`, `ErrorMessage`, `RequestedBy`, `RequestedAt`, `CompletedAt`, `DownloadedAt` |

Legacy/companion tables still present but **not part of the current delivery flow**: `Delivery`, `DeliveryAttempt`, `AccountDetails`, `AccountCache`.

### Key relationships
- `Sponsor 1─N SponsorModel 1─1 DeliverySchedule`
- `SponsorModel 1─N DeliveryLog` (each run = one log row)
- `Sponsor 1─1 FileFormatConfig`
- `Model 1─N Position N─1 Security`
- `Sponsor N─1 StrategistUser`

---

## 4. Backend services & API

Services (in `UTS.Service/Services/`), each with an interface + implementation:

| Service | Responsibilities |
|---------|------------------|
| `AuthService` | Login → signed JWT (`sub` claim = user id), bcrypt verify |
| `SponsorService` | Sponsor CRUD, activate/deactivate, user-scoped, case-insensitive code/name uniqueness |
| `FileFormatConfigService` | Get/upsert a sponsor's file format config |
| `SponsorModelService` | List/toggle model-for-sponsor markings, set sponsor's code |
| `DeliveryScheduleService` | Set/clear a cron schedule per SponsorModel |
| `FileDeliveryService` | **Vertical 3**: status view (latest run per active pairing), trigger generation, mark downloaded, resolve download |
| `ModelService`, `SecurityService`, `ImportService` | Model/security CRUD; CSV/Excel import + validation (weight tolerance, ticker resolution, row-level errors) |
| `AccountService`, `DeliveryService` | Legacy account/delivery stack (not part of current flow) |

### API endpoints (all `[Authorize]`, JWT bearer, `sub` claim = user id)
- **Auth**: `POST /api/Auth/login`
- **Sponsors**: `GET/POST /api/Sponsors`, `GET /api/Sponsors/{id}`, `PUT /api/Sponsors/{id}`, `POST /api/Sponsors/{id}/deactivate|activate`
- **File format**: `GET/PUT /api/FileFormatConfigs/sponsor/{sponsorId}`
- **Sponsor models**: `GET /api/SponsorModels/sponsor/{sponsorId}`, `PUT /api/SponsorModels/sponsor/{sponsorId}/models/{modelId}`, `PUT /api/SponsorModels/{id}/code`
- **Schedules**: `GET/PUT/DELETE /api/DeliverySchedules/sponsor-model/{sponsorModelId}`
- **Deliveries (Vertical 3)**: `GET /api/FileDeliveries/status`, `POST /api/FileDeliveries/sponsor-model/{id}/generate`, `POST /api/FileDeliveries/log/{id}/download`, `GET /api/FileDeliveries/download/{id}`
- **Models**: `GET /api/Models`, `GET /api/Models/search?search=&status=&page=&pageSize=`, `GET /api/Models/with-positions`, `GET /api/Models/{id}/positions`
- **Securities**: `GET/POST /api/Securities`, `PUT/DELETE /api/Securities/{id}`
- **Imports**: `POST /api/Imports/validate`, `POST /api/Imports`
- **Accounts/Deliveries/Health**: legacy + `GET /api/Health`

### File generation flow (the core value prop)
1. `POST /api/FileDeliveries/sponsor-model/{id}/generate` creates a `DeliveryLog` row `QUEUED`.
2. `FileDeliveryService` loads the model's **latest as-of-date** positions, applies the sponsor's `FileFormatConfig` column mapping + decimal places, renders **CSV** (stream writer) or **Excel** (ClosedXML).
3. Writes to `DeliveryOptions.StoragePath` (default `deliveries/`), names via the config's `FileNamingPattern`.
4. Status → `GENERATED` (with `FileName`/`FilePath`/`CompletedAt`) or **`FAILED`** with a readable `ErrorMessage` on any exception — never silent.
5. `GET /api/FileDeliveries/status` returns one row per **active** `SponsorModel` with its latest run's status/requested/downloaded, via an ORM "latest row per group" query.
6. Download serves the bytes; `POST .../log/{id}/download` sets `DownloadedAt`.

---

## 5. Frontend

### Routes (`app/(authenticated)/`)
| Route | Page | Notes |
|-------|------|-------|
| `/dashboard` | Stats (inline bar) + nav cards | |
| `/import` | Upload form + persistent preview table | Two-column layout (`340px` form + fluid preview); skeleton rows before validate |
| `/models` | Searchable/filterable model table | Server-side search API, pagination, row-click detail modal |
| `/sponsors` | Sponsor list (stats bar, table, Create modal) | Completeness chip (X/2 CONFIGURED); row-click detail modal → View details |
| `/sponsors/[id]` | Sponsor detail (Details / File format / Model mapping tabs) | Manage-models modal; mapped-models panel |
| `/deliveries` | Status view per active pairing | Generate now + download link, muted-italic "Not yet generated" |
| `(settings)` | Empty (route removed) | |

### Design system (applied)
- Dark sidebar (#3A3D44, fixed 180px), accent `#5DCAA5` for primary CTAs + active nav.
- Mono (`font-data`) for identifiers/codes/counts/dates; proportional for labels.
- Compact tables (`py-2` rows, 11px uppercase headers, right-aligned mono numerics).
- Muted-italic for missing/empty values; semantic green/amber/red strictly for status.
- Shared `PageHeader`, `InlineStatBar`, `ModalShell` in `components/ui/`.

### Data access
- `lib/auth.ts` `authFetch` attaches the JWT from the httpOnly `uts_token` cookie; returns `{ data, error }`. Server actions in each feature's `actions.ts` call it (PascalCase→camelCase mapping for the .NET API).
- Download files proxy through `app/api/download/[logId]/route.ts` (same-origin, cookie → Bearer).

---

## 6. Verification commands
- Backend: `dotnet build UTS.slnx` · `dotnet test UTS.slnx` (137 unit tests).
- Migrations: `dotnet ef migrations add <Name> --project src/UTS.Adapter.Data --startup-project src/UTS.Host.API`; `dotnet ef database update --connection "Host=localhost;Port=5432;Database=UTS;Username=uts_user;Password=..."`.
- Frontend: `npx tsc --noEmit` · `npm run build` (in `uts-ui/`).
- Deploy: `docker compose up -d --build` (in `scripts/`).
- Test login: `admin@firm.com` / `Admin123!` (dev seed).

---

## 7. Mapping to the PROJECT.md target state
The current system is the foundation for the documented target. Current → target mapping:

| Current | Target (PROJECT.md) |
|---------|---------------------|
| `Sponsor` (code/name/active) | `sponsor` + region, status, contacts, config |
| `SponsorModel` (mark model for sponsor) | `sponsor_model` + flags, persist, intraday |
| `DeliverySchedule` (cron per pairing) | `delivery_schedule` (frequency, calendar) |
| `DeliveryLog` (per-run audit row) | `delivery_run` + `tracker` entries + `event_log` |
| `FileDeliveriesController` (generate/status/download) | dispatch + manifest + callbacks |
| Single user login | `app_user`/roles (RBAC), SSO later |
| Single Postgres | + event store, stage store, metrics store |

Not yet built (documented only): delivery runs, tracker state machine, compliance engine, dispatches/manifests, event log, dead letters, SLA/cycle-time metrics, RBAC, regions/EMEA, CRD adapters, corporate actions, Y-Charts integration.
