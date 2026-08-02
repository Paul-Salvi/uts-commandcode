# Model Delivery Platform — Full Enterprise Scope

**Status**: Vision / target-state architecture
**Note**: This document describes the full long-term platform. It is NOT the build order.
Recommended build sequence still starts with the MVP scope (Section 10) — treat everything
before that as the destination, not the starting point.

---

## 1. Executive Summary

The Model Delivery Platform automates the full lifecycle of investment model management for
asset managers and model strategists: generating account-level models from a source strategy,
validating them against compliance rules, and delivering them to sponsor platforms (TAMPs,
broker-dealers, custodians) through whatever channel each sponsor requires — with a complete,
auditable record of everything sent.

### Value Proposition
- **Operational efficiency**: remove manual file-wrangling and portal uploads from the daily
  rebalance process
- **Risk reduction**: catch compliance violations before delivery, not after
- **Scale**: support many sponsors and many models without proportional headcount growth
- **Auditability**: every delivery is timestamped, logged, and reconstructable for a regulator
  or a client dispute

### Architecture: Three Verticals

Every feature area below (Sections 3-9) maps to one of three verticals, matching the MVP's
module structure in `PROJECT.md` Section 1a. This mapping is the reason the MVP can grow into
this full scope without a rewrite — each vertical just gets deeper, the boundaries don't move.

| Vertical | Full-scope sections |
|---|---|
| **1. Data Imports** | 3 (Model Generation & Management) |
| **2. Sponsor & Delivery Config** | 4 (Sponsor Management), portions of 6 (Compliance rule config) |
| **3. Distribution Service** | 5 (Delivery & Distribution), 6.2-6.3 (runtime compliance checks), 7 (Corporate Actions), 8 (Reporting), 9 (Platform Operations) |

---

## 2. Business Objectives

1. **Automated model lifecycle** — from source strategy to sponsor delivery with minimal
   manual touch
2. **Compliance-by-default** — no model reaches a sponsor without passing configured checks
3. **Multi-sponsor scale** — onboard new sponsor platforms without re-architecting
4. **Operational visibility** — real-time status of what's been generated, validated, and
   delivered
5. **Sustainable growth** — support increasing model/account volume without linear cost growth

---

## 3. Feature Area: Model Generation & Management

### 3.1 Source Strategy → Account-Level Model Generation
Generate individual account models from a source/master strategy, prorating positions to each
account's size while preserving allocation integrity.

- Configurable proration tolerance (firm sets its own precision target — e.g. some firms run
  tight tolerances around fractions of a percent, others accept wider bands for smaller accounts)
- Configurable minimum position size (dollar minimum, share minimum, or both)
- Cash handling policy is configurable per firm: excess cash from fractional-share rounding can
  be swept to the largest position, held as cash up to a configurable cap, or handled by a
  custom rule

### 3.2 Batch Processing
- Process many account models concurrently
- Isolate failures — one bad account shouldn't block the batch
- Real-time batch status (queued / processing / complete / failed, per account)

### 3.3 Model Types: Static vs. Dynamic
- **Static models**: fixed target allocations that only change when a human explicitly updates
  them (the default case for most boutique strategist firms — this is what the MVP supports)
- **Dynamic models**: allocations that adjust automatically based on a defined rule set (e.g.
  volatility targeting, tactical signals, glide-path age-based allocation) — this depends on the
  Rule Engine (3.4) and is meaningfully more complex to build correctly; treat as a Phase 2+
  feature, not MVP

### 3.4 Rule Engine
- Distinct from the Compliance Engine (Section 6): this engine evaluates *model construction and
  execution* rules (e.g. "shift dynamic model X toward bonds when volatility exceeds threshold
  Y"), not regulatory/suitability rules
- Rules should be data-driven and firm-configurable, following the same principle as the
  compliance engine — no hardcoded logic requiring a code change to adjust
- Only needed once Dynamic Models (3.3) are supported — purely static-model firms can skip this
  entirely

### 3.5 Compliance Pre-Check (see Section 6 for full detail)
- No model is eligible for delivery until it passes configured compliance rules
- Non-compliant models are flagged with a specific, actionable violation reason, not a generic
  failure

---

## 4. Feature Area: Sponsor Management

### 4.1 Multi-Sponsor Configuration
- Each sponsor (TAMP, broker-dealer, custodian) has an isolated configuration: delivery
  channel, file format, schedule, credentials
- New sponsors are onboarded via a reusable configuration template, not custom code per sponsor
  — this is the single most important design principle for scaling past a handful of sponsors

### 4.1a Sponsor Model Mapping
- Sponsors frequently refer to the same model or account under their own internal code, not the
  firm's internal identifier — this mapping needs to be explicit and maintained, not assumed
- A single internal model can map to multiple sponsor-side codes (one per sponsor)
- Mapping changes (e.g. a sponsor renumbers a model) should be versioned, not overwritten, so
  historical deliveries remain traceable to the mapping that was active at the time

### 4.2 Sponsor-Specific Format Generation
- Support CSV, XML, fixed-width, and JSON output, configurable per sponsor
- Validate generated output against the sponsor's documented spec before sending, not after
- **Format wizard** (MVP starts here, per Section 5.1): file type (CSV/Excel), column mapping
  (internal field → sponsor's expected column name and order), decimal places, one-file-per-model
  vs. combined file, and file naming pattern — this is shared across File/SFTP/SMB delivery,
  since all three need the same generated file and only differ in what happens to it after

### 4.3 Delivery Calendar
- Per-sponsor delivery schedule, respecting market holidays and sponsor-specific blackout
  windows
- Missed scheduled deliveries queue for the next valid window rather than silently disappearing

---

## 5. Feature Area: Model Delivery & Distribution

### 5.1 Delivery Channels
Support whatever channel a given sponsor requires, phased by build cost — not all four are equal
effort. File, SFTP, and SMB all share one file-generation/formatting engine and only differ in
the last step (download vs. push); API is fundamentally different and requires a per-sponsor
code adapter, since there's no generic way to configure an arbitrary sponsor's API from a form.

- **File (manual download)** — MVP. Generated file appears as a download link, user sends it
  however they currently do. No credentials, no transport code required.
- **SFTP** — Phase 2. Host/port/credentials/remote path, with a **test connection** action that
  actually authenticates before the config can be saved
- **SMB** — Phase 2, only if a real sponsor requires it (uncommon among modern TAMPs)
- **REST API** — Phase 2+, one adapter per sponsor (starting with SMArtX given existing
  integration knowledge) — budget real engineering time per sponsor, this is not a config wizard

### 5.2 Scheduled + On-Demand Delivery
- Scheduled deliveries run automatically within a configured time window
- On-demand ("ad hoc") delivery available for urgent updates, subject to the same compliance
  checks as scheduled delivery — no shortcuts for urgency

### 5.3 Full vs. Incremental Delivery
- Full delivery sends the entire model
- Incremental delivery sends only changed positions since the last successful delivery —
  meaningfully reduces payload size and processing load on the sponsor side, where supported

### 5.4 Delivery Tracking & Retry
- Every delivery attempt logged: payload, timestamp, response, status
- Configurable retry policy on failure (attempt count and interval are firm-configurable, not
  fixed)
- Persistent failures escalate to a human, with a configurable escalation window

---

## 6. Feature Area: Compliance & Validation

### 6.1 Pre-Delivery Validation
- Configurable rule sets: concentration limits (security / sector / asset class), restricted
  security screening, position size bounds, and firm-specific Investment Policy Statement (IPS)
  checks
- All limits are firm-configured values, not hardcoded — a compliance officer should be able to
  adjust these without a code change

### 6.2 Outlier / Drift Detection
- Flag accounts whose actual positions have drifted meaningfully from target (threshold is
  firm-configurable)
- Daily outlier report with drill-down to the specific account and position

### 6.3 Override Workflow
- Compliance overrides require documented justification and a configurable approval chain
  (single approver for a small firm, dual approval for a larger one)
- Every override is permanently logged with who approved it and why

---

## 7. Feature Area: Corporate Actions

### 7.1 Corporate Action Ingestion
- Ingest corporate action events (splits, reverse splits, mergers, spin-offs, symbol changes)
  from whatever order-management or data provider the firm already uses
- Identify all models/accounts affected by a given event

### 7.2 Position Adjustment
- Automatic adjustment for mechanical cases (splits, symbol changes)
- Route ambiguous cases (mergers with elections, complex spin-offs) to manual review rather than
  guessing
- Full before/after snapshot retained for every adjustment

---

## 8. Feature Area: Reporting & Historical Data

### 8.1 Historical Model Snapshots
- Daily capture of model state for historical reference and performance attribution
- Immutable once finalized — corrections are a separate, audited workflow, not an overwrite

### 8.2 Performance / Reporting Integration
- Export capability to whatever third-party performance reporting platform the firm uses
- Scheduled export on a configurable cadence (many firms run this monthly)

### 8.3 Operational Reporting
- Daily processing summary, weekly delivery performance, monthly compliance exceptions —
  cadence and recipients configurable per firm

---

## 9. Feature Area: Platform Operations

### 9.1 Monitoring & Dashboard
- Real-time status of model generation, validation, and delivery across all sponsors
- Error/exception surfacing, not just success counts

### 9.1a Delivery Dashboard (sponsor-facing view)
Three distinct views, not one combined feed — users generally want to look at exactly one of
these at a time:
- **Live status**: what's currently in flight (queued / delivering / delivered / failed) — this
  is what 9.1 above already covers at a system level
- **History**: a searchable/filterable log of past deliveries, backed directly by `delivery_log`
  — this is the audit-trail value proposition made visible in the UI, not just stored in the
  database
- **Upcoming**: a forward-looking view of what's scheduled to deliver and when, driven by
  `delivery_calendar` — lets a user catch a misconfigured schedule before it causes a missed
  delivery, rather than finding out after the fact

### 9.2 Notifications
- Configurable notification rules per event type and recipient
- Critical failures notify immediately; routine status can batch into a daily digest

### 9.3 Security & Access Control
- Role-based permissions (the specific roles a firm needs will vary — define them per firm
  rather than assuming a fixed set)
- Full audit logging of user actions: who did what, when
- Encryption at rest and in transit for all sponsor credentials and any PII
- Data retention policy configurable to the firm's own regulatory obligations (this varies by
  firm type and jurisdiction — don't hardcode a retention period, let compliance set it)

### 9.4 Data Integration
- Account/security master data source (whatever system of record the firm uses)
- Market pricing source, with a fallback provider for redundancy
- Optional data warehouse export for firms that want long-term analytics separate from the
  operational database

---

## 10. Recommended Build Sequence (do not skip this)

Building all of the above at once is a 12-24+ month solo effort with zero revenue until it's
done. That is not compatible with a side-income, 10-20 hr/week goal. The features above should
be treated as a **menu, not a checklist** — build only what a paying customer has actually asked
for, in this rough order of leverage:

1. **MVP** (see the earlier `PROJECT.md` MVP scope): one sponsor, CSV in, API out, delivery log.
   Ship this, get paying customers, before touching anything below.
2. **Multi-sponsor + delivery channels** (Section 4, 5.1) — only once customers are asking to
   distribute to a second platform
3. **Compliance rule engine** (Section 6) — only once a customer's compliance officer is
   blocking a sale on it
4. **Corporate actions, historical reporting** (Section 7, 8) — later-stage, larger-customer
   features
5. **Everything in Section 9 at enterprise depth** (SSO, formal RBAC, warehouse exports) — only
   once you have a customer large enough to require it, which by definition means you're no
   longer validating, you're scaling a working business

---

## 11. Data Model (Full Scope — Target State, Not MVP)

This is the eventual shape of the schema if every feature above is built out. Build only the
tables needed for whatever phase you're actually in — do not create all of this on day one.

```sql
-- Core reference
CREATE TABLE firm_config (
    firm_id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    firm_name           TEXT NOT NULL,
    proration_tolerance NUMERIC(6,4),   -- firm-configured, no default assumed
    min_position_usd    NUMERIC(12,2),
    retention_years      SMALLINT       -- firm sets its own retention policy
);

-- Securities
CREATE TABLE security (
    security_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ticker          VARCHAR(20),
    cusip           VARCHAR(20),
    sec_name        VARCHAR(200),
    sec_type        VARCHAR(20)
);

-- Source strategy / model
CREATE TABLE source_strategy (
    strategy_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    firm_id         BIGINT REFERENCES firm_config(firm_id),
    strategy_name   VARCHAR(200) NOT NULL
);

CREATE TABLE strategy_target_weight (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    strategy_id     BIGINT REFERENCES source_strategy(strategy_id),
    security_id     BIGINT REFERENCES security(security_id),
    target_weight   NUMERIC(9,4),
    as_of_date      DATE NOT NULL
);

-- Account-level generated models
CREATE TABLE account (
    account_id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    firm_id         BIGINT REFERENCES firm_config(firm_id),
    acct_cd         VARCHAR(100) UNIQUE,
    strategy_id     BIGINT REFERENCES source_strategy(strategy_id)
);

CREATE TABLE account_model_position (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id      BIGINT REFERENCES account(account_id),
    security_id     BIGINT REFERENCES security(security_id),
    weight          NUMERIC(9,4),
    generated_at    TIMESTAMP(6) DEFAULT now()
);

-- Sponsors
CREATE TABLE sponsor (
    sponsor_id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    firm_id             BIGINT REFERENCES firm_config(firm_id),
    sponsor_name        VARCHAR(150) NOT NULL,
    delivery_channel    VARCHAR(20) CHECK (delivery_channel IN ('API','SFTP','EMAIL','FILE_SHARE')),
    file_format         VARCHAR(20),
    credentials         TEXT,              -- encrypted
    is_active           BOOLEAN DEFAULT TRUE
);

CREATE TABLE delivery_calendar (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sponsor_id      BIGINT REFERENCES sponsor(sponsor_id),
    cron_expression VARCHAR(100),
    blackout_dates  DATE[]
);

-- Delivery + audit
CREATE TABLE delivery_log (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id          BIGINT REFERENCES account(account_id),
    sponsor_id          BIGINT REFERENCES sponsor(sponsor_id),
    delivery_type       VARCHAR(20) CHECK (delivery_type IN ('FULL','INCREMENTAL')),
    status              VARCHAR(20) CHECK (status IN ('SUCCESS','FAILED','PENDING','RETRYING')),
    attempt_number      SMALLINT DEFAULT 1,
    request_payload     JSONB,
    response_payload    JSONB,
    error_message       TEXT,
    attempted_at        TIMESTAMP(6) DEFAULT now()
);

-- Compliance
CREATE TABLE compliance_rule (
    rule_id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    firm_id         BIGINT REFERENCES firm_config(firm_id),
    rule_type       VARCHAR(50),        -- e.g. 'CONCENTRATION_LIMIT', 'RESTRICTED_LIST'
    parameters      JSONB,              -- firm-configured thresholds live here
    is_active       BOOLEAN DEFAULT TRUE
);

CREATE TABLE compliance_result (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id      BIGINT REFERENCES account(account_id),
    rule_id         BIGINT REFERENCES compliance_rule(rule_id),
    passed          BOOLEAN,
    detail          TEXT,
    checked_at      TIMESTAMP(6) DEFAULT now()
);

CREATE TABLE compliance_override (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    compliance_result_id BIGINT REFERENCES compliance_result(id),
    approved_by         TEXT,
    justification       TEXT,
    approved_at         TIMESTAMP(6) DEFAULT now()
);

-- Corporate actions
CREATE TABLE corporate_action (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    security_id     BIGINT REFERENCES security(security_id),
    action_type     VARCHAR(30),   -- SPLIT, MERGER, SPIN_OFF, SYMBOL_CHANGE
    effective_date  DATE,
    details         JSONB
);

CREATE TABLE corporate_action_adjustment (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    corporate_action_id BIGINT REFERENCES corporate_action(id),
    account_id          BIGINT REFERENCES account(account_id),
    before_state        JSONB,
    after_state         JSONB,
    applied_at           TIMESTAMP(6) DEFAULT now()
);

-- Generic audit log
CREATE TABLE audit_log (
    audit_id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    table_name      TEXT NOT NULL,
    record_id       BIGINT NOT NULL,
    operation       TEXT CHECK (operation IN ('INSERT','UPDATE','DELETE')),
    old_data        JSONB,
    new_data        JSONB,
    changed_by      TEXT,
    changed_at      TIMESTAMP(6) DEFAULT now()
);
```

---

## 12. KPIs (set your own targets — examples only)

| KPI | Notes |
|---|---|
| Model generation success rate | Track failures by cause, not just a pass/fail count |
| On-time delivery rate | Define "on time" per sponsor's own SLA expectations |
| Compliance validation coverage | Should trend toward 100% of models checked pre-delivery |
| Delivery failure rate | Track by sponsor — some channels are flakier than others |
| Sponsor onboarding time | Track this as you scale sponsors, to catch process bloat early |

---

## 13. Risks

| Risk | Mitigation |
|---|---|
| Sponsor integration delays | Start integrations early, get sandbox access before committing to a delivery date |
| Compliance rule changes | Keep rules data-driven (Section 6.1) so changes don't require code deploys |
| Data quality issues | Validate at ingestion, not after delivery |
| Solo-founder bus factor | Document as you go — this file is a start, not a finish |
| Scope creep back to full enterprise build | Revisit Section 10 before adding any feature — is a paying customer actually asking for this? |

---

## 14. Note on Compliance Frameworks

If you take on institutional clients, expect them to ask about your alignment with standard
frameworks in this space (SEC recordkeeping rules, FINRA requirements, GIPS for performance
reporting, and MiFID II if you ever take on EMEA-facing clients). Treat these as **client-driven
requirements to research and satisfy when a specific client needs them**, not a checklist to
build against speculatively before anyone's asked.
