---
name: Compendiq
description: Calm, dense, flat workspace over Confluence — Graphite and Paper, one Steel accent.
colors:
  primary: "#86aec8"
  primary-paper: "#3f627c"
  primary-foreground: "#07131f"
  primary-foreground-paper: "#ffffff"
  canvas-graphite: "#09090a"
  chrome-graphite: "#0c0c0d"
  workspace-graphite: "#0f0f10"
  pane-graphite: "#161617"
  raised-graphite: "#1b1b1d"
  ink-graphite: "#e7e9eb"
  muted-ink-graphite: "#a0a4aa"
  border-graphite: "#222225"
  border-interactive-graphite: "#7c7c85"
  hover-graphite: "#1c1d1d"
  pressed-graphite: "#212226"
  selected-graphite: "#282a2e"
  canvas-paper: "#f0efed"
  chrome-paper: "#f5f5f4"
  workspace-paper: "#f8f8f7"
  pane-paper: "#ffffff"
  raised-paper: "#ffffff"
  ink-paper: "#191918"
  muted-ink-paper: "#686866"
  border-paper: "#efeeec"
  border-interactive-paper: "#838281"
  hover-paper: "#f6f6f5"
  pressed-paper: "#f0f0ef"
  selected-paper: "#ebebea"
  login-ground-paper: "#fafaf9"
  ai-graphite: "#c084fc"
  success-graphite: "#4ade80"
  warning-graphite: "#fbbf24"
  danger-graphite: "#f87171"
  danger-foreground-graphite: "#1a0f0f"
  info-graphite: "#b2c3ff"
  inactive-graphite: "#979aa3"
  ai-paper: "#7041a8"
  success-paper: "#007544"
  warning-paper: "#80590f"
  danger-paper: "#bc3031"
  info-paper: "#2a3977"
  inactive-paper: "#5c5c5a"
typography:
  display:
    fontFamily: "Inter Variable, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Inter Variable, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.011em"
  title:
    fontFamily: "Inter Variable, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.35
  body:
    fontFamily: "Inter Variable, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Inter Variable, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 500
    lineHeight: "1.25rem"
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  xl: "10px"
  shell-md: "12px"
  shell-xl: "14px"
spacing:
  control-y: "6px"
  control-x: "12px"
  input-x: "10px"
  inset-md: "12px"
  inset-xl: "16px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "6px 12px"
    height: "32px"
  button-primary-paper:
    backgroundColor: "{colors.primary-paper}"
    textColor: "{colors.primary-foreground-paper}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "6px 12px"
    height: "32px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink-graphite}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "6px 12px"
    height: "32px"
  button-destructive:
    backgroundColor: "{colors.danger-graphite}"
    textColor: "{colors.danger-foreground-graphite}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "6px 12px"
    height: "32px"
  input:
    backgroundColor: "{colors.pane-graphite}"
    textColor: "{colors.ink-graphite}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "6px 10px"
    height: "32px"
  card:
    backgroundColor: "{colors.pane-graphite}"
    textColor: "{colors.ink-graphite}"
    rounded: "{rounded.lg}"
    padding: "16px"
  card-elevated:
    backgroundColor: "{colors.raised-graphite}"
    textColor: "{colors.ink-graphite}"
    rounded: "{rounded.lg}"
  pill-active:
    backgroundColor: "{colors.pane-graphite}"
    textColor: "{colors.ink-graphite}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
  nav-selection:
    backgroundColor: "{colors.selected-graphite}"
    textColor: "{colors.ink-graphite}"
---

# Design System: Compendiq

## Overview

**Creative North Star: "The Flat Instrument"**

Compendiq is a calibrated workspace, not a room and not a brand film. Linear sets the bar for timing, keyboard coverage and type scale; Plane for calm neutral surfaces and row density; Notion for the document surface. The standing preference is the category convention executed at full fidelity — a first-rate modern workspace application, without irony, pastiche or smuggled quirk.

Hierarchy comes from the eight-role surface ladder, type weight, and space. Motion is a 120ms `ease-out` colour change on state, never entrance choreography. Brand lives in Workspace Steel, in the interactive edge, and in what is refused: no lift, no gradient fill, no in-page glass, no colour as the only channel for state.

Two themes are a product requirement. Graphite (`:root`) is the dark instrument; Paper is the light one. Neither is a fallback. Default follows the OS; a manual override persists per user.

**Key Characteristics:**

- One workhorse face (Inter Variable); JetBrains Mono only for code and data figures.
- One accent (Workspace Steel) for brand mark, primary action, links, active nav, and focus ring.
- Flat in-page surfaces; the only shadow is the overlay recipe; floating chrome may frost.
- 32px controls, 13px label floor, 44px header, dense 13–14px rows.
- WCAG 2.1 AA measured from tokens; `forced-colors` and `prefers-reduced-transparency` are load-bearing.

## Colors

Workspace Steel is the single brand and interaction accent. Semantic hues are reserved signals, not alternate accents. Neutrals do the spatial work.

### Primary

- **Workspace Steel** (`primary` Graphite / `primary-paper` Paper): brand mark, primary buttons, links, active nav, focus ring. One hue means "you can act." Graphite Steel clears AA as text on every dark surface, so fill and ink are the same value (`primary`). Paper Steel is dark enough to be fill and text on white, so it needs no separate ink sibling. Ink on the Steel fill is `primary-foreground` / `primary-foreground-paper`.

### Neutral

Eight production roles (ADR-010). Graphite first, Paper sibling second.

- **Canvas** (`canvas-graphite` / `canvas-paper`): viewport gutter, destination rail, top app header. Draws the workspace card by value, not by a line.
- **Chrome** (`chrome-graphite` / `chrome-paper`): internal panel-header bands that still need a strip (Library results headers). Not the outer frame.
- **Workspace** (`workspace-graphite` / `workspace-paper`): shell fill inside the card; Graphite navigation/AI rail ground.
- **Pane** (`pane-graphite` / `pane-paper`): document, left navigation, context rail. Paper Pane is pure white.
- **Raised** (`raised-graphite` / `raised-paper`): overlay fill. Paper Raised matches Pane; separation is shadow plus interactive edge.
- **Ink** (`ink-graphite` / `ink-paper`): body and control text.
- **Muted ink** (`muted-ink-graphite` / `muted-ink-paper`): secondary labels, measured against the worst surface they land on. Paper muted ink on Canvas is the binding 4.5:1 case for 12px rail labels.
- **Border** (`border-graphite` / `border-paper`): structural hairline. Quiet. Never an operable edge.
- **Interactive border** (`border-interactive-graphite` / `border-interactive-paper`): visible edge of anything you can operate, and the overlay edge. Clears WCAG 1.4.11 (3:1) on every ground it appears on.
- **Hover / Pressed / Selected** (`hover-*` / `pressed-*` / `selected-*`): three distinct state fills. Selected is the deepest and persists; hover must never paint as selected.
- **Login ground** (`login-ground-paper`; Graphite uses Canvas): Paper-only split so the login halo can be measured without the grey frame.

### Semantic (not accents)

- **AI violet** (`ai-graphite` / `ai-paper`): AI surfaces only.
- **Success / connected** (`success-*`): healthy, connected, ok.
- **Warning / syncing** (`warning-*`): amber is reserved for warning and attention.
- **Danger / disconnected** (`danger-*`): failure and destructive actions.
- **Info indigo** (`info-*`): passive notices only — not a state, not a chip, never an affordance. Separated from Steel and AI in lightness so CVD simulation does not collapse them.
- **Inactive** (`inactive-*`): idle status. Embedding is not a hue: it resolves to body ink plus a progress affordance.

**The One Accent Rule.** Workspace Steel is brand and every actionable affordance. A second interactive hue is a bug.

**The Second Channel Rule.** Colour is never the only channel for state. Every status also carries an icon, shape, or accessible name. Links are underlined, not merely Steel.

**The Status Reservation Rule.** Violet, amber, green, and red are signals. They are not alternate accents and not category colour.

## Typography

**Display Font:** Inter Variable (system-ui sans fallback). `--font-display` is an alias onto the same stack.
**Body Font:** Inter Variable (same stack).
**Label/Mono Font:** JetBrains Mono Variable — code blocks and every data figure (counts, percentages, IDs).

**Character:** One workhorse face. A workspace heading is a wayfinding label, not editorial; a second display family at 15–20px costs legibility without buying identity. Hierarchy is size, weight, and space.

### Hierarchy

- **Display** (600, 1.5rem, tracking -0.02em): page and panel titles in the workspace. Login heroes may go larger (up to ~4.5rem, tracking no tighter than -0.04em) without introducing a second family.
- **Headline** (600, 1.125rem, tracking -0.011em): section titles, prose headings.
- **Title** (600, 1rem): card and topology titles.
- **Body** (400, 0.875rem, line-height 1.5): reading copy. Prose measure 65–75ch where it is actually prose.
- **Label** (500, 0.8125rem / 13px, line-height 1.25rem): buttons, inputs, nav pills, stat labels. This is the control voice.

Users may swap the application face or the reading-pane face (Atkinson Hyperlegible, Source Serif 4, and others). The system default remains Inter.

**The One Voice Rule.** Inter carries display and body. Do not introduce a display serif or a geometric headline face for "product UI personality."

**The Thirteen Floor Rule.** `text-xs` is 13px (0.8125rem). Do not ship 11px nav pills or stat labels.

## Layout

The shell is an inset card on Canvas. Destinations live on the left chassis; the workspace card is held off the frame by inset and radius, not by a hairline. Do not put the hairline back: retune Canvas if the card stops reading as a card.

- **Mobile:** edge-to-edge (`inset` 0, shell radius 0). Header 44px (`2.75rem`). Destination rail width is header height + 30px.
- **md (768px):** 12px inset, 12px shell radius, 4px rail gap.
- **xl (1280px):** 16px inset, 14px shell radius, 6px rail gap. Do not invent a third breakpoint ladder.

Left navigation, document pane, and context rail share Pane. The top header, destination rail, and bottom rail paint Canvas so the outer frame is one colour. Paper document, left nav, and context rail are pure white.

Density is Plane-like: tight groups, generous separation, more space above a heading than below it. Controls are 32px tall so a button, an input, and a 28px toolbar chip share one row.

Login is not a workspace surface. It has no tree, no document, no dense rows. It uses `login-ground-paper` (Paper) or Canvas (Graphite) and may paint the measured halo.

**The Unlined Card Rule.** The workspace card, context rail, and content panes are unlined. Canvas is the boundary. Structural hairlines that remain are separators inside content (document tables use a stronger `--doc-rule`), not frames around the work.

## Elevation & Depth

Lead with the tonal ladder (Canvas → Chrome → Workspace → Pane → Raised). In-page surfaces are flat: a value step plus a 1px hairline. A shadow on something that never leaves the page is the tell that the flat system was not committed to.

Raised is what leaves the page. Dialogs and opaque overlays use the Raised fill, the interactive edge, and `--shadow-overlay`. Floating popovers, dropdowns, and HUDs add overlay glass: 12px blur, 90% Raised fill in Graphite / 82% in Paper, rim at 18% of the interactive edge. `prefers-reduced-transparency` strips blur and translucency; the edge and shadow remain. The inspector tab bar is a true overlay (absolute, 42% fill, 20px blur) so content can scroll underneath.

### Shadow Vocabulary

- **Overlay** (`0 8px 24px -6px rgba(0,0,0,0.6), 0 2px 6px -2px rgba(0,0,0,0.4)` Graphite; `0 6px 16px -4px rgba(23,22,21,0.16), 0 2px 5px -2px rgba(23,22,21,0.12)` Paper): popovers, dialogs, command palette, toasts, glass HUDs. Offset and soft. Not a halo.
- **Overlay small** (shallower sibling): Library's in-flow search surface, the one in-page exception, without a simultaneous border.

### Named exceptions

- **Login halo.** The one declared in-page decoration: primary (or AI violet) disc at opacity 0.08, 120px blur, `z-index: -10`. Measured so muted hero ink still clears 4.5:1 on the composite. Ceiling 0.08; 0.12 breaches. Nowhere else.

**The Overlay-Only Shadow Rule.** In-flow surfaces cast nothing. `--shadow-overlay` is for things that leave the page.

**The In-Page Glass Ban.** `backdrop-filter` on an in-page pane is decoration standing in for hierarchy. Glass is `nm-popover-glass` (and the inspector overlay override) only.

## Shapes

Workspace corners are tight because the rows are dense. The retired neumorphic scale (20/12/8/4) read as pillows; 10/8/6/4 is the range.

- **xl (10px):** overlay glass. Top of the workspace scale.
- **lg (8px):** in-page cards, composer (a container, not a 32px control).
- **md (6px):** buttons, inputs, toolbar chips.
- **sm (4px):** active pills inside a segmented track.

Shell radius (12px at md, 14px at xl) is the outer card only. Controls never inherit it.

Borders are 1px. Operable surfaces use the interactive token; chrome uses the quiet hairline. `forced-colors: active` restates a 2px `ButtonText` border on the same components because shadow is discarded.

**The Workspace Radius Rule.** 10 / 8 / 6 / 4. A 16px+ corner on a 32px control is the old pillow.

## Components

Dense and operable. 32px controls, 13px labels, interactive edge ≥3:1, no lift on hover. A row of actions is toolbar-shaped, not a card of buttons.

### Buttons

- **Shape:** 6px corners (`rounded.md`), 32px tall, padding 6×12px, 13px / 500.
- **Primary:** Workspace Steel fill, matching 1px Steel edge (so `forced-colors` cannot drop the boundary), ink `primary-foreground`. Hover mixes 88% Steel with foreground; active 78%. No lift, no glow, no growing shadow.
- **Ghost / secondary:** transparent fill, interactive edge, ink. Hover is the hover state fill, not Steel — a secondary action that borrows the accent competes with the primary beside it.
- **Destructive:** danger fill, same box metrics as primary. Hover darkens; no glow.
- **Icon button:** 32px, transparent, muted ink at rest; hover uses the hover fill.
- **Focus:** 2px Steel outline, 2px offset, transparent outline at rest.
- **Disabled:** opacity 0.45, no pointer.

Transition 120ms `ease-out` on colour (and opacity). Never `translateY` or scale.

### Chips

- **Active pill:** Pane fill on a muted track, interactive edge, ink, weight 500, 4px corners. The fill is a step up from the track; do not swap it for the selected-row fill (that measured worse against the group).
- **Filter / tag chips:** same outlined language as ghost, not miniature primary buttons.

### Cards / Containers

- **In-page card:** 8px corners, Pane fill, quiet hairline, no shadow. Prominence from position, spacing, and heading weight.
- **Elevated overlay:** 8px corners, Raised fill, interactive edge, overlay shadow. Dialogs stay opaque.
- **Glass overlay:** 10px corners, translucent Raised, 12px blur, overlay shadow. Popovers, HUDs, the login sign-in card (it floats over the halo).
- **Internal padding:** 16–24px on a content card; 6–12px on chrome.

### Inputs / Fields

- **Style:** flat Pane fill, 6px corners, interactive edge, 13px text, 32px tall. The inset well is gone; a flat system says "type here" with a border and a placeholder.
- **Focus:** border to Steel plus a 1px Steel ring tight to the border — not a 2px halo bleeding off an inset.
- **Placeholder:** muted ink.
- **Disabled:** opacity 0.45.
- **Composer exception:** the chat/prompt wrapper uses the quiet hairline at rest (owner exception, 2026-08-31). Focus still goes Steel. Do not copy that resting border onto `nm-input`, `nm-select`, or buttons.

### Navigation

- **Destination rail:** on Canvas. 12px labels in muted ink (Paper: 4.56:1 on Canvas — do not grey the frame without darkening muted ink first). Hover and current destination are ink plus a Steel marker line, never a fill on the rail.
- **Trees / settings lists:** selected row uses the selected fill, weight 500, and a 1px interactive outline (the outline is what survives `forced-colors`). Hover is the hover fill — never the selected fill.
- **Header:** 44px, Canvas, continuous with the rail and floor.

### Overlay glass (signature)

The material that leaves the page. 12px blur, 82–90% Raised, rim at 18% interactive edge, overlay shadow. Inspector tab bar is heavier frost (20px, 42% fill) because it is a sticky overlay over scrolling content. Login `AuthPanel` uses this surface because it floats over the halo.

## Do's and Don'ts

### Do:

- **Do** use Workspace Steel for brand, primary action, links, active nav, and focus — one hue.
- **Do** underline links; do not rely on Steel alone.
- **Do** pair every status hue with an icon, shape, or accessible name.
- **Do** keep in-page surfaces flat: value step plus hairline.
- **Do** put `--shadow-overlay` only on overlays; put glass only on `nm-popover-glass` (and the inspector overlay).
- **Do** size controls to 32px and labels to 13px.
- **Do** change state in 120ms `ease-out` colour, not motion toward the cursor.
- **Do** honour `prefers-reduced-transparency` (opaque fill, no blur) and `forced-colors` (2px system borders).
- **Do** measure contrast from the token file. Retune a surface and the guard re-measures.

### Don't:

- **Don't** lift, scale, or grow a shadow on hover. That is the neumorphic tell.
- **Don't** paint gradient fills. Steel start and end are the same value on purpose.
- **Don't** put glass or `backdrop-blur` on in-page chrome.
- **Don't** use colour as the only channel for state.
- **Don't** use Steel for embedding, telemetry, or idle pipeline status.
- **Don't** use AI violet, amber, green, or red as decorative accents.
- **Don't** frame the workspace card with a hairline; Canvas is the boundary.
- **Don't** copy the composer's quiet resting border onto inputs or buttons.
- **Don't** introduce a second display face for workspace UI.
- **Don't** ship text smaller than 13px in chrome.
