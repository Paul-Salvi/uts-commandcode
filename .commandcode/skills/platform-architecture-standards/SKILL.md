---
name: platform-architecture-standards
description: Canonical .NET architecture, layering, DI, mapping, validation, testing, and naming conventions for this platform (SP.Host.Api, UTS.Core, UTS.Service, UTS.Plugin.Postgres, UTS.Adapter.*, UTS.MockAdapters, UTS.Common) - a Clean/Onion-style layered architecture with adapters and pluggable persistence. Consult before writing or reviewing any code here - adding a controller, service, repository, domain entity, external adapter/integration, DTO, mapper, validator, domain event, middleware, background job, health check, or test - or when deciding which project something belongs in, wiring up DI, naming a class, handling errors, or setting up CI/local dev. Trigger on casual requests like 'add an endpoint for X', 'create a repository for Y', 'hook up a new adapter for Z', or 'where does this mapper go'. Payout/Wallet/DollarPay/Nexapay are current examples, but the rules apply to any feature or integration on this platform, not just payments.
---

# .NET Platform Architecture & Engineering Standards

This skill captures the canonical solution layout, layering rules, DI strategy, mapping conventions, testing strategy, and naming conventions for this .NET platform. Treat it as the source of truth whenever you're adding, moving, or reviewing code anywhere in this codebase — the goal is to keep Core pure, keep mapping at the boundaries, and keep every new file in the project and folder it belongs in. The examples below (Payout, Wallet, DollarPay, Nexapay) come from the platform's current payments domain, but the standards themselves are general-purpose and apply to any module built on this architecture.

Two rules matter more than any other in this document:

1. **Keep Core pure.** No DTOs, no HTTP concerns, no framework types leak into `UTS.Core`. If you're about to import something external there, stop and map at the boundary instead.
2. **Map only at boundaries.** Host↔Service, Service↔Core, Adapter↔Core, Plugin↔Core. Never map inside Core itself.

## Solution layout

All production code lives under `/src`. Docs and build scripts live at the repo root.

```
/src
  UTS.Host.Api
  UTS.Core
  UTS.Service
  UTS.Contracts        
  UTS.Common
  UTS.Plugin.Postgres
  UTS.Adapter.DollarPay
  UTS.Adapter.Nexapay
  UTS.MockAdapters
  UTS.Test.Unit
  UTS.Test.Integration
  UTS.Test.Contract
/docs
/build
```

## Layer responsibilities

Before writing a line of code, decide which layer it belongs in:

| Project | Responsibility | Depends on | Must NOT contain |
|---|---|---|---|
| `UTS.Core` | Domain truth: entities, value objects, domain services, domain interfaces, domain events, domain exceptions, error codes | Nothing | Any external dependency |
| `UTS.Service` | Application/use-case layer: service contracts, orchestrations, DTOs, validation, Service↔Core mapping, event publishing | `UTS.Core`, `UTS.Common` only | HTTP concerns, DB concerns |
| `SP.Host.Api` | Composition root and HTTP pipeline: middlewares, DI wiring, controllers, API models, health checks, hosted services | Everything (it's the composition root) | Business logic |
| `UTS.Adapter.*` | External integrations: implement Core interfaces, map External↔Domain, HTTP clients, partner-specific logic | `UTS.Core` | Domain logic |
| `UTS.Plugin.Postgres` | Persistence: DbContext, DB entities, repositories implementing Core interfaces, DB↔Domain mappers, migrations | `UTS.Core` | Domain logic |
| `UTS.MockAdapters` | Deterministic fakes implementing the same Core interfaces as real adapters, for local dev and CI | `UTS.Core` | — |
| `UTS.Common` | Cross-cutting abstractions: `IClock`, `IGuidGenerator`, `ICorrelationIdProvider`, `ITenantContext`, `IDomainEventDispatcher`, `IDomainLogger` | Nothing | Business logic |

## Project and folder conventions

Use feature folders in large modules. Default internal layout per project:

**`UTS.Core`**
```
/Entities
/ValueObjects
/Interfaces
/DomainServices
/Policies
/Exceptions
/DomainEvents
/DomainEventHandlers
/ErrorCodes
```

**`UTS.Service`**
```
/Contracts
/Implementations
/DTOs
/Mappers
/Validation
/Events
```

**`UTS.Plugin.Postgres`**
```
/DbContext
/Entities        (DB models)
/Repositories
/Mappers         (DB ↔ Domain)
/Migrations
```

**Adapters (`UTS.Adapter.*`)**
```
/Client
/DTOs             (external)
/Implementations  (implements Core interfaces)
/Mappers          (External ↔ Domain)
```

**`SP.Host.Api`**
```
/Controllers
/Middlewares
/Extensions
/Configuration
/HostedServices
/HealthChecks
/ErrorCodes
/Security
```

**`UTS.MockAdapters`**
```
/DollarPay
/Nexapay
/CommonMockBehaviors
```

## Dependency and DI strategy

- Dependencies only point inward: `Host → Service → Core`. Adapters and Plugins depend on `Core`. `Core` depends on nothing.
- Each project exposes exactly one DI extension method:
  - `AddCoreDomain(this IServiceCollection services)`
  - `AddApplicationServices(this IServiceCollection services)`
  - `AddPostgresPersistence(this IServiceCollection services, IConfiguration config)`
  - `AddDollarPayAdapter(this IServiceCollection services, IConfiguration config)`
  - `AddMockAdapters(this IServiceCollection services)`
- `Host` composes the full DI graph in `Program.cs` — it's the only place that wires everything together.
- Registration order matters: Core → Common → Plugins → Adapters → Service → Host-specific registrations.

## Mapping and translation rules

Mapping happens at boundaries only — never inside `UTS.Core`.

- **Host ↔ Service**: API DTO ↔ Service DTO (in `SP.Host.Api` or `UTS.Contracts`)
- **Service ↔ Core**: Service DTO ↔ Domain model (mappers live in `UTS.Service`)
- **Adapter ↔ Core**: External DTO ↔ Domain model (mappers live in the adapter project)
- **Plugin ↔ Core**: DB model ↔ Domain model (mappers live in `UTS.Plugin.Postgres`)

Prefer explicit, hand-written mappers for anything domain-critical — reach for AutoMapper only on trivial, stable DTOs. Keep mapping logic inside `Mappers/` folders and expose small, composable mapping helpers rather than one giant mapper class.

## Validation and error handling

- Use FluentValidation in `UTS.Service` for DTO validation and application-level rules.
- Enforce domain invariants inside `Core` entities/value objects — throw domain exceptions, don't silently coerce.
- Domain error codes live in `UTS.Core/ErrorCodes/DomainErrorCodes.cs`; API error codes live in `SP.Host.Api/ErrorCodes/ApiErrorCodes.cs`.
- A global `ExceptionMiddleware` in Host maUTS `DomainException`s → `ApiErrorCodes` → HTTP status codes.
- Keep domain exceptions typed (`NotFoundException`, `ValidationException`, `DomainException`, etc.) so the mapping in `ExceptionMiddleware` stays precise instead of falling back to generic 500s.

## Domain events and audit

- Domain events live in `UTS.Core/DomainEvents` and are raised by entities or domain services.
- `IDomainEventDispatcher` (interface in `UTS.Common`) is implemented in Host or Service to publish events to handlers.
- `IAuditService` in `UTS.Service` orchestrates audit entries; audit events are produced by domain events and persisted via repositories in `UTS.Plugin.Postgres`.
- Audit entries are immutable, ledger-like records — never update them in place.

## Middleware and host responsibilities

All middleware belongs in `SP.Host.Api`, never in Service or Core:

- `ExceptionMiddleware` — global error handling and mapping
- `LoggingMiddleware` — request/response logging, structured logs, correlation IDs
- `CorrelationIdMiddleware` — generate/propagate correlation IDs
- `RequestTimingMiddleware` — latency measurement and metrics
- `TenantResolutionMiddleware` — resolve tenant from JWT/headers into `ITenantContext`
- Authentication & authorization (JWT validation, role/permission handlers)
- Rate limiting, CORS, compression, API versioning, Swagger

Host must not contain business logic — hosted services and controllers call into the Service layer for that.

## Background jobs and hosted services

Hosted services live in Host and call the Service layer for the actual work:

- `PayoutStatusPollingService` — poll partners for payout status updates and reconcile
- `LedgerReconciliationService` — periodic ledger checks and corrections
- `NotificationDispatcherService` — send notifications (email/SMS) based on events

Hosted services should be idempotent and resilient — build in retry/backoff and circuit-breaker patterns, since they run unattended.

## Health checks and monitoring

- `DatabaseHealthCheck`, `AdapterHealthCheck` (real adapters), `MockAdapterHealthCheck` — implemented in Host
- Expose readiness and liveness endpoints separately
- Structured logging (Serilog) and metrics (Prometheus, Application Insights)
- Correlation IDs and trace IDs everywhere for distributed tracing

## Security and tenant context

- **Authentication**: JWT validated in Host; claims mapped to `IUserContext` and `ITenantContext`.
- **Authorization**: policy-based, with custom handlers for roles (Admin, Agent, Employee).
- **Tenant resolution**: middleware populates `ITenantContext` per request; services and repositories use it for multi-tenant scoping — never trust a tenant ID passed in the body.
- **Secrets**: KeyVault or a secret manager only. Never in code or config committed to the repo.

## Testing strategy and fixtures

- **Unit tests** (`UTS.Test.Unit`): Core and Service only — no DB, no external APIs, mock adapters/plugins.
- **Integration tests** (`UTS.Test.Integration`): Testcontainers for Postgres; register `MockAdapters` or real adapters in a controlled environment.
- **Contract tests** (`UTS.Test.Contract`): assert real adapters behave the same as `MockAdapters` for request/response shape and error handling.
- Fixtures: `PostgresTestFixture` (spins up Postgres, runs migrations, seeds data), `MockAdapterFixture` (registers mock adapters and deterministic behaviors), plus test-data builders / `SeedData` helpers for consistent scenarios.

## Mock adapters and contract tests

- `UTS.MockAdapters` implements the exact same Core interfaces as the real adapters.
- Configurable behaviors: `FixedSuccessBehavior`, `RandomizedFailureBehavior`, `TimeoutBehavior`.
- Register via a single `AddMockAdapters()` DI extension.
- Contract tests compare `MockAdapters` and real adapters side by side — if you add a new adapter, add a matching contract test before considering it done.

## CI/CD, build and local dev

- Build scripts: `build.UTS1`, `build.sh`, `ci.yml`.
- Local dev: `docker-compose.yml` for Postgres plus optional mock partner simulators.
- CI pipeline order: unit tests → build artifacts → integration tests (Testcontainers) → contract tests → publish artifacts → run migrations as a controlled deployment step.
- Run EF migrations from a dedicated migration job, or via a safe migration strategy in deployment — never as a side effect of app startup in production.

## Documentation and runbooks

Keep `/docs` current:

- `ARCHITECTURE.md` — high-level diagrams and sequence flows
- `API.md` — API contracts and versioning notes
- `DOMAIN.md` — domain model and aggregate boundaries
- `ERROR-CODES.md` — catalog of API and domain error codes
- `RUNBOOKS/` — operational runbooks (DB restore, partner outage, ledger reconciliation)

## Refactor plan (phased)

If asked to help migrate existing code toward this architecture, follow this order rather than doing everything at once:

1. **Foundations** — create `UTS.Common` and Core domain events; move domain exceptions/error codes into `UTS.Core`; add the DI extension pattern to each project.
2. **Service & Host** — build out `UTS.Service` (Contracts, DTOs, Mappers, Validation); add Host middlewares, error code registry, configuration options.
3. **Persistence & Adapters** — implement DB↔Domain mappers/repositories and Adapter↔Domain mappers/client wrappers.
4. **Mock & Tests** — implement `UTS.MockAdapters` and test fixtures; add contract and integration tests.
5. **OUTS & Docs** — hosted services, health checks, CI scripts, docs.

## Naming conventions

| Kind | Pattern | Example |
|---|---|---|
| Interface | `I{Thing}Service`, `I{Thing}Repository`, `I{Thing}Client` | `IPayoutService` |
| Service | `{Thing}Service` | `PayoutService`, `PayinService` |
| Repository | `{Thing}Repository` | `WalletRepository`, `PayoutRequestRepository` |
| DTO | `{Thing}Dto` | `PayoutRequestDto`, `PayinResponseDto` |
| Mapper | `{Thing}Mapper` | `PayoutMapper`, `PaymentRequestEntityMapper` |
| Domain event | `{Thing}{PastTenseVerb}Event` | `PayoutRequestCreatedEvent` |
| Middleware | `{Thing}Middleware` | `ExceptionMiddleware`, `CorrelationIdMiddleware` |
| Hosted service | `{Thing}HostedService` | `LedgerReconciliationHostedService` |

## Example: Host `Program.cs` DI composition

Use this as the template shape for `Program.cs` — configuration validation first, then Core/Common, then Plugins/Adapters (real in production, mocks in dev), then Service, then Host concerns, then the middleware pipeline:

```csharp
var builder = WebApplication.CreateBuilder(args);

// Configuration binding and validation
builder.Services.Configure<DatabaseOptions>(builder.Configuration.GetSection("Database")).ValidateOnStart();
builder.Services.Configure<DollarPayOptions>(builder.Configuration.GetSection("DollarPay")).ValidateOnStart();
builder.Services.Configure<NexapayOptions>(builder.Configuration.GetSection("Nexapay")).ValidateOnStart();

// Core and common
builder.Services.AddCoreDomain();
builder.Services.AddCommonServices();

// Persistence and adapters
builder.Services.AddPostgresPersistence(builder.Configuration);
if (builder.Environment.IsDevelopment())
{
    builder.Services.AddMockAdapters();
}
else
{
    builder.Services.AddDollarPayAdapter(builder.Configuration);
    builder.Services.AddNexapayAdapter(builder.Configuration);
}

// Application services
builder.Services.AddApplicationServices();

// Host concerns
builder.Services.AddHostedServices();
builder.Services.AddHealthChecks();
builder.Services.AddControllers();
builder.Services.AddSwaggerGen();

var app = builder.Build();

// Middleware pipeline
app.UseMiddleware<CorrelationIdMiddleware>();
app.UseMiddleware<LoggingMiddleware>();
app.UseMiddleware<ExceptionMiddleware>();
app.UseRouting();
app.UseAuthentication();
app.UseAuthorization();
app.MapControllers();
app.Run();
```

## Before finishing any task in this codebase

- Did the code land in the right project for its layer? (Check the responsibilities table above.)
- Is Core still free of external dependencies?
- Is all mapping happening at a boundary, not inside Core?
- Did new adapters get a matching contract test and mock behavior?
- Did new domain-critical logic get a unit test, and does anything crossing a real boundary (DB, partner API) have integration/contract coverage?
- Does every new class follow the naming table above?
