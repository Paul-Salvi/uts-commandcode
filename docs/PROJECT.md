# Model Delivery Tool — Project Reference

**Status**: Pre-build / validation stage
**Target customer**: Boutique SMA model strategist firms distributing to TAMPs (starting with SMArtX)
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
| **2. Sponsor & Delivery Config** | Control plane — who you deliver to and how, held as configuration | SMArtX only, hardcoded, one delivery channel (API) |
| **3. Distribution Service** | Runtime — executes delivery using output of 1 + config from 2, logs everything | Manual + basic scheduled push, delivery log, email notification |

Each vertical should know nothing about the internals of the others — Data Imports doesn't know
about sponsors, Sponsor Config doesn't touch actual model data, Distribution Service is the only
place they meet. This separation is a code-organization principle for the MVP, not a license to
build each vertical at full depth — see Section 2.7 for what's explicitly excluded from each.

## 2. MVP Scope (Phase 1)

**Goal**: A strategist firm can upload a model update once and have it validated, delivered to SMArtX via API, and logged — with a clear record of what was sent and confirmation it arrived.

### 2.1 Feature: Model Upload *(Vertical 1: Data Imports)*
- User uploads a CSV or Excel file containing: ticker/CUSIP, target weight (%), as-of date.
- System validates: weights sum to ~100% (configurable tolerance), no duplicate tickers, all tickers resolve to known securities.
- Invalid files are rejected with a specific, readable error (not a generic failure) — e.g. "Row 14: AAPL weight is 12.5%, but total across all rows is 103.2%."

### 2.2 Feature: Security Reference Data *(Vertical 1: Data Imports)*
- Minimal internal security table (ticker, CUSIP, name) so uploaded files can be validated against known instruments.
- Manually maintainable list for MVP — no live market data feed needed yet.

### 2.3 Feature: Sponsor Delivery (SMArtX only, Phase 1) *(Vertical 2: Sponsor & Delivery Config + Vertical 3: Distribution Service)*
- Single, hardcoded integration: push validated model weights to SMArtX via their API.
- Store SMArtX credentials securely (encrypted at rest, never logged in plaintext). — *config, owned by Vertical 2*
- On delivery, capture: timestamp sent, payload sent, HTTP response/status, and SMArtX's confirmation if one is returned. — *execution, owned by Vertical 3*

### 2.4 Feature: Delivery Log & Audit Trail *(Vertical 3: Distribution Service)*
- Every delivery attempt (success or failure) is logged with: model, sponsor, timestamp, status, response.
- User can view delivery history per model and per sponsor.
- This is the core value proposition — "you can finally prove what you sent and when."

### 2.5 Feature: Manual + Scheduled Delivery *(Vertical 3: Distribution Service, scheduling rules from Vertical 2)*
- User can trigger delivery on demand ("send now").
- User can optionally schedule recurring delivery (e.g. "every Monday 9am") — simple cron-style scheduling, no complex calendar/holiday logic yet.

### 2.6 Feature: Basic Notification *(Vertical 3: Distribution Service)*
- Email notification on delivery success or failure.
- No dashboard needed for MVP — email is enough at this scale.

### 2.7 Explicit Non-Goals for MVP
- No compliance/rule engine
- No corporate action processing
- No multi-sponsor support (SMArtX only)
- No SFTP/SMB/custom file formats (API only)
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

CREATE TABLE sponsor_connection (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id             BIGINT NOT NULL REFERENCES strategist_user(user_id),
    sponsor_name        VARCHAR(100) NOT NULL DEFAULT 'SMArtX',
    api_credentials     TEXT NOT NULL,        -- encrypted
    is_active           BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE delivery_schedule (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    model_id            BIGINT NOT NULL REFERENCES model(model_id),
    sponsor_connection_id BIGINT NOT NULL REFERENCES sponsor_connection(id),
    cron_expression     VARCHAR(100),         -- null = manual only
    is_active           BOOLEAN NOT NULL DEFAULT TRUE
);

-- ============ Vertical 3: Distribution Service ============

CREATE TABLE delivery_log (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    model_id            BIGINT NOT NULL REFERENCES model(model_id),
    sponsor_connection_id BIGINT NOT NULL REFERENCES sponsor_connection(id),
    status              VARCHAR(20) NOT NULL CHECK (status IN ('SUCCESS','FAILED','PENDING')),
    request_payload     JSONB,
    response_payload    JSONB,
    error_message       TEXT,
    attempted_at        TIMESTAMP(6) NOT NULL DEFAULT now()
);
```

That's 7 tables across 3 verticals. The full-scale version of this business might eventually need dozens — this doesn't, yet.

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

**Phase 2** (multi-sponsor + reliability)
- Additional sponsor integrations (Orion, GeoWealth, Altruist) — driven by what customers actually ask for
- SFTP and email delivery channels for sponsors without APIs
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
- **MVP**: 1 paying customer successfully delivering models to SMArtX through the tool
- **Traction**: 5-10 paying customers at $300-800/mo (~$1.5K-8K MRR) before considering Phase 2
- **Do not build Phase 2 or 3 features speculatively** — let paying customer requests drive scope, not this roadmap
