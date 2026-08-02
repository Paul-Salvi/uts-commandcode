# Model Delivery Tool — Project Reference

**Status**: Pre-build / validation stage
**Target customer**: Boutique SMA model strategist firms distributing to TAMPs (SMArtX is the target validation ecosystem, but MVP delivery is sponsor-agnostic — see Section 2.3)
**Business goal**: Prove 5-10 paying customers at $300-800/mo before expanding scope

---

## 0. Why this document is scoped the way it is

This is deliberately **not** a full enterprise model-delivery platform. It is scoped for a solo builder, 10-20 hrs/week, to reach a working MVP in weeks, not months, and to be sold to firms with no internal engineering team — not to multi-billion-dollar asset managers with compliance departments.

Anything that smells like "enterprise feature" (rule engines, EMEA/cross-border compliance, corporate action automation, data warehousing, SSO/LDAP, dual-approval workflows) is explicitly deferred to **Phase 3+** and is *not* part of the MVP. Resist scope creep here — that's the single biggest risk to this ever shipping.

---

## 1. Problem Statement

Boutique asset managers who distribute model portfolios to one or more TAMPs/sponsors currently do this manually: reformatting spreadsheets, uploading through each platform's portal, and keeping no central record of what was sent, when, or whether it landed. This is slow, error-prone, and has no audit trail if a sponsor claims they never received an update.

## 1a. Architecture: Three Verticals

The system is organized into three independent modules, each with a single responsibility. Data
flows one direction: **Data Imports → (informed by) Sponsor & Delivery Config → Distribution
Service → Sponsor Platform.** No circular dependencies between them — this is what keeps the MVP
swappable and extensible without a rewrite.

| Vertical | Responsibility | MVP-thin slice |
|---|---|---|
| **1. Data Imports** | Get a model's target weights from the strategist into the system, validated and normalized | CSV/Excel upload only, single format |
| **2. Sponsor & Delivery Config** | Control plane — who you deliver to and how, held as configuration | Any sponsor name, file-format wizard only (columns, decimals, CSV/Excel) — no SFTP/SMB/API config in MVP |
| **3. Distribution Service** | Runtime — executes delivery using output of 1 + config from 2, logs everything | Generates the formatted file and serves it as a download link, logs the generation event |

Each vertical should know nothing about the internals of the others — Data Imports doesn't know
about sponsors, Sponsor Config doesn't touch actual model data, Distribution Service is the only
place they meet. This separation is a code-organization principle for the MVP, not a license to
build each vertical at full depth — see Section 2.7 for what's explicitly excluded from each.

## 2. MVP Scope (Phase 1)

**Goal**: A strategist firm can upload a model update once, configure how a given sponsor expects the file to look, and generate a correctly formatted file on demand — with a clear log of what was generated and when.

### 2.1 Feature: Model Upload *(Vertical 1: Data Imports)*
- User uploads a CSV or Excel file containing: ticker/CUSIP, target weight (%), as-of date.
- System validates: weights sum to ~100% (configurable tolerance), no duplicate tickers, all tickers resolve to known securities.
- Invalid files are rejected with a specific, readable error (not a generic failure) — e.g. "Row 14: AAPL weight is 12.5%, but total across all rows is 103.2%."

### 2.2 Feature: Security Reference Data *(Vertical 1: Data Imports)*
- Minimal internal security table (ticker, CUSIP, name) so uploaded files can be validated against known instruments.
- Manually maintainable list for MVP — no live market data feed needed yet.

### 2.3 Feature: Sponsor Setup & File Format Config *(Vertical 2: Sponsor & Delivery Config)*
- Add a sponsor by name — no credentials, no API integration required for MVP.
- File-format wizard, applied per sponsor:
  1. CSV or Excel
  2. Column mapping — for each internal field (ticker, weight, as-of date), enter the sponsor's expected column name and order
  3. Decimal places (single global setting for MVP — per-column override is Phase 2)
  4. One file per model, or one combined file across models
  5. File naming pattern (e.g. `{sponsor_name}_{model_name}_{date}`)

### 2.4 Feature: File Generation & Download *(Vertical 3: Distribution Service)*
- User selects a model + sponsor, clicks "Generate" — system renders the file using that sponsor's format config from Section 2.3.
- The generated file appears as a download link — no automatic transport in MVP, the user downloads it and sends it however they currently do (email, portal upload, etc.)
- This still removes the actual pain point validated in outreach: manual reformatting. It doesn't yet remove manual *sending* — that's Phase 2 (SFTP/SMB/API, see Section 5).

### 2.5 Feature: Generation Log & Audit Trail *(Vertical 3: Distribution Service)*
- Every file generation is logged: model, sponsor, timestamp, format config version used, filename, who generated it.
- User can view generation history per model and per sponsor.
- This is the core value proposition — "you can finally prove what was generated, in what format, and when."

### 2.6 Feature: Manual + Scheduled Generation *(Vertical 3: Distribution Service, scheduling rules from Vertical 2)*
- User can generate on demand ("generate now").
- User can optionally schedule recurring generation (e.g. "every Monday 9am") — the file is generated and the user gets an email that it's ready to download. No auto-send.

### 2.7 Feature: Basic Notification *(Vertical 3: Distribution Service)*
- Email notification when a scheduled file has been generated and is ready to download.
- No dashboard needed for MVP — email is enough at this scale.

### 2.8 Explicit Non-Goals for MVP
- No SFTP, SMB, or API delivery — download link only (all three are Phase 2, see Section 5)
- No per-sponsor API integrations of any kind, including SMArtX — file generation is sponsor-agnostic
- No compliance/rule engine
- No corporate action processing
- No EMEA/cross-border support
- No SSO, no RBAC beyond a single user login
- No historical performance reporting / YCharts-style integration
- No data warehouse — a single Postgres database is sufficient

---

## 3. Data Model (Phase 1)

Deliberately minimal. Every table here directly supports a Phase 1 feature above — nothing speculative. Grouped by owning vertical, matching Section 1a.

```sql
-- ============ Vertical 1: Data Imports ============

CREATE TABLE strategist_user (
    user_id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email           VARCHAR(255) NOT NULL UNIQUE,
    firm_name       VARCHAR(255),
    password_hash   TEXT NOT NULL,
    created_at      TIMESTAMP(6) NOT NULL DEFAULT now()
);

CREATE TABLE security (
    security_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ticker          VARCHAR(20) NOT NULL,
    cusip           VARCHAR(20),
    sec_name        VARCHAR(200),
    UNIQUE (ticker)
);

CREATE TABLE model (
    model_id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id         BIGINT NOT NULL REFERENCES strategist_user(user_id),
    model_name      VARCHAR(200) NOT NULL,
    created_at      TIMESTAMP(6) NOT NULL DEFAULT now()
);

CREATE TABLE model_weight (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    model_id        BIGINT NOT NULL REFERENCES model(model_id),
    security_id     BIGINT NOT NULL REFERENCES security(security_id),
    target_weight   NUMERIC(9,4) NOT NULL,   -- percentage, e.g. 5.2500
    as_of_date      DATE NOT NULL,
    UNIQUE (model_id, security_id, as_of_date)
);

-- ============ Vertical 2: Sponsor & Delivery Config ============

CREATE TABLE sponsor (
    sponsor_id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id         BIGINT NOT NULL REFERENCES strategist_user(user_id),
    sponsor_name    VARCHAR(150) NOT NULL,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMP(6) NOT NULL DEFAULT now()
    -- No delivery_method/credentials columns in MVP — every sponsor is
    -- FILE_MANUAL by definition until Phase 2 adds SFTP/SMB/API (see Section 5).
);

CREATE TABLE file_format_config (
    sponsor_id          BIGINT PRIMARY KEY REFERENCES sponsor(sponsor_id) ON DELETE CASCADE,
    file_type           VARCHAR(10) NOT NULL CHECK (file_type IN ('CSV','EXCEL')),
    decimal_places       SMALLINT NOT NULL DEFAULT 4,
    per_model_file       BOOLEAN NOT NULL DEFAULT TRUE,
    file_naming_pattern  VARCHAR(200) DEFAULT '{sponsor_name}_{model_name}_{date}',
    column_mapping       JSONB NOT NULL
    -- column_mapping example:
    -- [
    --   {"internal_field": "ticker",        "sponsor_column": "Symbol",  "order": 1},
    --   {"internal_field": "target_weight", "sponsor_column": "Weight%", "order": 2},
    --   {"internal_field": "as_of_date",    "sponsor_column": "AsOf",    "order": 3}
    -- ]
);

CREATE TABLE delivery_schedule (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    model_id            BIGINT NOT NULL REFERENCES model(model_id),
    sponsor_id          BIGINT NOT NULL REFERENCES sponsor(sponsor_id),
    cron_expression     VARCHAR(100),         -- null = manual only
    is_active           BOOLEAN NOT NULL DEFAULT TRUE
);

-- ============ Vertical 3: Distribution Service ============

CREATE TABLE delivery_log (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    model_id            BIGINT NOT NULL REFERENCES model(model_id),
    sponsor_id          BIGINT NOT NULL REFERENCES sponsor(sponsor_id),
    status              VARCHAR(20) NOT NULL CHECK (status IN ('GENERATED','FAILED')),
    file_name           VARCHAR(255),
    file_path           TEXT,                 -- storage location of the generated file
    downloaded_at       TIMESTAMP(6),          -- null until the user actually downloads it
    error_message       TEXT,
    generated_at        TIMESTAMP(6) NOT NULL DEFAULT now()
);
```

That's 7 tables across 3 verticals — and none of them require encrypted credential storage or an external API integration for MVP. That's a meaningfully simpler and faster build than the SMArtX-integrated version. The full-scale version of this business might eventually need dozens of tables (including credential storage once SFTP/SMB/API arrive in Phase 2) — this doesn't, yet.

---

## 4. Tech Stack (suggested, not prescriptive)

- **Backend**: Node.js or Python (whichever you're faster in) + Postgres
- **Frontend**: Minimal — a single upload/status page is enough for Phase 1. No need for a polished dashboard until you have paying customers asking for one.
- **Hosting**: Any low-cost PaaS (Render, Railway, Fly.io) — no need for enterprise infra at this stage.
- **Scheduling**: Simple cron job or a lightweight job queue — no need for a distributed scheduler yet.

### 4.1 Code Organization

One deployable app for MVP — no microservices — but organize the codebase into three folders/modules mirroring Section 1a, so the boundary is enforced by structure, not just discipline:

```
/data-imports        (Vertical 1 — upload handling, parsing, validation)
/sponsor-config       (Vertical 2 — sponsor CRUD, credentials, schedules)
/distribution         (Vertical 3 — delivery execution, retry, logging, notifications)
```

Rule of thumb: if a function in `/distribution` needs to know how a CSV was parsed, or a function in `/data-imports` needs to know a sponsor's API endpoint, the boundary has leaked — refactor before it compounds.

---

## 5. Roadmap (post-validation)

Only build these once Phase 1 has paying customers and they're specifically asking for it:

**Phase 2** (real delivery transport + multi-sponsor reliability)
- SFTP delivery — host/port/credentials, remote path, **test connection** button before saving
- SMB delivery — same pattern as SFTP, only build if a real customer's sponsor requires it
- Per-sponsor API adapters (starting with SMArtX, since you already know its API) — built as a pluggable adapter per sponsor, not a generic "configure any API" wizard, since every sponsor's API is genuinely different
- Per-column decimal-place overrides and live file preview in the format wizard
- Retry logic for failed deliveries
- Simple web dashboard replacing email-only notifications
- Multi-user support per firm (not just one login)

**Phase 3** (scale + compliance, only if you're chasing larger customers)
- Configurable compliance checks (concentration limits, restricted lists) — customer-configured, not hardcoded
- Drift/reconciliation reporting
- Role-based access control
- Audit log retention policy aligned to customer's own regulatory requirements

**Explicitly out of scope indefinitely, unless a specific paying customer requires it and pays for the build:**
- EMEA/cross-border operations
- Corporate action automation
- Data warehouse / historical performance analytics integrations

---

## 6. Success Criteria

- **Validation**: 3+ boutique firms confirm this matches a real, current pain point (from outreach calls)
- **MVP**: 1 paying customer successfully generating correctly formatted sponsor files through the tool, even though they still send the file manually
- **Traction**: 5-10 paying customers at $300-800/mo (~$1.5K-8K MRR) before considering Phase 2
- **Do not build Phase 2 or 3 features speculatively** — let paying customer requests drive scope, not this roadmap
