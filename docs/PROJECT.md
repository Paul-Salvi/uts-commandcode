# Next-Generation Platform Architecture

> **Target-state reference**: this document describes the future platform architecture (delivery runs, tracker, compliance, event store, etc.). It is **not** a description of what is built today — see `ARCHITECTURE.md` for the current, code-verified implementation and how it maps to this target.
>
> **Canonical document**: this file is the single source of truth for the platform architecture. (A previous `NextgenArchitect.md` draft has been consolidated here.)
>
> This document describes a next-generation platform for orchestrating, executing, tracking, and auditing the distribution of SMA model files to sponsors. It is built ledger-first: every state change is an immutable record, every delivery is a trackable delivery run, and nothing fails silently.
>
> **Naming note**: terminology is carried over from the existing platform — sponsor, flagship model, sponsor model, delivery run, delivery log, compliance check, CRD, Y-Charts historical file, corporate action — so existing users and downstream consumers are not confused. Only genuinely new concepts (stage, dispatch, manifest, dead letter, cycle time, SLA attainment) introduce new terms. This document intentionally avoids a product name; table names, API domains, and paths below use plain, generic identifiers so nothing needs to be renamed later once a product name is chosen.

---

## 1. Vision

Today, running a model distribution cycle is a fire-and-forget batch job with status buried in email. **This platform** replaces that with:

- **Full lifecycle visibility** — every delivery is a *delivery run* with a live progress bar, per-model status, and a complete audit trail.
- **Ledger-first design** — every state transition is an append-only event. You can always answer *what happened, when, why, and who/what caused it*.
- **Failure as a first-class citizen** — structured error codes, retry queues, dead-letter handling, and alerting instead of a single "something failed" email.
- **Stats on every screen** — KPIs, trend charts, success rates, cycle times, and SLA attainment.
- **API-first** — every capability is a typed, versioned, idempotent API consumed by the console UI, schedulers, and integrations.

---

## 2. Design Principles

| # | Principle | What it means |
|---|-----------|---------------|
| 1 | **Ledger-first** | All state lives in an append-only event log; current state is a projection of that log. Nothing is ever updated in place silently. |
| 2 | **Idempotency** | Every command carries an idempotency key. Retrying a request never double-delivers. |
| 3 | **Progress is modeled** | Every unit of work has a defined state machine and a numeric progress percentage. No more binary "running/failed". |
| 4 | **Failure is data** | Failures carry structured error codes, retry counts, and resolution actions — not just a stack trace. |
| 5 | **Observable by default** | Metrics, traces, and structured logs are emitted at every stage; dashboards consume them live. |
| 6 | **Decoupled execution** | The platform orchestrates; adapters and dispatch engines execute. Each is replaceable behind a contract. |
| 7 | **Human-in-the-loop for decisions** | Compliance checks and risky retries require explicit approval with a full audit trail. |
| 8 | **Tenant-safe** | Regional isolation (NA / EMEA), RBAC, and per-sponsor data visibility. |

---

## 3. Platform Map

```
                            ┌────────────────────────────────────────────┐
                            │            Platform Console (React SPA)    │
                            │  Command Center · Delivery Runs ·          │
                            │  Delivery Log · Sponsors · Models ·        │
                            │  Compliance · Failures                     │
                            └───────────────┬────────────────────────────┘
                                            │ HTTPS + SSE
                            ┌───────────────▼────────────────────────────┐
                            │           API Gateway (REST /v1)           │
                            │  Auth (OAuth2 / JWT) · Rate limit · Audit  │
                            └───────┬───────────────┬──────────┬─────────┘
                                    │               │          │
                    ┌───────────────▼──┐   ┌────────▼──────┐  ┌─▼───────────────┐
                    │  Command Side    │   │  Query Side   │  │ Event Stream    │
                    │  (Delivery runs, │   │  (Read models │  │ (SSE / Webhooks)│
                    │   retries, ops)  │   │   for UI)     │  │                 │
                    └───────┬──────────┘   └───────┬───────┘  └─┬───────────────┘
                            │                      │            │
                    ┌───────▼──────────────────────▼────────────▼───────────────┐
                    │                    Platform Core Domain                    │
                    │  Run Orchestrator · State Machine · Compliance Engine     │
                    │  Dispatch Broker · Failure Handler · Metrics Collector     │
                    └───────┬──────────────────────┬────────────────────────────┘
                            │                      │
              ┌─────────────▼──────────┐   ┌───────▼─────────────────┐
              │  CRD Adapters          │   │  Dispatch Engines       │
              │  (fetch flagships &    │   │  (file build, transport,│
              │   sponsor model data)  │   │   delivery receipts)    │
              └─────────────┬──────────┘   └───────┬─────────────────┘
                            │                      │
              ┌─────────────▼──────────────────────▼─────────────────┐
              │              Persistence Layer                        │
              │  PostgreSQL (state + read models)                    │
              │  Event Store (append-only log)                       │
              │  Stage Store (object storage: manifests, files)      │
              │  Metrics Store (time-series KPIs)                    │
              └──────────────────────────────────────────────────────┘
```

---

## 4. Core Concepts

Terminology is carried over from the existing platform; only genuinely new concepts (Stage, Dispatch, Manifest, Dead Letter, Cycle Time, SLA Attainment, Stage Store) introduce new terms.

| Term | Meaning | Example |
|------|---------|---------|
| **Sponsor** | An external recipient that receives sponsor model files. | `Envestnet` receives a file every month-end. |
| **Flagship model** | A master investment model; the authoritative composition of a portfolio. | `M_SMA_MODIEF` defines the holdings and target weights. |
| **Sponsor model** | A sponsor-specific variant of a flagship, formatted for that sponsor. | `M_SMA_MOD4927-EN_EM` is the Envestnet variant. |
| **Delivery run** | One end-to-end distribution cycle (triggered by schedule, corporate action, or operator). | "Monthly cycle" run `DR-2026-08-04-001`. |
| **Tracker entry** | A single unit of work inside a delivery run — one sponsor model for one sponsor. The tracker is the live work-queue table for the run (renamed from "delivery log" to match existing terminology). | Deliver `M_SMA_MOD4927-EN_EM` to Envestnet. |
| **Stage** *(new)* | A step in the entry lifecycle (fetch, validate, compliance, build, dispatch, deliver). | Entry is at stage `DISPATCH_QUEUED`. |
| **Compliance check** | A rule-engine validation that must pass before proceeding. | "No single position above 10% weight" check. |
| **Dispatch** *(new)* | The handoff of a built manifest to a dispatch engine for actual file delivery. | Dispatch `DSP-8841` shipped `manifest-42.json` to the delivery engine. |
| **Manifest** *(new)* | The packaged output of a tracker entry — the file(s) + metadata + checksum. | `ENVESTNET-20260804.zip` + manifest describing its contents. |
| **Delivery schedule** | A recurring rebalance/distribution calendar attached to sponsor models or sponsors. | Envestnet runs on a quarterly rebalance calendar. |
| **CRD** | The Source of Record — the upstream authoritative system holding current flagship/sponsor model positions. | The CRD gateway the adapter pulls from. |
| **Model import file** | An external file of target holdings imported to update models. | A post-corporate-action target-holdings file. |
| **Corporate action** | An event that changes model composition (merger, split, delisting, dividend). | A 2-for-1 split triggers a delivery run. |
| **Y-Charts historical file** | The historical model/position data store used by analytics and reporting. | 36 months of position history per model. |
| **Stage Store** *(new)* | Object storage for intermediate files, manifests, and logs. | `s3://stage-store/runs/DR-001/` |
| **Dead Letter** *(new)* | A dispatch that exhausted retries and was parked for human review. | Dispatch parked with reason `ENGINE_UNREACHABLE`. |
| **Cycle Time** *(new)* | Elapsed time from run trigger to final delivery. | 2h 14m. |
| **SLA Attainment** *(new)* | Percentage of deliveries completed within the agreed time window. | 98.4% within 4 business hours. |

---

## 5. The State Model (Progress & Failure)

Every **Tracker Entry** moves through a fixed state machine. Progress is derived from state; percentages are computed centrally.

```
                    ┌────────────────────────────────────────────────────────────┐
                    │                   TRACKER ENTRY STATES                    │
                    └────────────────────────────────────────────────────────────┘

  QUEUED ──► FETCHING ──► VALIDATED ──► COMPLIANCE_PENDING ──► COMPLIANCE_PASS ──► BUILDING
    │            │            │              │              │            │
    │            │            │              │        COMPLIANCE_ALERT ────┤
    │            │            │              │           (needs            │
    │            │            │              │            decision)        ▼
    │            │            │              ▼                        DISPATCH_QUEUED
    │            │            │     AWAITING_DECISION                      │
    │            │            │        │   │                              │
    │            │            │    approve ▼ reject                       ▼
    │            │            │  COMPLIANCE_PASS   FAILED            DISPATCHED
    │            │            ▼                  (terminal)             │
    │            ▼           FAILED                                DELIVERED (terminal, 100%)
    └──────► CANCELLED   (terminal, carries error         STALE (terminal: exceeded SLA
                          code + reason + attempts)        window without ack)

  BUILDING can fail (e.g. BUILD_TIMEOUT, BUILD_ERROR): BUILDING ──► FAILED,
  with the failure taxonomy populated (error_code, error_category, reason).
  WAITING_ON_INPUT (optional, from QUEUED/FETCHING): the entry is blocked until
  the operator drops the required input file (e.g. corporate-action model file,
  security classification file) and acknowledges it via the API.

  Every transition above emits an audit event (append-only) with actor, time, and payload.
  AWAITING_DECISION is a holding state: the entry is blocked until a compliance
  officer approves (→ COMPLIANCE_PASS) or rejects (→ FAILED). Its SLA timer
  keeps running so "stuck awaiting decision" entries are surfaced and escalated.
```

### Progress mapping

| State | Progress % |
|-------|-----------|
| QUEUED | 5 |
| WAITING_ON_INPUT | 10 |
| FETCHING | 15 |
| VALIDATED | 25 |
| COMPLIANCE_PENDING | 40 |
| AWAITING_DECISION | 45 |
| COMPLIANCE_PASS | 55 |
| BUILDING | 70 |
| DISPATCH_QUEUED | 85 |
| DISPATCHED | 95 |
| DELIVERED | 100 |
| FAILED / STALE / CANCELLED | frozen at last value, flagged as terminal |

### Failure handling model

| Concept | Behavior |
|---------|----------|
| **Retry with backoff** | Automatic retries (e.g., 3 attempts: 30s, 2m, 10m) for transient failures (`CRD_TIMEOUT`, `ENGINE_5XX`). |
| **Dead Letter** | After max retries, dispatch/entry is parked in `DEAD_LETTER` with full context. |
| **Manual retry** | Operator can re-queue dead-lettered entries with a reason (audited). |
| **Failure taxonomy** | Structured `error_code` + `error_category` (CRD, VALIDATION, COMPLIANCE, BUILD, DISPATCH, ENGINE, TIMEOUT) + human-readable `reason`. |
| **Alerting** | Thresholds (e.g., ≥3 failures in a run, or any DEAD_LETTER) page the ops channel immediately. |
| **Escalation** | Unresolved dead letters escalate after configurable hold times (e.g., 4h → 1 business day → 2 days). |

---

## 6. Database Design

**Engine:** PostgreSQL (state + read models), append-only Event Store table, object storage for files, time-series metrics table.

### 6.1 Entity-Relationship Overview

```
SPONSOR 1───N SPONSOR_MODEL N───1 FLAGSHIP
  │                │
  │                │ N
  │                ▼
  │       DELIVERY_SCHEDULE ───► DELIVERY_RUN 1───N TRACKER
  │                                                │
  │                                                ├──1──N COMPLIANCE_CHECK
  │                                                ├──1──N DISPATCH 1───N MANIFEST
  │                                                └──1──N ENTRY_EVENT (via EVENT LOG)
  │
  └───N NOTIFICATION
```

### 6.2 Tables

#### `sponsor`
| Column | Type | Notes |
|--------|------|-------|
| sponsor_code | varchar PK | unique business key |
| sponsor_name | varchar | |
| region | varchar | e.g. `na` / `emea` |
| status | varchar | `ACTIVE` / `SUSPENDED` / `INACTIVE` |
| file_template | varchar | output template reference (Standard / Pivoted / Global Pivoted) |
| contacts | jsonb | notification recipients, escalation contacts |
| config | jsonb | sponsor-specific delivery config |
| created_at / updated_at | timestamptz | |

#### `flagship`
| Column | Type | Notes |
|--------|------|-------|
| flagship_code | varchar PK | e.g. `M_SMA_MODIEF` |
| flagship_name | varchar | |
| region | varchar | |
| status | varchar | `ACTIVE` / `RETIRED` |
| version | int | immutable versions |
| crd_ref | varchar | key in CRD |
| created_at / updated_at | timestamptz | |

#### `sponsor_model`
| Column | Type | Notes |
|--------|------|-------|
| model_id | uuid PK | |
| sponsor_code | varchar FK | |
| flagship_code | varchar FK | |
| model_code | varchar | sponsor-facing code, e.g. `M_SMA_MOD4927-EN_EM` |
| model_name | varchar | |
| status | varchar | `ONBOARDED` / `TERMINATED` |
| persist_flag | boolean | persist model in downstream systems |
| include_intraday | boolean | |
| created_at / updated_at | timestamptz | |

#### `delivery_schedule`
| Column | Type | Notes |
|--------|------|-------|
| schedule_id | uuid PK | |
| sponsor_code | varchar FK | |
| model_id | uuid FK | optional (sponsor-level or model-level) |
| frequency | varchar | `MONTHLY` / `QUARTERLY` / `EVENT_DRIVEN` / `CORPORATE_ACTION` |
| calendar | jsonb | business-day calendar override |
| next_run_at | timestamptz | scheduler cursor |
| active | boolean | |

#### `delivery_run`
| Column | Type | Notes |
|--------|------|-------|
| run_id | uuid PK | |
| run_code | varchar | human-readable, e.g. `DR-2026-08-04-001` |
| region | varchar | |
| run_type | varchar | `REBALANCE` / `CORPORATE_ACTION` / `ADHOC` / `TEST` |
| status | varchar | `DRAFT` / `RUNNING` / `COMPLETED` / `PARTIALLY_COMPLETED` / `FAILED` / `CANCELLED` |
| trigger_source | varchar | scheduler / operator / corporate action |
| trigger_ref | varchar | idempotency key of the trigger |
| entry_count | int | total entries |
| completed_count / failed_count / in_progress_count | int | denormalized for fast stats |
| progress_pct | numeric | run-level aggregation |
| scheduled_at / started_at / completed_at | timestamptz | |
| created_by | varchar | |
| created_at / updated_at | timestamptz | |

#### `tracker`
| Column | Type | Notes |
|--------|------|-------|
| entry_id | uuid PK | |
| run_id | uuid FK | |
| model_id | uuid FK | |
| sponsor_code | varchar FK | denormalized for queries |
| state | varchar | state machine value |
| progress_pct | numeric | derived from state |
| attempt_count | int | |
| error_code / error_category / reason | varchar | populated on failure |
| last_error_at | timestamptz | |
| sla_due_at | timestamptz | deadline for this entry |
| started_at / finished_at | timestamptz | |
| created_at / updated_at | timestamptz | |

#### `compliance_check`
| Column | Type | Notes |
|--------|------|-------|
| check_id | uuid PK | |
| entry_id | uuid FK | |
| check_code | varchar | compliance rule identifier |
| check_result | varchar | `PASS` / `ALERT` / `FAIL` / `SKIPPED` |
| details | jsonb | positions, thresholds, violations |
| decided_by / decided_at | varchar / timestamptz | human decision when override used |
| decision_note | varchar | |

#### `dispatch`
| Column | Type | Notes |
|--------|------|-------|
| dispatch_id | uuid PK | |
| entry_id | uuid FK | |
| engine | varchar | dispatch engine id |
| state | varchar | `QUEUED` / `SENT` / `ACKED` / `DELIVERED` / `FAILED` / `DEAD_LETTER` |
| attempt_count | int | |
| last_error / last_error_code | varchar | |
| next_retry_at | timestamptz | |
| dead_letter_reason | varchar | |
| created_at / updated_at | timestamptz | |

#### `manifest`
| Column | Type | Notes |
|--------|------|-------|
| manifest_id | uuid PK | |
| dispatch_id | uuid FK | |
| file_name / file_ref | varchar | file name + Stage Store object key |
| checksum | varchar | integrity |
| size_bytes | bigint | |
| format | varchar | template/format id |
| created_at | timestamptz | |

#### `event_log` (append-only event log — never updated, never deleted)
| Column | Type | Notes |
|--------|------|-------|
| event_id | bigserial PK | |
| aggregate_type | varchar | `DELIVERY_RUN` / `TRACKER` / `DISPATCH` / `SPONSOR` / ... |
| aggregate_id | uuid | |
| event_type | varchar | e.g. `ENTRY_STATE_CHANGED`, `DISPATCH_ACKED` |
| payload | jsonb | full context |
| actor | varchar | user / system / scheduler |
| trace_id | varchar | distributed tracing correlation |
| created_at | timestamptz | |

**Retention & archival:** the event log is immutable (append-only, never updated/deleted) but is tiered to avoid unbounded growth. A daily archival job moves events older than the hot window (e.g. 6 months) to object storage (Stage Store) in partitioned, compressed batches keyed by month. Hot `event_log` stays in PostgreSQL for recent queries; the Delivery History page queries both tiers transparently. Archived batches carry checksums so integrity is preserved end-to-end. Before archiving, a daily aggregation job rolls the window's events into the `metric` table so KPIs remain queryable even after the raw events leave the hot tier.

#### `metric` (time-series)
| Column | Type | Notes |
|--------|------|-------|
| metric_id | bigserial PK | |
| metric_name | varchar | e.g. `deliveries_success_rate` |
| value | numeric | |
| dimensions | jsonb | run, region, sponsor, stage |
| window_start / window_end | timestamptz | aggregation window |
| created_at | timestamptz | |

#### `notification`
| Column | Type | Notes |
|--------|------|-------|
| notification_id | uuid PK | |
| run_id | uuid FK | |
| channel | varchar | `EMAIL` / `CHAT` / `WEBHOOK` |
| recipients | jsonb | |
| subject / body_ref | varchar | body in Stage Store if large |
| state | varchar | `QUEUED` / `SENT` / `FAILED` |
| created_at | timestamptz | |

#### `app_user` / `app_role` / `app_user_role`
Local user store with RBAC. `app_user` holds the username, email, display name, and status (`ACTIVE` / `DISABLED`), plus a **hashed** password (bcrypt/argon2) — never plaintext. Authentication issues a signed JWT (or session) with the user's roles/scopes as claims. Roles: `VIEWER` (read-only), `OPERATOR` (run/retry/cancel), `COMPLIANCE_OFFICER` (compliance decisions), `ADMIN` (config, users). Password lifecycle: strong-password policy, expiry, forced reset, lockout after repeated failures. Optional later: delegate login to the corporate IdP (OAuth2/OIDC) and map IdP groups to the same roles; the `app_user` table then becomes a reference to the IdP subject.

### 6.3 Key Indexes

- `tracker (run_id, state)` — run progress queries.
- `tracker (sponsor_code, state)` — sponsor views.
- `event_log (aggregate_type, aggregate_id, created_at)` — audit trail.
- `dispatch (state, next_retry_at)` — retry sweeper.
- `delivery_run (status, scheduled_at)` — scheduler and dashboard.
- `metric (metric_name, window_start)` — dashboards.

---

## 7. API Design

Base path: `https://api.example.com/v1`. All endpoints require OAuth2 (JWT) with RBAC scopes. Writes accept an `Idempotency-Key` header. Errors use a standard envelope with `error_code` + `trace_id`.

### 7.1 Endpoint Catalog

| Method | Path | Purpose | Scope |
|--------|------|---------|-------|
| POST | `/delivery-runs` | Create/trigger a delivery run (schedule, corporate action, or adhoc) | operator |
| GET | `/delivery-runs` | List runs (filter: status, region, date range, type) | viewer |
| GET | `/delivery-runs/{runId}` | Run summary: status, progress %, counts, timeline | viewer |
| GET | `/delivery-runs/{runId}/tracker` | Per-entry status table (paged, filterable by state) | viewer |
| GET | `/delivery-runs/{runId}/tracker/{entryId}` | Entry detail: state, attempts, errors, SLA, events | viewer |
| GET | `/delivery-runs/{runId}/events` | Audit trail for the run | viewer |
| POST | `/delivery-runs/{runId}/retry` | Retry all failed/dead-lettered entries | operator |
| POST | `/delivery-runs/{runId}/tracker/{entryId}/retry` | Retry one entry (reason required) | operator |
| POST | `/delivery-runs/{runId}/cancel` | Cancel remaining queued entries | operator |
| POST | `/inputs/{entryId}/upload` | Upload the required manual input file for a `WAITING_ON_INPUT` entry | operator |
| POST | `/inputs/{entryId}/acknowledge` | Acknowledge a manual file drop (file already placed in the folder) | operator |
| GET | `/sponsors` · POST `/sponsors` · PUT `/sponsors/{code}` | Sponsor management | admin |
| GET | `/flagships` · POST `/flagships` | Flagship management | admin |
| GET | `/sponsor-models` · POST `/sponsor-models` | Sponsor model onboarding/termination | operator |
| GET | `/delivery-schedules` · PUT `/delivery-schedules/{id}` | Delivery schedule (rebalance calendar) management | operator |
| GET | `/compliance-checks` | Compliance results, filter by run/entry/result | compliance_officer |
| POST | `/compliance-checks/{checkId}/decision` | Approve/override a compliance alert (audited) | compliance_officer |
| GET | `/dispatches` · GET `/dispatches/{id}` | Dispatch status incl. dead letters | viewer |
| POST | `/dispatches/{id}/redrive` | Re-queue a dead-lettered dispatch | operator |
| GET | `/metrics/dashboard` | KPI bundle for Command Center | viewer |
| GET | `/metrics/delivery-runs/{runId}` | Run-scoped stats | viewer |
| GET | `/events` | Global event stream explorer | viewer |
| POST | `/notifications` | Manual notification trigger | operator |
| GET | `/streams/delivery-runs/{runId}` | SSE live progress stream | viewer |
| POST | `/callbacks/dispatch/{dispatchId}` | Dispatch engine callback: ack / delivery receipt / failure | engine |

### 7.2 Sample Payloads

**Trigger a delivery run**
```json
POST /api/v1/delivery-runs
Idempotency-Key: 8f2c9a1e-0001-4b3e-9c2d-aa11bb22cc33
{
  "runType": "REBALANCE",
  "region": "na",
  "triggerSource": "scheduler",
  "scheduleId": "a1b2c3d4-...",
  "overrideCompliance": false,
  "note": "August quarterly cycle"
}
```

**Delivery run summary**
```json
GET /api/v1/delivery-runs/DR-2026-08-04-001
{
  "runId": "DR-2026-08-04-001",
  "status": "RUNNING",
  "progressPct": 82.4,
  "counts": { "total": 34, "completed": 28, "inProgress": 4, "failed": 2 },
  "timeline": { "scheduledAt": "2026-08-04T16:00:00Z", "startedAt": "2026-08-04T16:01:12Z" },
  "kpis": { "cycleTime": "2h 14m", "slaAttainment": 98.4 },
  "stages": {
    "FETCHING": 2, "VALIDATED": 1, "COMPLIANCE_PENDING": 1,
    "DISPATCH_QUEUED": 1, "DISPATCHED": 1, "DELIVERED": 28
  }
}
```

**Failure detail**
```json
GET /api/v1/delivery-runs/DR-2026-08-04-001/tracker/9c8d7e6f-...
{
  "entryId": "9c8d7e6f-...",
  "modelCode": "M_SMA_MOD4927-EN_EM",
  "sponsorCode": "Envestnet",
  "state": "FAILED",
  "progressPct": 70,
  "attempts": 3,
  "error": {
    "code": "BUILD_TIMEOUT",
    "category": "BUILD",
    "reason": "Manifest build exceeded 30m SLA window",
    "lastErrorAt": "2026-08-04T18:44:02Z"
  },
  "slaDueAt": "2026-08-04T20:00:00Z",
  "nextAction": "RETRY_OR_ESCALATE"
}
```

**Dispatch engine callback (webhook)**
```json
POST /api/v1/callbacks/dispatch/DSP-8841
{
  "event": "DELIVERY_RECEIPT",
  "dispatchId": "DSP-8841",
  "state": "DELIVERED",
  "receivedAt": "2026-08-04T19:12:00Z",
  "receiptRef": "engine-receipt-00912",
  "traceId": "abc-123"
}
```

### 7.3 Streaming & Events

- `GET /streams/delivery-runs/{runId}` — Server-Sent Events pushing every entry state change to the UI (progress bars update live).
- Dispatch engines call back via `POST /callbacks/dispatch/{dispatchId}` with `ACKED`, `DELIVERED`, or `FAILED` + structured reason.
- Every mutation is also published to the event bus for consumers: metrics collectors, notification service, Y-Charts historical loaders.

---

## 8. UI Design — Platform Console

A React SPA, role-aware, region-aware. All pages consume `/api/v1` and live-update via SSE.

### 8.1 Command Center (Dashboard)
The landing page — answers "how is distribution doing right now?"
- **KPI cards**: runs in flight, deliveries today, success rate (24h), failed entries (24h), dead letters, avg cycle time, SLA attainment.
- **Charts**: deliveries by region (bar), success vs failure trend (line), failure reasons (pie), cycle time trend (line), volume by sponsor (table).
- **Alerts panel**: active alerts (dead letters, compliance alerts awaiting decision, escalated entries).
- **Live feed**: recent events across all runs.

### 8.2 Delivery Runs
- List of runs with status chips, progress bars, region/type filters, date range, search.
- Row actions: view, retry failed, cancel. Sortable by status/progress/started-at.
- Click-through to Delivery Run Detail.

### 8.3 Delivery Run Detail
The operational heart of the platform.
- **Header**: run code, status, trigger source, timeline (scheduled → started → completed), overall progress ring.
- **Stage distribution**: stacked bar of entries per state.
- **Entries table**: model, sponsor, state chip, progress %, attempts, error code, SLA clock, actions (retry, view events).
- **Live event stream**: append-only transitions with actor + trace id.
- **Compliance panel**: check results with pass/alert counts; alert entries link to Compliance Center.
- **Dispatches panel**: dispatch states, dead-letter count, redrive buttons.
- **Manifests panel**: built files with checksums and download links (Stage Store).

### 8.4 Delivery History
- Searchable, filterable history of **every delivery ever made** (append-only), sourced from the `event_log`.
- Filters: sponsor, region, model, date, state, error category.
- Drill-down into any historical delivery → its events, dispatch, manifest, compliance checks.
- Export to CSV/Excel for downstream reporting.

### 8.5 Sponsors
- Sponsor registry: create/suspend/update sponsors, file templates, contacts, escalation config.
- Sponsor detail: models onboarded, delivery schedule, delivery history, success rate per sponsor.

### 8.6 Flagships & Sponsor Models
- Manage flagship models (versions, status) and sponsor models (onboard/terminate, persist flags, intraday inclusion).
- Model detail: which sponsor, which flagship, delivery stats.

### 8.7 Compliance Center
- Compliance rule definitions and results.
- **Decisions queue**: compliance alerts awaiting a compliance officer's approve/override, with full context (positions, thresholds) and mandatory decision note.
- History: pass/alert/fail counts per rule, per model, over time.

### 8.8 Failure & Retry Center
- Failed entries and dead-letter dispatches in one place.
- Filters: error category, retry count, age.
- Bulk retry with reason, redrive dead letters, escalation status.
- Failure trends: top error codes by week (chart).

### 8.9 Reports & Metrics
- Scheduled/on-demand reports: delivery stats, sponsor SLAs, volume trends, compliance results.
- Export formats: CSV, Excel, PDF. Report history.

### 8.10 Delivery Schedule & Rebalance Calendar
- Calendar view of upcoming runs per delivery schedule.
- Coverage check: which models/sponsors are missing a delivery schedule.
- Manual trigger for ad-hoc runs with compliance override options (audited).

### 8.11 Audit & Events
- Explorer over the append-only event log.
- Filters by aggregate, actor, event type, time; raw payload viewer with trace id.

### 8.12 Admin
- Users, roles (VIEWER / OPERATOR / COMPLIANCE_OFFICER / ADMIN), notification channels, integrations (engine endpoints, CRD adapters), alert thresholds.

---

## 9. Stats, Progress & Failure Tracking — Summary

| Capability | Delivered by |
|-----------|--------------|
| Live progress per entry and per run | State machine + progress mapping + SSE stream |
| Run KPIs (success rate, cycle time, SLA) | `metric` + `/metrics/*` |
| Failure tracking with taxonomy | `error_code`/`error_category` on entries + dispatches |
| Retry automation | Retry sweeper on `(state, next_retry_at)` + backoff policy |
| Dead-letter handling | `DEAD_LETTER` state + redrive + escalation |
| Alerting | Thresholds → `notification` → email/chat/webhook |
| Audit trail | `event_log` append-only log on every transition |
| Compliance oversight | `compliance_check` + decisions queue |
| Delivery receipts | Dispatch engine callbacks → `DELIVERED` + receipt ref |
| History & reporting | Delivery History page (event log) + Reports page |

---

## 10. Non-Functional & Security

- **Idempotency**: idempotency keys on all commands; duplicate triggers collapse to the same delivery run.
- **Retries**: transient failures auto-retry with exponential backoff; permanent failures go to Dead Letter immediately.
- **Security**: local user store with hashed passwords (bcrypt/argon2) issuing signed JWTs, RBAC scopes per endpoint, mTLS between platform ↔ engines, secrets in a vault, all human decisions audited. IdP-backed SSO is a supported later option.
- **Observability**: structured logs, OpenTelemetry traces (`trace_id` on every event), metrics to the Metrics Store.
- **Resilience**: dispatch engine outages never lose data — dispatches persist in `QUEUED` and sweep forward.
- **Data integrity**: manifests carry checksums; event log is immutable (append-only, no updates/deletes).
- **Backup/DR**: point-in-time recovery for PostgreSQL, versioned Stage Store, cross-region replication for critical regions. Archived event batches are checksummed and replicated with the Stage Store.

---

## 11. Delivery Phases

| Phase | Scope |
|-------|-------|
| **1. Platform Core** | Event store, state machine, run/entry orchestration, CRD adapter contract, dispatch contract, callbacks. |
| **2. API + Console MVP** | `/api/v1` delivery-run & entry APIs, Command Center, Delivery Runs list + Run Detail, failure/retry basics. |
| **3. Stats & Compliance** | Metrics pipeline, dashboard KPIs, Compliance Center with decisions, SSE live progress. |
| **4. Sponsor Platform** | Sponsor registry, flagships/sponsor models, Delivery Log, Reports, delivery schedule calendar. |
| **5. Hardening** | Escalation, alerting channels, DR, performance tuning, SLA reporting, user acceptance. |

---

## 12. Glossary

| Term | Meaning | Example |
|------|---------|---------|
| **SMA** | Separately Managed Account — a managed portfolio held by an individual investor. | A $100,000 account managed to a model. |
| **Sponsor** | An external recipient of sponsor model files. | `Envestnet` receives monthly files. |
| **Flagship model** | A master model that sponsor models are derived from. | `M_SMA_MODIEF`. |
| **Sponsor model** | The model variant delivered to a specific sponsor. | `M_SMA_MOD4927-EN_EM`. |
| **Delivery run** | One complete distribution cycle tracked from trigger to delivery. | `DR-2026-08-04-001` delivers 34 files to 12 sponsors. |
| **Delivery log entry** | One model-for-one-sponsor unit of work inside a run. | "Deliver Envestnet's variant of the flagship." |
| **Stage** | A named step an entry passes through; drives progress %. | `COMPLIANCE_PENDING` means the compliance check has not finished. |
| **Compliance check** | An automated rule an entry must pass. | "Max 10% weight per position" — an entry at 12% raises a compliance alert. |
| **Dispatch** | The record of handing a built file to an external engine. | Dispatch `DSP-8841` was sent and later acknowledged. |
| **Manifest** | The packaged file plus metadata (checksum, contents, format). | `ENVESTNET-20260804.zip` has a manifest listing its 3 files. |
| **Delivery schedule** | The recurring calendar that decides when runs happen. | Envestnet recalculates on a quarterly schedule. |
| **CRD** | Charles River Development — the Source of Record for model data. | The CRD gateway the adapter pulls from. |
| **Corporate action** | An event that changes a security's fundamentals (merger, split, delisting). | A 2-for-1 split triggers a delivery run. |
| **Y-Charts historical file** | Historical model/security data for analytics reporting. | 36 months of monthly positions per model. |
| **Dead Letter** | A failed dispatch parked after exhausting retries, awaiting human review. | Parked with `ENGINE_UNREACHABLE` after 3 attempts. |
| **Cycle Time** | Time from run start to final delivery. | 2h 14m. |
| **SLA Attainment** | Share of deliveries meeting their deadline. | 98.4% delivered within the 4-hour window. |
| **Stage Store** | Object storage for files and manifests. | `s3://stage-store/runs/DR-001/...` |
| **RBAC** | Role-based access control — who may view, run, or decide. | A compliance officer can approve overrides; a viewer cannot. |
