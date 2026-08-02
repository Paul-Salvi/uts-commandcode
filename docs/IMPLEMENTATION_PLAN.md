# Implementation Plan

**Reference docs**: `PROJECT.md` (MVP scope) · `PROJECT_FULL_SCOPE.md` (target state) · `AGENTS.md` (build discipline)

**Assumption**: 10-20 hrs/week, solo, SMArtX API experience already in hand.

---

## Step 0 — Before any code (do this first, not in parallel)

This isn't optional and it isn't step 1 alongside building — it comes strictly before.

- [ ] Send the 15-20 outreach emails to the SMArtX boutique-firm list
- [ ] Get on 3-5 calls, ask how they currently push model updates, listen for the pain pattern
- [ ] Go/no-go decision: do at least 2-3 firms independently describe the exact pain this tool solves? If not, revisit before building.

**Do not proceed to Week 1 until this step has real signal.** Everything below assumes it did.

---

## Weeks 1-2 — Vertical 1: Data Imports (thin slice)

Goal: a strategist can upload a file and get back a validated, normalized model.

- [ ] `security` and `model` / `model_weight` tables (see `PROJECT.md` Section 3)
- [ ] CSV/Excel parser — accept the two formats you're most likely to actually receive from your first validation calls (ask on the calls, don't guess)
- [ ] Validation rules: weights sum to ~100% (configurable tolerance), ticker resolution against `security`, duplicate detection
- [ ] Specific, row-level error messages on failed validation
- [ ] Basic auth (`strategist_user` table, login) — just enough to scope data per firm

**Definition of done**: you can upload a real (or realistic sample) CSV and see it land in the database as clean rows, or get a readable rejection reason.

---

## Weeks 3-4 — Vertical 2: Sponsor & Delivery Config (thin slice)

Goal: SMArtX connection details exist as configuration, not hardcoded secrets sprinkled through the codebase.

- [ ] `sponsor_connection` table, encrypted credential storage
- [ ] SMArtX API auth flow — this is the part your prior experience shortens significantly
- [ ] `delivery_schedule` table — manual-only is fine to start (`cron_expression` can stay null for every row in week 3-4)
- [ ] Simple settings screen: enter/update SMArtX credentials

**Definition of done**: credentials are stored encrypted, retrievable by the app, and you can make one successful authenticated test call to SMArtX's API using stored config — not hardcoded values.

---

## Weeks 5-6 — Vertical 3: Distribution Service (thin slice)

Goal: close the loop — take a validated model, push it to SMArtX, log the result.

- [ ] `delivery_log` table
- [ ] Manual "send now" flow: model + sponsor_connection → SMArtX API call → log request/response/status
- [ ] Delivery history view (even a plain table on a page is fine — no dashboard polish yet)
- [ ] Email notification on success/failure
- [ ] Basic scheduled delivery (cron job checking `delivery_schedule` rows)

**Definition of done**: a full end-to-end cycle — upload CSV, validate, click send, see it land in SMArtX (sandbox or real), see the log entry, get the email.

---

## Week 7 — Dogfood + first real customer

- [ ] Run your own test data through the full flow end to end, multiple times, deliberately trying to break it (bad CSV, expired credentials, SMArtX downtime)
- [ ] Go back to whichever call-back firm showed the most interest in Step 0 — offer them the actual tool
- [ ] Get one real firm delivering one real model through it

**Definition of done**: 1 paying or pilot customer using the tool for a real delivery, not a demo.

---

## After Week 7 — Do not pre-build Phase 2/3

Per `PROJECT.md` Section 6 and `AGENTS.md`'s Scope Discipline section: the next feature you build should be whatever your first 1-3 real customers actually ask for, pulled from `PROJECT_FULL_SCOPE.md`'s menu — not built ahead of demand. Common first asks worth watching for:

- A second sponsor platform → Vertical 2 gets a second `sponsor_connection` type, Vertical 3 gets a second delivery adapter
- SFTP or email delivery (sponsor without a usable API) → new delivery channel in Vertical 3 only — Verticals 1 and 2 shouldn't need to change
- A real dashboard instead of a plain history table → Vertical 3, presentation layer only

If a request doesn't map cleanly onto one vertical without touching the others, that's worth pausing on — it may mean the boundary needs rethinking, not just more code.

---

## Time Check

7 weeks at 10-20 hrs/week is roughly 70-140 hours to a working MVP with one real customer. That's the target to hold yourself to — if any single vertical is running more than 2 weeks over, that's a signal you've let scope creep in from the full-scope doc. Go back to the "MVP-thin slice" column in `PROJECT.md` Section 1a and cut back to it.
