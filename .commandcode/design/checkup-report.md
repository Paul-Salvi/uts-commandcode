# Checkup Report — Ledger (uts-ui)

**Mode:** `/design checkup` · **Date:** 2026-08-05 · **Score: 41 / 60**

**Verdict:** WATCH — strong, coherent foundation with real product fidelity, but two classes of issues block a clean ship: primary-CTA contrast failures and keyboard gaps on the core table interactions.

## TL;DR

The app is a genuinely intentional product surface — custom tokens, a three-font data/display/body system, a teal-and-mint accent that refuses the generic SaaS palette, consistent status semantics, and honest empty/loading/error states. The single biggest visual defect is that every primary action button pairs white text with a mint (`--accent #5dcaa5`, ~2:1) or teal (`--signal #0e9488`, ~3.7:1) background — both fail WCAG AA for the 13–14px labels they carry. The second is that the comparison-heavy surfaces (model rows, run rows, sponsor group headers) are clickable `<tr>` elements with no keyboard path, so keyboard users cannot open a model detail or a run detail at all.

## Heuristic Scores

| # | Heuristic | Score | Key Finding |
|---|---|---|---|
| 1 | Intentionality | 9/10 | Custom tokens, distinctive type trio, teal/mint accent; internal "VERTICAL N ·" labels leak into user-facing chrome |
| 2 | Readability | 5/10 | White-on-mint (~2:1) and white-on-teal (~3.7:1) CTA labels fail contrast; heavy use of 11–12px mono text |
| 3 | Usability | 8/10 | Import → configure → deliver path is complete, confirm-guarded, with empty states and remove/cancel undo paths |
| 4 | Responsiveness | 6/10 | Tables scroll, drawer shell is solid; all inputs/selects sit at 13–14px, triggering iOS Safari zoom-on-focus |
| 5 | Speed | 9/10 | Self-hosted fonts, server-component data flow, skeleton loading, transform/opacity-only animation |
| 6 | Accessibility | 4/10 | Clickable `<tr>` rows have no keyboard path; modals lack focus trap/restore; `outline-none` + border-only focus indication |

## Cognitive Load / Risk

- **PASS** — Consistent status semantics: green = delivered/valid, red = failed, amber = pending/in-progress, grey = cancelled. Always text-backed, never color-only.
- **PASS** — Every list surface has an empty state that teaches the next action, and destructive/irreversible actions route through confirm dialogs.
- **WATCH** — Tracker and run pages show RUNNING/PARTIALLY_COMPLETED states only on manual Refresh; no polling, so "live" states go stale.
- **WATCH** — All form controls rely on `outline-none` + border-color change for focus; no visible ring or offset, weak for keyboard users and indistinguishable to color-blind users.
- **FAIL** — Core comparison tasks (open model detail, open run detail) are unreachable by keyboard.

## Next Modes

- `/design recolor` — fix CTA contrast (darken accent, or swap label to the existing `--on-signal` ink)
- `/design interaction` — keyboard row activation, modal focus trap, focus-visible rings
- `/design responsive` — 16px inputs on narrow screens (iOS zoom)
- `/design voice` — replace internal "VERTICAL N ·" breadcrumb labels

## What's Working

- **A real design system.** Custom tokens in `globals.css`, Space Grotesk / Inter / IBM Plex Mono as a deliberate display-body-data trio, and shared primitives (`PageHeader`, `InlineStatBar`, `ModalShell`, `ConfirmDialog`) used consistently across all 15 routes.
- **Composition matches the work.** This is a compare/operate surface — sponsor-grouped tables with expandable rows, stat bars, progress bars, and download actions. The shapes support the scanning the domain needs.
- **A responsive shell done right.** Fixed sidebar collapses, mobile drawer has focus management, escape-close, backdrop, and body scroll lock; `prefers-reduced-motion` is respected globally.

## Priority Issues

### P0 — Primary CTA labels fail contrast
- **Evidence:** Every `bg-accent` button uses `text-ink` (white on `#5dcaa5`, ≈2:1); every `bg-signal` button uses white on `#0e9488` (≈3.7:1). These are the main actions: Upload models, Generate now, Initiate delivery, Sign in, Create Sponsor, Get early access.
- **Why it matters:** The most important action on every screen is the least legible one; 13–14px medium text at sub-4.5:1 fails WCAG AA and reads muddy on bright displays.
- **FIX:** Darken the label to the existing `--on-signal` ink (`#062622`) or deepen both roles toward a 4.5:1 pair. `/design recolor`.

### P1 — Clickable rows have no keyboard path
- **Evidence:** `ModelsTable`, `DeliveryRunsList`, and the sponsor-group rows are `<tr onClick>` with no `tabIndex`, role, or key handler.
- **Why it matters:** A keyboard user cannot open a model's positions/weight detail or a delivery run's progress — the two central comparison tasks of the product.
- **FIX:** Make each row a real link or add `tabIndex={0}` + `role="link"` + Enter/Space handling, or move the action to an accessible affordance in the row. `/design interaction`.

### P1 — Modals have no focus management
- **Evidence:** `ModalShell` (used by `ConfirmDialog`, `ModelDetailModal`, `ImportResultModal`, sponsor forms) sets `role="dialog" aria-modal` and closes on Escape, but never moves focus in, traps it, or restores it to the trigger.
- **Why it matters:** Screen-reader and keyboard users can tab behind the overlay; focus restoration is absent after close.
- **FIX:** Focus the dialog on open, trap Tab within it, restore focus to the opener on close. `/design interaction`.

### P2 — Focus indication is border-only
- **Evidence:** All inputs/selects (`LoginForm`, `ModelsTable`, `SponsorsOverview`, `FileFormatConfigWizard`, etc.) use `outline-none` with only `focus:border-signal`.
- **Why it matters:** A 1px border-color change is the entire focus signal — invisible at a glance, indistinguishable for color-blind users.
- **FIX:** Replace with a visible ring: `focus-visible:ring-2 ring-signal ring-offset-2`. `/design interaction`.

### P2 — Inputs below 16px trigger iOS zoom
- **Evidence:** Every text input and select across the app is `text-sm` (14px) or `text-[13px]`, including login, search, and sponsor config forms.
- **Why it matters:** On iOS Safari, focusing a sub-16px control auto-zooms the viewport and breaks layout mid-task.
- **FIX:** Set form controls to at least 16px on screens under 640px (`text-base sm:text-sm` pattern). `/design responsive`.

### P2 — Internal labels in user-facing chrome
- **Evidence:** Page breadcrumbs read "VERTICAL 1 · DATA IMPORTS", "VERTICAL 2 · SPONSOR & DELIVERY CONFIG", "VERTICAL 3 · DISTRIBUTION SERVICE".
- **Why it matters:** Internal vertical nomenclature is meaningless to the operator and undermines the otherwise tight, domain-accurate copy.
- **FIX:** Replace with human section names (e.g. "DATA · MODELS"). `/design voice`.
