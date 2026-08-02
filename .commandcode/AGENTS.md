# Memory

## Project Overview

This workspace contains **two separate repositories** that form the Smooth Pay platform — a financial operations system for agencies running game rooms with pay-in/pay-out flows.

### [smooth-pay](./smooth-pay/) — .NET Backend API
- **Language/Runtime**: .NET 10 (C#)
- **Architecture**: Clean/Onion architecture with 10 projects
- **Stack**: ASP.NET Core 10, EF Core 8 + Npgsql (PostgreSQL), JWT Bearer auth, BCrypt, FluentValidation, xUnit
- **Entry point**: `src/SP.Host.Api` — composition root, HTTP API, middleware, controllers
- **Solution file**: `SP.slnx`
- **Domain**: `PS.Core` — pure domain entities, services, policies, exceptions
- **Persistence**: `PS.Plugin.Postgres` — EF Core DbContext, repositories, migrations
- **Payment adapters**: `PS.Adapter.DollarPay`, `PS.Adapter.Nexapay`, `PS.Adapter.Mock` (all stubs currently)
- **Tests**: `PS.Test.Unit` (6 test files), `PS.Test.Integration` (empty)
- **Key commands**: `dotnet build`, `dotnet test tests/PS.Test.Unit`


### [smooth-pay-ui](./smooth-pay-ui/) — Next.js Frontend
- **Language/Runtime**: TypeScript (strict), Node.js (npm)
- **Stack**: Next.js 16 (App Router), React 19, Tailwind CSS v4, shadcn/ui, TanStack Query v5, Zustand v5, React Hook Form + Zod v4, Vitest + MSW, Playwright
- **Structure**: Feature-sliced under `/src/features/` (auth, agencies, dashboard, game-rooms, platforms, employees, platform-users, wallet)
- **API client**: Auto-generated via `openapi-typescript` from the backend's OpenAPI spec
- **Design system**: "Ledger" — light-first, Geist Sans/Mono, mobile-first at `lg` breakpoint
- **Key commands**: `npm run dev`, `npm run build`, `npm run test:run`, `npm run gen:api`
- **Status**: Phases 0-3 complete (scaffolding, auth/shell, agencies/org-structure, wallet/ledger/platform-users). Phases 4-10 not started.

### Relationship
- `smooth-pay-ui` consumes `smooth-pay`'s REST API at `localhost:8080`
- API types are auto-generated from `GET /openapi/v1.json` via `npm run gen:api`
- Both are built in parallel phases (0-10), with the UI depending on backend endpoints
- Known backend gaps exist — see `smooth-pay-ui/docs/UI_IMPLEMENTATION_PLAN.md` for details

## User Roles
- **Admin** — oversees agencies (create, approve, suspend, provision agents)
- **Agent** — manages game rooms, platforms, employees, and wallet
- **Employee** — manages platform users and views wallet/ledger

## Code Style Guidelines
- Use descriptive variable names
- Follow existing patterns in the codebase
- Extract complex conditions into meaningful boolean variables

## Architecture Notes
- Each repo has its own `.commandcode/AGENTS.md` with full project-specific architecture docs — read those for detailed guidance before working on either project.
- The backend lives in `./smooth-pay/`, the frontend in `./smooth-pay-ui/`.
- Both repos are independent — they're not in a monorepo. Open the specific project root when working in it.
- A **coordinator agent** lives at `.commandcode/agents/payment-platform-coordinator.md` — use it for cross-cutting features that touch both repos. It delegates to `dotnet-platform-architect` (backend) and `react-ui-platform-architect` (frontend).

## Common Workflows

### Running locally
- **Backend**: `cd smooth-pay && dotnet run --project src/SP.Host.Api` (Postgres must be running)
- **Frontend**: `cd smooth-pay-ui && npm run dev` (on port 3000, proxies to backend on 8080)

### Development guidance
- Read the repo's `.commandcode/AGENTS.md` first — it contains detailed architecture, conventions, and workflow instructions
- For the backend, also check `.github/skills/platform-architecture-standards/SKILL.md` for engineering standards
- For the frontend, check `docs/UI_IMPLEMENTATION_PLAN.md` for phase roadmap and known backend gaps
- See `docs/PAYMENT-WORKFLOWS.md` for the complete pay-in and payout transaction lifecycles, including status state machines, API flows, fee models, and key file references for both repos

## Database Schema (Persistence Layer)

All 17 tables live in PostgreSQL. EF Core entity classes are in `PS.Plugin.Postgres/Entities/` with configuration in `AppDbContext.cs`. Each has a matching domain entity in `PS.Core/Entities/` that adds validation and behavior. The EF entity stores enum values as lowercase strings (`HasConversion<string>()`) while the domain entity uses C# enums.

### Users & Auth — 4 tables

**`admins`** — `PS.Plugin.Postgres.Entities.AdminEntity`
| Column | Type | Constraints |
|--------|------|------------|
| id | uuid | PK |
| username | varchar(100) | NOT NULL, UNIQUE |
| password_hash | varchar(255) | NOT NULL |
| email | varchar(255) | NOT NULL, UNIQUE |
| phone | varchar(50) | nullable |
| two_factor_enabled | boolean | NOT NULL, default true |
| status | varchar(20) | NOT NULL, default 'active' |
| created_at | timestamp | NOT NULL |
| updated_at | timestamp | NOT NULL |

**`agencies`** — `PS.Plugin.Postgres.Entities.AgencyEntity` — status: `pending`, `active`, `suspended`
| Column | Type | Constraints |
|--------|------|------------|
| id | uuid | PK |
| legal_name | varchar(255) | NOT NULL |
| display_name | varchar(255) | NOT NULL |
| contact_email | varchar(255) | NOT NULL |
| contact_phone | varchar(50) | nullable |
| country | varchar(100) | nullable |
| default_settlement_currency | varchar(10) | NOT NULL, default 'USD' |
| kyb_document_url | text | nullable |
| status | varchar(20) | NOT NULL |
| created_by_admin_id | uuid | NOT NULL → admins.id |
| created_at | timestamp | NOT NULL |
| updated_at | timestamp | NOT NULL |

**`agents`** — `PS.Plugin.Postgres.Entities.AgentEntity` — status: `active`, `suspended`
| Column | Type | Constraints |
|--------|------|------------|
| id | uuid | PK |
| agency_id | uuid | NOT NULL → agencies.id |
| username | varchar(100) | NOT NULL, UNIQUE |
| password_hash | varchar(255) | NOT NULL |
| email | varchar(255) | nullable |
| phone | varchar(50) | nullable |
| two_factor_enabled | boolean | NOT NULL, default true |
| status | varchar(20) | NOT NULL |
| force_password_reset | boolean | NOT NULL, default true |
| created_at | timestamp | NOT NULL |
| updated_at | timestamp | NOT NULL |

**`employees`** — `PS.Plugin.Postgres.Entities.EmployeeEntity` — status: `active`, `suspended`
| Column | Type | Constraints |
|--------|------|------------|
| id | uuid | PK |
| agency_id | uuid | NOT NULL → agencies.id |
| game_room_id | uuid | NOT NULL → game_rooms.id |
| username | varchar(100) | NOT NULL, UNIQUE |
| password_hash | varchar(255) | NOT NULL |
| email | varchar(255) | nullable |
| phone | varchar(50) | nullable |
| status | varchar(20) | NOT NULL |
| force_password_reset | boolean | NOT NULL, default true |
| created_by_agent_id | uuid | NOT NULL → agents.id |
| created_at | timestamp | NOT NULL |
| updated_at | timestamp | NOT NULL |

### Structure — 3 tables

**`game_rooms`** — `PS.Plugin.Postgres.Entities.GameRoomEntity` — status: `active`, `inactive`
| Column | Type | Constraints |
|--------|------|------------|
| id | uuid | PK |
| agency_id | uuid | NOT NULL → agencies.id |
| name | varchar(255) | NOT NULL, UNIQUE per agency |
| status | varchar(20) | NOT NULL |
| created_by_agent_id | uuid | NOT NULL → agents.id |
| created_at | timestamp | NOT NULL |
| updated_at | timestamp | NOT NULL |

**`platforms`** — `PS.Plugin.Postgres.Entities.PlatformEntity` — status: `active`, `inactive`
| Column | Type | Constraints |
|--------|------|------------|
| id | uuid | PK |
| agency_id | uuid | NOT NULL → agencies.id |
| name | varchar(255) | NOT NULL, UNIQUE per agency |
| logo_url | text | nullable |
| description | text | nullable |
| category | varchar(100) | nullable |
| status | varchar(20) | NOT NULL |
| api_key_hash | varchar(255) | nullable |
| created_at | timestamp | NOT NULL |
| updated_at | timestamp | NOT NULL |

**`game_room_platforms`** — Many-to-many join. `PS.Plugin.Postgres.Entities.GameRoomPlatformEntity`
| Column | Type | Constraints |
|--------|------|------------|
| game_room_id | uuid | composite PK → game_rooms.id |
| platform_id | uuid | composite PK → platforms.id |
| linked_at | timestamp | NOT NULL |

### Pay-In — 2 tables

**`pay_in_pages`** — `PS.Plugin.Postgres.Entities.PayInPageEntity`
| Column | Type | Constraints |
|--------|------|------------|
| id | uuid | PK |
| agency_id | uuid | NOT NULL → agencies.id |
| game_room_id | uuid | nullable |
| platform_id | uuid | nullable |
| slug | varchar(100) | NOT NULL, UNIQUE |
| title | varchar(255) | NOT NULL |
| description | varchar(500) | nullable |
| amounts_json | text | NOT NULL (JSON array of preset amounts) |
| is_active | boolean | NOT NULL, default true |
| created_by_agent_id | uuid | NOT NULL → agents.id |
| created_at | timestamp | NOT NULL |
| updated_at | timestamp | NOT NULL |

**`pay_in_payment_records`** — `PS.Plugin.Postgres.Entities.PayInPaymentRecordEntity` — status: `Pending`, `Completed`, `Failed`
| Column | Type | Constraints |
|--------|------|------------|
| id | uuid | PK |
| pay_in_page_id | uuid | NOT NULL → pay_in_pages.id |
| payer_name | varchar(200) | NOT NULL |
| comment | varchar(500) | nullable |
| amount | numeric(18,2) | NOT NULL |
| currency | varchar(10) | NOT NULL, default 'USD' |
| nexapay_payment_id | varchar(100) | nullable |
| nexapay_checkout_url | varchar(500) | nullable |
| status | varchar(20) | NOT NULL, default 'Pending' |
| created_at | timestamp | NOT NULL |

### Pay-Out — 3 tables

**`payout_requests`** — `PS.Plugin.Postgres.Entities.PayoutRequestEntity` — status (7 states): `PendingAgentApproval`, `PendingAdminApproval`, `Processing`, `Paid`, `DeniedByAgent`, `RejectedByAdmin`, `Failed`
| Column | Type | Constraints |
|--------|------|------------|
| id | uuid | PK |
| agency_id | uuid | NOT NULL → agencies.id |
| game_room_id | uuid | NOT NULL → game_rooms.id |
| created_by_employee_id | uuid | NOT NULL → employees.id |
| approved_by_agent_id | uuid | nullable → agents.id |
| approved_by_agent_at | timestamp | nullable |
| approved_by_admin_id | uuid | nullable → admins.id |
| approved_by_admin_at | timestamp | nullable |
| amount | numeric(18,2) | NOT NULL |
| currency | varchar(10) | NOT NULL, default 'USD' |
| fee_charged | numeric(18,2) | NOT NULL |
| fee_mode | varchar(20) | nullable |
| agency_markup_percent | numeric(5,2) | nullable |
| agency_markup_amount | numeric(18,2) | nullable |
| provider_fee_percent | numeric(5,2) | nullable |
| provider_fee_amount | numeric(18,2) | nullable |
| provider_fixed_amount | numeric(18,2) | nullable |
| payout_method | varchar(20) | NOT NULL (`ManualTransfer` / `Crypto`) |
| recipient_address | varchar(200) | NOT NULL |
| status | varchar(30) | NOT NULL |
| partner_txn_ref | varchar(100) | UNIQUE, nullable |
| denial_reason | varchar(500) | nullable |
| failure_reason | varchar(500) | nullable |
| transaction_hash | varchar(200) | nullable |
| matched_platform_user_id | uuid | nullable |
| payout_option_id | uuid | nullable |
| payout_option_type | varchar(50) | nullable |
| payout_option_identifier | varchar(255) | nullable |
| completed_at | timestamp | nullable |
| created_at | timestamp | NOT NULL |
| updated_at | timestamp | NOT NULL |

**`platform_users`** — `PS.Plugin.Postgres.Entities.PlatformUserEntity`
| Column | Type | Constraints |
|--------|------|------------|
| id | uuid | PK |
| game_room_id | uuid | NOT NULL → game_rooms.id |
| platform_id | uuid | NOT NULL → platforms.id |
| created_by_employee_id | uuid | NOT NULL → employees.id |
| username | varchar(150) | NOT NULL, UNIQUE per (game_room, platform) |
| contact_email | varchar(255) | nullable |
| contact_phone | varchar(50) | nullable |
| kyc_status | varchar(50) | nullable |
| created_at | timestamp | NOT NULL |
| updated_at | timestamp | NOT NULL |

**`platform_user_payout_options`** — `PS.Plugin.Postgres.Entities.PlatformUserPayoutOptionEntity` — type: `CashPay`, `ApplePay`, `GooglePay`, `Chime`, `CashApp`
| Column | Type | Constraints |
|--------|------|------------|
| id | uuid | PK |
| platform_user_id | uuid | NOT NULL → platform_users.id |
| type | varchar(50) | NOT NULL |
| identifier | varchar(255) | NOT NULL |
| created_at | timestamp | NOT NULL |
| updated_at | timestamp | NOT NULL |

### Financial — 4 tables

**`wallets`** — Per-agency wallet (1:1). `PS.Plugin.Postgres.Entities.WalletEntity`
| Column | Type | Constraints |
|--------|------|------------|
| id | uuid | PK |
| agency_id | uuid | NOT NULL, UNIQUE → agencies.id |
| fiat_balance | numeric(18,2) | NOT NULL |
| usdc_balance | numeric(18,6) | NOT NULL |
| created_at | timestamp | NOT NULL |
| updated_at | timestamp | NOT NULL |

**`wallet_ledger_entries`** — `PS.Plugin.Postgres.Entities.WalletLedgerEntryEntity` — txn_type: `deposit`, `withdraw`, `payin`, `payout`, `fee`
| Column | Type | Constraints |
|--------|------|------------|
| id | uuid | PK |
| wallet_id | uuid | NOT NULL → wallets.id |
| txn_type | varchar(20) | NOT NULL |
| asset | varchar(10) | NOT NULL (`FIAT` / `USDC`) |
| amount | numeric(18,6) | NOT NULL |
| balance_after | numeric(18,6) | NOT NULL |
| reference_type | varchar(50) | nullable |
| reference_id | uuid | nullable |
| metadata | jsonb | nullable |
| created_at | timestamp | NOT NULL |

**`settlement_wallet`** — Single-row platform wallet. `PS.Plugin.Postgres.Entities.SettlementWalletEntity`
| Column | Type | Constraints |
|--------|------|------------|
| id | uuid | PK |
| fiat_balance | numeric(18,2) | NOT NULL |
| created_at | timestamp | NOT NULL |
| updated_at | timestamp | NOT NULL |

**`settlement_ledger_entries`** — `PS.Plugin.Postgres.Entities.SettlementLedgerEntryEntity` — direction: `In`, `Out`
| Column | Type | Constraints |
|--------|------|------------|
| id | uuid | PK |
| direction | varchar(10) | NOT NULL |
| amount | numeric(18,2) | NOT NULL |
| agency_id | uuid | NOT NULL → agencies.id |
| reference_type | varchar(100) | nullable |
| reference_id | uuid | nullable |
| status | varchar(50) | nullable |
| created_at | timestamp | NOT NULL |

### Fees & Providers — 3 tables

**`markup_fee_configs`** — `PS.Plugin.Postgres.Entities.MarkupFeeConfigEntity` — fee_mode: `Inclusive`, `Exclusive`
| Column | Type | Constraints |
|--------|------|------------|
| id | uuid | PK |
| agency_id | uuid | NOT NULL → agencies.id |
| payin_pct | numeric(5,2) | NOT NULL |
| payout_pct | numeric(5,2) | NOT NULL |
| min_fee | numeric(18,2) | nullable |
| max_fee | numeric(18,2) | nullable |
| currency | varchar(10) | NOT NULL, default 'USD' |
| fee_mode | varchar(20) | NOT NULL, default 'Inclusive' |
| effective_from | timestamp | NOT NULL |
| effective_to | timestamp | nullable |
| created_by_admin_id | uuid | NOT NULL → admins.id |
| created_at | timestamp | NOT NULL |

**`payment_providers`** — `PS.Plugin.Postgres.Entities.PaymentProviderEntity` — type: `PayIn`, `PayOut`
| Column | Type | Constraints |
|--------|------|------------|
| id | uuid | PK |
| name | varchar(255) | NOT NULL |
| type | varchar(10) | NOT NULL |
| adapter_type | varchar(100) | NOT NULL |
| is_active | boolean | NOT NULL |
| created_at | timestamp | NOT NULL |
| updated_at | timestamp | NOT NULL |

**`payment_provider_fee_rules`** — `PS.Plugin.Postgres.Entities.PaymentProviderFeeRuleEntity` — rule_type: `PerTransactionPercent`, `FixedPerTransaction`, `MonthlyFlat`, `MinFee`, `MaxFee`
| Column | Type | Constraints |
|--------|------|------------|
| id | uuid | PK |
| provider_id | uuid | NOT NULL → payment_providers.id |
| rule_type | varchar(50) | NOT NULL |
| value | numeric(18,4) | NOT NULL |
| currency | varchar(10) | NOT NULL |
| effective_from | timestamp | NOT NULL |
| effective_to | timestamp | nullable |
| created_at | timestamp | NOT NULL |

### Audit — 1 table

**`audit_logs`** — `PS.Plugin.Postgres.Entities.AuditLogEntity` — actor_type: `admin`, `agent`, `employee`
| Column | Type | Constraints |
|--------|------|------------|
| id | uuid | PK |
| actor_type | varchar(20) | NOT NULL |
| actor_id | uuid | NOT NULL |
| action | varchar(100) | NOT NULL |
| entity_type | varchar(100) | NOT NULL |
| entity_id | uuid | NOT NULL |
| before_state | jsonb | nullable |
| after_state | jsonb | nullable |
| created_at | timestamp | NOT NULL |

### Entity Relationship Summary

```
Admin ──creates──→ Agency (created_by_admin_id)
Admin ──creates──→ MarkupFeeConfig (created_by_admin_id)

Agency ──has──→ Agent (agency_id)
Agency ──has──→ GameRoom (agency_id)
Agency ──has──→ Platform (agency_id)
Agency ──has──→ Employee (agency_id)
Agency ──has──→ Wallet (agency_id, 1:1)
Agency ──has──→ MarkupFeeConfig (agency_id)
Agency ──has──→ PayInPage (agency_id)
Agency ──has──→ PayoutRequest (agency_id)
Agency ──has──→ SettlementLedgerEntry (agency_id)

Agent ──creates──→ GameRoom (created_by_agent_id)
Agent ──creates──→ Employee (created_by_agent_id)
Agent ──creates──→ PayInPage (created_by_agent_id)
Agent ──approves──→ PayoutRequest (approved_by_agent_id)

Employee ──creates──→ PayoutRequest (created_by_employee_id)
Employee ──creates──→ PlatformUser (created_by_employee_id)

Admin ──approves──→ PayoutRequest (approved_by_admin_id)

GameRoom ──has──→ Employee (game_room_id)
GameRoom ──has──→ PlatformUser (game_room_id)
GameRoom ══M─M══→ Platform (via game_room_platforms)

Platform ──has──→ PlatformUser (platform_id)
Platform ══M─M══→ GameRoom (via game_room_platforms)

PlatformUser ──has──→ PlatformUserPayoutOption (platform_user_id)
PayoutRequest ──optionally→ PlatformUser (matched_platform_user_id)

PayInPage ──has──→ PayInPaymentRecord (pay_in_page_id)
PayInPage ──optionally→ GameRoom (game_room_id, nullable)
PayInPage ──optionally→ Platform (platform_id, nullable)

Wallet ──has──→ WalletLedgerEntry (wallet_id)
SettlementWallet ──tracks──→ SettlementLedgerEntry (agency_id)

PaymentProvider ──has──→ PaymentProviderFeeRule (provider_id)
```
