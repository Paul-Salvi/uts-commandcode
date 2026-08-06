# Checkup Report — Ledger (uts-ui)

**Mode:** `/design checkup` · **Date:** 2026-08-05 · **Score: 52 / 60**

**Verdict:** HEALTHY — the interface has been through a full redesign and system passes since the original 41/60 checkup. The ledger/proof concept is coherent end to end, the contrast and keyboard gaps are closed, and the color/status/type systems are now owned by tokens. The remaining issues are contained: live states still need manual refresh, and a few one-off status/error spots bypass the new status tokens.

## TL;DR

Every critical issue from the first checkup is fixed. Primary CTAs now carry dark ink labels on green fills (AA/AAA). Keyboard users can open every model/run/sponsor detail and toggle every group. Modals trap and restore focus. All mobile inputs are ≥16px. The remaining watch items are a stale-data gap (runs/tracker update only on manual Refresh, which undercuts the "provably done" promise) and some residual hardcoded `emerald/red/amber` utility classes on inline messages and model-detail cards that haven't been migrated to the new status tokens.

## Heuristic Scores

| # | Heuristic | Score | Key Finding |
|---|---|---|---|
| 1 | Intentionality | 10/10 | Ledger/proof concept is authored end to end: paper-and-ink, ruled tables, green-ink sidebar, semantic status tokens |
| 2 | Readability | 9/10 | Ink text ~16:1, fog ~7:1, dark labels on all filled buttons; the new warm status chips hold ~4.5:1 |
| 3 | Usability | 9/10 | Import → configure → deliver path complete, confirm-guarded, empty states teach, dashboard now shows recent runs |
| 4 | Responsiveness | 9/10 | Tables scroll, drawer shell solid, all inputs ≥16px on mobile, safe-area handled, action bars wrap |
| 5 | Speed | 9/10 | Self-hosted fonts, server-component data flow, skeletons, transform/opacity-only motion |
| 6 | Accessibility | 6/10 | Keyboard rows, modal focus trap/restore, focus rings all present — but live status requires manual Refresh, and a few status spots still bypass the token system |

## Cognitive Load / Risk

- **PASS** — One authored world: the dashboard, tables, sidebar, modals, and landing page all speak the ledger language. The color system is now token-owned (action, proof, and four status roles defined once).
- **PASS** — Status semantics are consistent and text-backed: success/warning/danger/muted with the same meaning everywhere.
- **WATCH** — Tracker and run pages still show RUNNING/PARTIAL only on manual Refresh; the "provably done" promise is undercut by stale live states.
- **WATCH** — A handful of inline messages and the model-detail validity cards still use raw `emerald-*/red-*/amber-*` utilities instead of the `status-*` tokens — visually consistent, but not yet owned by the system.

## Next Modes

- `/design surface` — migrate the remaining raw status utilities to the tokens, add polling/refresh to live run states
- `/design finish` — final edge pass once polling lands

## What's Working

- **A real point of view.** The ruled account-book tables, warm paper, ink text, and green-ink sidebar tie the product to its "provably done" promise. It could not be reassigned to a random product.
- **Token-owned color and type.** Action, proof, and four status roles are defined once in `:root`; Space Grotesk / Inter / Plex Mono with tabular-nums and one `data-label` voice.
- **A hardened interaction layer.** Keyboard-activatable rows, modal focus trap + restore, visible focus rings, pressable buttons, mobile inputs ≥16px, and `prefers-reduced-motion` respected globally.

## Priority Issues

### WATCH — Live states need manual Refresh
- **Evidence:** `DeliveryTrackerClient` and `RunDetailClient` fetch on mount and on an explicit Refresh button; RUNNING/PARTIALLY_COMPLETED states go stale without user action.
- **Why it matters:** The core promise is "provably done" — a run that sits at RUNNING until the operator clicks Refresh undercuts that.
- **FIX:** Add a modest poll (or SSE later) on the tracker and run-detail pages, with the existing indeterminate progress sweep as the in-flight signal. Architecture + `/design surface`.

### WATCH — Residual raw status utilities bypass the tokens
- **Evidence:** The new `status-success/warning/danger/muted` tokens cover the status-pill maps, but inline success/error banners (UploadForm, FileFormatConfigWizard, ImportResultModal, etc.) and the model-detail validity cards still use `bg-emerald-50 text-emerald-700`, `bg-red-50 text-red-800`, `bg-amber-50` directly.
- **Why it matters:** The colors look consistent today, but the system is only partially owned — a future status-color shift means hunting down raw utilities again.
- **FIX:** Migrate the remaining inline status surfaces to the `status-*` tokens. `/design surface`.
