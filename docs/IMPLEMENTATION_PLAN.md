# Implementation Plan — 4-Day Full-Time Sprint

**Reference docs**: `PROJECT.md` (MVP scope) · `PROJECT_FULL_SCOPE.md` (target state) · `AGENTS.md` (build discipline)

**Assumption**: full-time, ~10-12 hrs/day, solo, using Command Code as the build agent.

---

## Good news on this version of the plan

Cutting delivery down to **File (manual download) only** — no SFTP, no SMB, no per-sponsor API
integration — removes the one real external dependency (SMArtX sandbox access) and the most
time-consuming subsystems (credential storage/encryption, SFTP/SMB clients, API adapters) from
the MVP entirely. This isn't a compromise forced by the timeline — it was the right cut anyway,
since it still solves the actual validated pain point (manual reformatting) without also solving
manual sending, which can wait for real customer demand. 4 days is a realistic target for this
version, not an optimistic one.

The one thing that still doesn't compress: **a real customer using it** depends on outreach
responses, not build speed. Treat "working, deployed tool" as the Day 4 goal — a live paying
customer is a separate, parallel-track outcome.

---

## Day 1 — Vertical 1: Data Imports, all the way through

- [ ] All 7 MVP tables (`PROJECT.md` Section 3) — create the full schema once, not incrementally
- [ ] CSV/Excel upload + parser
- [ ] Validation: weight tolerance, ticker resolution, duplicates, row-level error messages
- [ ] Basic auth/login scoped per firm

**Definition of done**: upload a real CSV, get back clean rows in the DB or a specific rejection reason.

---

## Day 2 — Vertical 2: Sponsor & Delivery Config

- [ ] `sponsor` table (name only — no credentials, no delivery_method column needed yet)
- [ ] `file_format_config` table + the format wizard UI: file type (CSV/Excel), column mapping, decimal places, one-file-per-model toggle, naming pattern
- [ ] `delivery_schedule` table — manual-only is fine to start (`cron_expression` null)

**Definition of done**: create a sponsor, configure its file format, and see the config persist correctly.

---

## Day 3 — Vertical 3: Distribution Service

- [ ] File generation engine: take a validated model (Vertical 1) + a sponsor's `file_format_config` (Vertical 2) → render CSV or Excel with the mapped columns, correct decimals, correct naming
- [ ] `delivery_log` table — log every generation attempt (success or failure), with file name/path
- [ ] "Generate now" flow with a download link on success
- [ ] Generation history view (plain table is fine)
- [ ] Basic scheduled generation (cron) + email notification when a scheduled file is ready

**Definition of done**: full end-to-end cycle — upload a model, configure a sponsor's format, click generate, download a correctly formatted file, see the log entry.

---

## Day 4 — Harden, dogfood, deploy

- [ ] Deliberately break it: malformed CSV, a sponsor format with unusual column counts, empty model — confirm each produces a specific log entry and readable message, not a silent failure
- [ ] Deploy to a low-cost host (Render/Railway/Fly.io)
- [ ] Connect the landing page's email capture to something real, if not done already
- [ ] Run the full flow yourself, twice, on the deployed version — not just localhost, and actually open the generated CSV/Excel file to confirm it looks right

**Definition of done**: a deployed, working tool you could hand to a real pilot user today.

---

## After Day 4 — Phase 2 is demand-driven, not pre-built

Per `AGENTS.md` Scope Discipline: the next feature is whatever a real pilot user asks for. The
most likely first ask, based on everything scoped so far, is **"can this just send the file for
me"** — that's SFTP (Section 5 of `PROJECT_FULL_SCOPE.md`), and it's the natural Phase 2 build
once a real customer confirms file generation alone isn't enough. Don't build it before someone
asks, even though it's an easy guess for what they'll want.

---

## Time Check

This version's scope genuinely fits full-time in 4 days without the timeline risk the SMArtX-integrated
version carried. If Day 3 (the file generation engine) runs long, that's the one place worth
watching — column mapping edge cases (mismatched counts, wrong types) are where "simple" wizards
quietly grow. Keep the format config to exactly what's in `PROJECT.md` Section 2.3 — no per-column
decimal overrides, no live preview — those are explicitly Phase 2.
