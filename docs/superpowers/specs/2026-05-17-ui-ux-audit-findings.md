# UI/UX Audit — May 2026

Date: 2026-05-17
Audited build: `ghcr.io/compendiq/compendiq-ce-frontend:dev` (commit 1f95263 on `dev`)
Browser: Chromium (Playwright MCP), 1440×900 + 390×844 viewports, both themes.

## What I actually did

Logged in as a fresh user (`uiaudit`), walked the **dashboard / Pages**, **Graph**, **AI Assistant (Q&A)**, **Settings → Personal → Confluence**, **Settings → Theme**, an **article detail (not-found state)**, switched between Graphite Honey (dark) and Honey Linen (light), and re-ran the dashboard at mobile width. Sampled computed font/colour/contrast for the small text classes (`.text-xs`, `.text-sm`, `.text-muted-foreground`, `p`).

## Headline issues (fix first)

### H1 — Very small UI text everywhere

Probed live values on `/`:

| Element                                      | Computed size | Notes                                   |
| -------------------------------------------- | ------------- | --------------------------------------- |
| Top-nav segment pills ("Pages / Graph / AI") | **11.25 px**  | 0.75 rem on a 15 px base                |
| Stat-card labels ("Total Articles" etc.)    | **11.25 px**  | Paired with 24 px values — large jump   |
| Sidebar footer ("1 pages in INFRASTRUKTUR") | **10 px**     | Below the 12 px floor most UIs respect  |
| ⌘K kbd hint                                  | 10 px         | OK for a chip, but matches body context |
| Body / muted helper text                     | 13.125 px     | 0.875 rem                               |
| H1 (Newsreader 700)                          | 22.5 px       | Small for a page title                  |

Base is `html { font-size: 15px }` (line 32 of `frontend/src/index.css`) — every rem-based class shrinks by 6.25%. Most "too small" complaints in this audit trace back here.

Recommendation: revert to `font-size: 16px` and lift `.text-xs` (`--font-size-xs`) from `0.8rem` → `0.8125rem` (13 px). That alone resolves the 10 px and 11.25 px outliers without touching components.

### H2 — Honey "focus ring" is on at rest

`SearchBar` (Pages dashboard) and `Ask a question…` (AI page) render with a strong honey halo *while unfocused*. It out-shouts the actual primary CTA on the same screen ("Go to Settings", "Sync"). At mobile width it becomes the loudest element on the page.

Fix: drop the honey ring to a 1 px border by default, keep the ring only on `:focus-visible`.

### H3 — Dual "Pages" labels on dashboard

The top breadcrumb shows `Pages` (chip) and the page header below shows `Pages` (h1) — the eye reads the same word twice within 80 px. On every other route the breadcrumb is the parent (`Pages > Graph`, `Pages > AI Assistant`), so this dashboard is the outlier.

Fix: hide the breadcrumb on the root `Pages` route, or rename the route header (e.g. `Knowledge Base`) so the breadcrumb still has hierarchy.

### H4 — Sidebar follows you into Settings

Settings has its own left sub-nav (`Personal / Content` with `Confluence / AI Prompts / Theme / Spaces / Sync`), but the global **Pages tree** sidebar is still mounted on the left. That gives Settings *two* left rails and ~33% of the viewport's horizontal space lost to navigation chrome. The other 60% sits empty below the form.

Fix: collapse the page-tree sidebar when route matches `/settings*` (it's not actionable from there), or replace it with a contextual "Recently viewed settings".

### H5 — Light-theme contrast holes (small text)

The light theme passes WCAG AA on body copy (rgb(95,92,84) on rgb(247,247,247) ≈ 5.76:1), but several patterns slip below:

- Stat-card labels at 11.25 px are still the muted token — fine on contrast, weak on legibility because of the size.
- "Browse and manage your knowledge base" descriptor wraps under the title at the same muted token — needs to be one shade darker, or removed.
- Filter dropdown placeholders ("All Spaces", "All Sources", "Last Modified") use the same muted token as actual selected state — you can't tell a default from a chosen value.

### H6 — Honey active-pill competes with primary CTAs

The active segment-nav pill (Pages / Graph / AI / Sidebar) uses solid honey background + honey-tinted outer glow in the latest `dev`. Honey is also the colour of every primary CTA in the system (`Go to Settings`, `New Page`, `Sync`, `Save`). When the user is on the dashboard, the honey "Pages" pill in the top-left visually competes with the honey "New Page" button in the top-right of the same page header — both shout for the same kind of attention.

Note: I initially logged this as an *inconsistency* across routes after comparing the running `compendiq-ee-frontend-1` container (older CE image) with the `/ai` page. After re-running against the latest CE dev build, the active pill is honey on *every* route — consistent, but the conflict with primary CTAs remains.

Fix: keep the active pill recognisable but desaturate it (e.g. a darker neumorphic-inset surface with a honey 2 px left-edge accent, or an outlined honey pill instead of filled). Reserve filled honey for true primary actions.

### H7 — Mobile: KPI card label truncation

At 390 px the Embedding Coverage label clips to "Embedding Co…" because the `0%` ring badge eats ~70 px on the left while the card keeps a 2-column grid. The other four cards have small icons that take ~28 px, so they fit.

Fix: stack the ring badge on top of the label inside that one card on `<sm`, or move the percentage out of the icon slot.

## Secondary issues

- **Two search bars on the dashboard**: global ⌘K bar in the top chrome and an in-page `Search pages…` field below. They search the same corpus. Keep one (in-page) and let ⌘K be the keyboard accelerator.
- **`Trash | Sync | New Page` button cluster**: `New Page` is honey primary, the others are ghost. Good. But `Trash` looks like a destructive action sitting next to a primary — promote it out of the header into the empty-state UI ("No pages — view trash" link) since you only need it when you're looking for deleted items.
- **Stat-card icon for Embedding Coverage**: ring with `0%` inside, whereas the other four cards use a flat icon. Two different visual systems in one row.
- **"1 pages" string**: pluralisation bug. Use `1 page / N pages`.
- **`Think` toggle on AI page** has no label/tooltip when not hovered — affordance is unclear.
- **Empty-state illustrations** (folder, robot, file) are 56 px and grey on near-grey — they read as "page failed to load" more than "no content yet". A subtle brand tint and a 50% size bump would help.
- **Page-detail "Article not found" empty state** shows the *same* layout chrome (Pages sidebar + Properties rail) as a real article. If the article is missing, render a centred 500-px panel with no rail.
- **Properties rail** appears for articles but contains only "No headings in this article." — that's a panel for one negative sentence. Hide the rail unless it has content.
- **Theme card actives**: the active card (Graphite Honey) carries a near-invisible "Active" chip in the corner. The honey card chrome is the only signal — bump the chip to a filled honey pill.

## Quick wins (1-day batch)

1. Base font 15 → 16 px (lifts the whole micro-typography scale).
2. Replace `--font-sans` Hanken Grotesk → **Inter Variable** (this PR).
3. Remove the honey ring-at-rest on inputs; show only on `:focus-visible`.
4. Pluralise "N page(s)".
5. Hide the global Pages tree on `/settings*` and `/ai*` routes.
6. Unify active-pill colour on AI to match Pages/Graph.

## Why Inter Variable

Replacing Hanken Grotesk with Inter Variable on body copy because:

- **Wider x-height** at the same nominal size → text *appears* ~6% larger without changing the rem scale.
- **Distinct character pairs** (`l` / `I` / `1`, `0` / `O`) — important in a knowledge-base UI surfaced near code blocks and IDs (Confluence page IDs, correlation IDs in the error dashboard).
- **Designed for screens**: Inter's hinting and OpenType feature set (cv11 for single-storey `a`, ss01 for alt `g`) make small-size paragraph copy and table rows hold up.
- Same delivery mechanism (`@fontsource-variable/inter` → CSS-only import, self-hosted, privacy-safe), same axis (`wght`), same fallback chain. Zero infrastructure change.
- Kept **Newsreader** (display serif on h1–h6) and **JetBrains Mono** (code) — both are already the right pick for their roles.

Trade-off acknowledged: this diverges from `compendiq-landing/src/styles/fonts.css` which still uses Hanken. The comment block in `index.css` already calls out the parity intent. If the landing page should follow, that's a separate change in the landing repo.

## What this PR ships

Just the font swap (H-tier item #2 from "Quick wins"). The remaining items are documented above for follow-up tickets.
