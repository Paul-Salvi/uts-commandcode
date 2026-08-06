# Review Report — Ledger (uts-ui)

**Mode:** `/design review` · **Date:** 2026-08-05 · **Score: 38 / 50**

**Verdict:** A genuinely authored redesign with a real point of view — the "ledger / proof" concept lands. The ruled account-book tables, warm paper-and-ink surface, and green-ink sidebar cohere into one world. The gaps are now in the seams and the moments the concept hasn't reached yet: a redundant header rule that fights the ledger system, a "Create Delivery" action whose icon duplicates Upload, the dashboard that doesn't yet use the ledger's ruled language, and two products-of-the-design tokens whose names no longer match their jobs.

## First Impression — 8/10

The point of view is legible in seconds. Warm paper (`#fdfcf9`), ink-black text, ruled tables with a 2px double-rule under the header, and a deep green-ink sidebar. This is a precision instrument, not another white-and-teal SaaS. It could not be reassigned to a random product by swapping the logo — the account-book language is tied to the "provably done" promise. It remembers as "the one with the ruled tables and the paper."

## Hierarchy — 7/10

The squint test passes on the table surfaces: the 2px ink header rule + zebra striping + mono data cells give a clear scan path. The header rules work. Two soft spots: the "Create Delivery" nav item uses the same Upload icon as "Import" (no visual distinction for the two different jobs), and the dashboard — the arrival surface — is still the pre-redesign composition (two plain rounded cards), so the first authenticated screen doesn't yet sell the ledger world the way the tables do.

## Color Voice — 8/10

The palette has intent and discipline. Teal `--signal` is reserved for verified/proof + focus; ledger-green `--accent` for primary action; amber/emerald/red/grey for status, always text-backed. The `--signal` teal on warm paper is a calm, trustworthy proof-mark. Contrast is strong throughout (ink text ~16:1, fog ~7:1). The one conceptual wrinkle: the token names `--signal` (teal) and `--accent` (ledger-green) no longer describe their jobs — the accent is the proof color and the signal is the action color, so the vocabulary is inverted from what the names say. No behavior breaks, but the system is harder to reason about.

## Type Voice — 8/10

The three-font system earns its place: Space Grotesk for display, Inter for body, IBM Plex Mono for data with tabular-nums so weight columns align. The `data-label` utility gives all the micro-labels one voice. The `ledger-table` header at 2px ink is a strong ruled-book detail. Body text on paper is comfortable to read.

## Interaction Feel — 7/10

The interaction work from the prior passes is intact: keyboard-activatable rows, modal focus trap + restore, focus-visible ring, mobile inputs ≥16px, pressable buttons, and reduced-motion support. The seams are: the redundant `border-b border-hairline` on every table header row (it sits under the ledger's 2px rule, so the header has a 1px hairline and a 2px ink rule fighting each other), and the single live-status gap — tracker and run pages still show RUNNING/PARTIAL only on manual Refresh, which the ledger's "proof" promise would benefit from polling.

## Smell Check

No generated tells. The palette refuses the domain default (no navy+serif fintech, no white+teal SaaS). The ruled-table composition is a real decision, not a template. The only residual generic moments are the dashboard's plain rounded cards, which are pre-redesign leftovers rather than a design choice.

## Priority Recommendations (by impact)

1. **Remove the redundant header rule** — strip `border-b border-hairline` from the 12 table header rows; the `ledger-table` thead rule already owns it. This is the most visible seam in the new system. (`/design refine` or a direct fix)
2. **Differentiate the Create Delivery action** — it duplicates the Import upload icon; give it a distinct icon (e.g. `Send` is already used by Deliveries, so something like `PlusCircle`/`FilePlus`) so the two different jobs don't read as the same. (`/design refine`)
3. **Extend the ledger language to the dashboard** — the arrival surface is still two plain cards; apply the ruled/paper treatment (or restructure to a small "proof board" of recent runs + counts) so the concept starts at login, not at the tables. (`/design relayout`)
4. **Rename the color tokens to match their jobs** — `--signal` is used as the proof/verified color and `--accent` as the action color; either swap the names or swap the values so the vocabulary matches intent. Low risk, pure clarity. (`/design recolor`)
5. **Add polling to live run/tracker states** — the "provably done" promise is undercut when a RUNNING run only updates on manual Refresh. A modest poll (or SSE later) would make the ledger feel alive. (Architecture + `/design motion`)

## What Moved The Score

First impression and color voice are the strongest — the concept is real and coherent. Hierarchy and interaction lost points to concrete seams (redundant header rule, duplicate icon, dashboard lagging behind the concept, manual-only refresh). These are all focused interventions, not a rethinking.
