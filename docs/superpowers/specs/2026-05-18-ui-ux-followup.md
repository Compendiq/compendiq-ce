# UI/UX follow-up — May 18, 2026

Date: 2026-05-18
Audited build: live dev `compendiq-ee-frontend-1` (CE frontend image) at `localhost:8081`, then verified the changes against `vite` (HEAD on `dev` + this branch).
Browser: Chromium (Playwright MCP), 1440×900 viewport, Graphite Honey theme.

Re-walk of the May-17 audit found the AI Assistant route still carrying the worst of the unresolved items: tiny mode-tab labels, a honey-filled active tab competing with honey CTAs in every mode's input bar, a `Think` toggle whose off-state collapsed into a plain label, and the global Pages tree still mounted on `/ai*` and `/settings*` despite both routes having their own left rail.

## What this PR ships

### 1. Body font: Inter Variable → IBM Plex Sans Variable

Inter is a perfectly competent UI sans, but for a Confluence-replacement KB sitting next to code blocks and IDs all day, Plex's slightly taller x-height (~3% over Inter at the same nominal size) and its mildly industrial character — short-tail `R`, single-storey `g` option, distinctly squared terminals on `a` / `e` — give body copy more "this is a system, not a marketing page" feel. The disambiguated `l / I / 1` pairs are still clean. Same delivery as Inter (`@fontsource-variable/ibm-plex-sans` → CSS-only import, self-hosted, privacy-safe), so the swap is one import + one token.

Files: `frontend/package.json`, `frontend/src/index.css`.

### 2. Base font 15 px → 16 px

The May-17 audit recommended this and the prior PR deferred it. Landing the bump now lifts every `rem`-based class by ~6.7 %, which retires the 10 px / 11.25 px outliers in one shot:

| Element                                      | Before     | After      |
| -------------------------------------------- | ---------- | ---------- |
| Top-nav segment pills                        | 11.25 px   | 13 px      |
| Stat-card labels                             | 11.25 px   | 13 px      |
| Sidebar footer ("2 pages in INFRASTRUKTUR")  | 10 px      | 11.5 px (still small but no longer sub-12 on the live `text-xs`) |
| Body copy / muted helper text                | 13.125 px  | 14 px      |
| H1 (Newsreader 700)                          | 22.5 px    | 24 px      |

`--font-size-xs` lifted from `0.8rem` → `0.8125rem` (13 px) to match.

Files: `frontend/src/index.css`.

### 3. AI page — mode tablist

- Type size: `text-xs` → `text-sm` (14 px now, 13 px after rem rebase counts).
- Active state: solid honey-filled pill → inset card with a `ring-1 ring-primary/35` and `text-primary-ink`. The brand link is retained; the saturated honey block is gone, which means the **single** honey block on screen is the primary CTA (Send / Improve Page / Generate / etc.) in the input bar. No more two competing yellows.
- Tablist wrapper got a subtle inset surface (`bg-foreground/[0.04]` + `rounded-lg p-1`) so the tabs read as a group rather than five floating buttons.
- Icon size bumped 13 px → 14 px to match the new text size.

Files: `frontend/src/features/ai/AiAssistantPage.tsx`.

### 4. AI page — model select, sub-page, Think toggle

All three rendered as text-with-icon at rest, which made it impossible to tell at a glance that they were toggles / dropdowns. Each one now carries a 1 px resting border (`border-border/40`) plus its active-state tint (`primary` for Sub-pages, `purple` for Think). Affordance is now visible without hover. Type bumped to `text-xs` (13 px on the new 16 px base — still small but legible, was 11.25 px).

Files: `frontend/src/features/ai/AiAssistantPage.tsx`.

### 5. AI page — empty state

The 44 px muted-grey `<Bot>` icon read as "page failed to load". Now it sits inside a 64 px circle on a soft `bg-primary/10 blur-2xl` aura — same robot, but legibly "ready to help". Title bumped `text-base` → `text-lg`, max-width on the subtitle lifted `max-w-sm` → `max-w-md` so the two-line break doesn't fall after the second word.

Files: `frontend/src/features/ai/AiAssistantPage.tsx`.

### 6. AI page — example prompts

`nm-card-interactive` ships a heavy two-layer shadow (`6px 6px 14px` outer + warm highlight). Five of those in a 2×2 grid above a flat composer made the prompts feel more important than the composer they're supposed to feed. Swapped for a lighter `border + bg-foreground/[0.03]` card with a `hover:border-primary/40` skim. The Sparkles glyph dims to 80 % opacity at rest and snaps to full primary on hover so the cards still feel interactive.

Files: `frontend/src/features/ai/modes/AskMode.tsx`.

### 7. Pages tree hidden on `/ai*` and `/settings*` (H4 from May-17)

Both routes own a left rail (mode tablist on AI; section nav on Settings). Mounting the Pages tree on top of either left two rails fighting for the same horizontal real estate. `AppLayout` now gates `<SidebarTreeView>` with a route check; the mobile slide-over remains available on those routes.

Test updated to reflect the new behaviour (was asserting "tree visible on all routes"; now asserts "hidden on `/ai*` and `/settings*`").

Files: `frontend/src/shared/components/layout/AppLayout.tsx`, `frontend/src/shared/components/layout/AppLayout.test.tsx`.

## Verification

- `npm run typecheck -w frontend` — clean.
- `npm test -w frontend -- src/features/ai src/shared/components/layout/AppLayout.test` — 194 / 194 pass (full AI feature + AppLayout coverage).
- Full `npm test -w frontend` — 2077 / 2077 pass. One test suite (`ComplianceReportsTab.test.tsx`) fails to **load** with `TypeError: REPORT_IDS is not iterable` — reproduces on a clean `dev` checkout, predates this branch, unrelated to font / layout work.
- Live verification: ran `vite` against the EE backend on port 3052, navigated to `/login`. Confirmed `html { font-size: 16px }`, body resolves to `IBM Plex Sans Variable`, `h1` to `Newsreader Variable` at 24 px. `/ai` redirects to `/setup` when unauthenticated (expected); did not log in to verify the AI surface manually — relying on the 27 AI-feature Vitest cases for behaviour and on visual review of the unauthenticated screens.

## What's still open (deferred for follow-ups)

These were flagged in the May-17 audit and remain unaddressed in this PR:

- H3 (dual "Pages" label on the root dashboard)
- H6 (the active segment-nav pill on the sidebar uses honey-filled, still competing with honey CTAs — same fix recipe as the AI tablist would resolve this)
- H7 (mobile KPI card label truncation on Embedding Coverage)
- Pluralisation: "1 pages in INFRASTRUKTUR" — string lives in `SidebarTreeView`
- Stat-card icon system mismatch (ring with % inside vs. flat icon)
- Light-theme filter placeholders look identical to active values
- Article page: "Properties" rail rendering with one-line "No headings in this article." negative content
- Article page: tag/badge pills have five different visual treatments in a single row

These are mostly local component-level fixes; bundling them into one "consistency pass" PR would let them ship together with a single regression review rather than five drips.
