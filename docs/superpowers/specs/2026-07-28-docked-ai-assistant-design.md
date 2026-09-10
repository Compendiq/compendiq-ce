# Docked AI Assistant — Design

**Date:** 2026-07-28
**Issue:** #1126 (AI context switching UX)
**Status:** Shipped, with two elements superseded — see the two amendments below.

> ## Amendment (2026-08-06, UI overhaul)
>
> **The desktop container changed; the thesis did not.** Everything below about
> the assistant being a *tool beside the document* rather than a destination
> still holds, and is still how the app behaves. What changed is the container
> at `md` and up: this spec's **third column** beside `ArticleRightPane` is
> retired, and the assistant is now the first of three **tabs** inside that
> pane (Assistant / Outline / Details).
>
> The reason is the one this spec argues from. A third column put three
> vertical rules across a 1440px window and left the document — the thing the
> route exists for — squeezed between two slabs of chrome, which is a version
> of the same "the AI competes with the work" problem the column was meant to
> solve. As a tab it switches instantly, costs no horizontal space, and there
> is one right-hand edge to learn instead of two.
>
> Consequences for readers of this document:
>
> - The dock's own width preference, resize handle and open/close spring are
>   gone. The assistant inherits the inspector pane's width and resize.
>   `ui-store`'s `aiDockWidth` is deleted.
> - `ai-dock-store.open` now means "the **mobile sheet** is up". At `md` and up
>   `AppLayout` consumes it and re-expresses it as a tab request.
> - The **bottom sheet below `md` survives exactly as specified here**, modal
>   behaviour and detents included.
> - Everything else in this spec — chips seeding one thread, `Apply` going
>   through `POST /llm/improvements/apply`, conversations keyed by page,
>   opening running nothing (#1176) — is unchanged.
>
> Current topology of record: `docs/architecture/04-frontend-structure.md`.

> ## Amendment (2026-08-18, saved conversations on `/ai` — #1361)
>
> **The dock is unchanged; `/ai` is not.** Everything above still describes the
> assistant beside the document, tab container included. What changed is the
> *other* surface this spec touched in passing, and it supersedes two elements:
> one bullet of the 2026-08-06 block and one line of
> [Affected files](#affected-files).
>
> - **"conversations keyed by page" (the 2026-08-06 block's last bullet) is now
>   half true.** `AiContext` keys threads by **location**: `page:<id>` for the
>   dock — unchanged, the open document is still the key — and `draft` /
>   `conv:<id>` for `/ai`, which gained a per-conversation URL `/ai/c/:id`.
>   Each thread also carries an **identity**, so a stream writer follows a
>   re-key (a first answer promotes `draft` to `conv:<id>` mid-stream) and drops
>   its write instead of resurrecting a thread that has been replaced. The
>   12-thread retention and "opening the assistant runs nothing" (#1176) are
>   untouched.
> - **"`/ai` becomes Ask + Generate" (the `AiAssistantPage.tsx` line of Affected
>   files) understates it.** The Pages tree no longer renders on AI routes at
>   all — a conversations pane takes the left rail — and page scope on `/ai` is
>   retired outright: no context chip, no `+ Sub-pages`, and an ask from `/ai`
>   sends no `pageId`, so a dock-origin conversation continued from `/ai`
>   searches the whole corpus. The dock keeps page scope; that asymmetry is the
>   point of this spec and is intact.
>
> Files this adds to the list below: `frontend/src/shared/lib/ai-routes.ts`,
> `frontend/src/features/ai/conversations/*` (the pane),
> `frontend/src/features/ai/assistant-actions.ts`,
> `frontend/src/shared/hooks/use-list-roving-focus.ts`,
> `frontend/src/shared/components/layout/AppLayout.tsx` (the pane is the third
> arm of the sidebar ternary), and
> `frontend/src/shared/components/layout/SidebarTreeView.tsx` +
> `DndLocalSpaceTree.tsx` (the `isAiRoute` prop and every branch keyed on it
> deleted).
>
> Design of record for all of it:
> `docs/superpowers/specs/2026-08-17-ai-conversation-history-design.md`.

## Problem

The AI assistant is a destination (`/ai`), not a tool. That produces three concrete
defects:

1. **Context is invisible and unswitchable.** `AiAssistantPage.tsx` renders the active
   page as a static, non-interactive chip. It cannot be clicked, cleared, or used to
   pick a different page.
2. **Switching context destroys work.** `pageId` is derived purely from the `?pageId=`
   URL search param (`AiContext.tsx:198`), and any change resets `messages`,
   `conversationId`, and diff/diagram state (`AiContext.tsx:258-271`). A sidebar click
   the user reads as navigation silently discards an in-progress conversation.
3. **Two axes of state, no relationship between them.** The user picks one of six modes
   *and* separately establishes a page context, with no affordance connecting them.

The underlying cause is structural: `AiProvider` is mounted inside `AiAssistantPage`
(`AiAssistantPage.tsx:575`), so the conversation cannot outlive the route.

## Direction

The assistant becomes a **dock**, not a destination. The open document *is* the
context, so there is nothing to switch and nothing to reset.

This extends the incumbent Slate Steel world (ADR-010 v0.5). No new visual language,
no new tokens.

### Topology

On `/pages/:id`, opening the assistant forces `ArticleRightPane` into its **existing**
40px collapsed rail (`ArticleRightPane.tsx:520-564`) and renders the assistant beside
it at ~420px. Rail icons fly out on hover/focus so the outline stays reachable.

```
┌────────┬──────────────────────────┬──┬────────────────────────┐
│Sidebar │  # Onboarding Guide      │⚭ │ ✦ Assistant          × │
│        │                          │▤ │ ────────────────────── │
│ ▸ Docs │  Lorem ipsum dolor sit   │⚡│ You: tighten the intro │
│ ▸ API  │  amet, consectetur…      │▓ │                        │
│ ▸ Onb… │                          │⏱ │ ✦ Here's a revision:   │
│        │  ## Prerequisites        │  │  ┌──────────────────┐  │
│        │  ▓▓▓▓▓▓▓▓ (selected)     │  │  │- Lorem ipsum dol │  │
│        │                          │  │  │+ Getting started │  │
│        │  You need a PAT…         │  │  └──────────────────┘  │
│        │                          │  │  [Apply] [Skip]        │
│        │                          │  │ ────────────────────── │
│        │                          │  │ ⚡Improve ⚡Summarize   │
│        │                          │  │ ⚡Diagram ⚡Quality     │
│        │                          │  │ ┌────────────────────┐ │
│        │                          │  │ │ Ask about this…  ⏎ │ │
│        │                          │  │ └────────────────────┘ │
└────────┴──────────────────────────┴──┴────────────────────────┘
                                     40px        ~420px
```

The rail's "AI Improve" button (`ArticleRightPane.tsx:557-564`) stops navigating to
`/ai?mode=improve&pageId=…` and instead opens the dock with an Improve prompt seeded.

> **Amended by #1176.** The seeded auto-run is gone. Opening the assistant and
> rewriting the whole document were the same click: the improvement type was never
> chosen (it took `AiContext`'s `grammar` default), the dock offers no way to stop a
> run, and closing the panel does not abort one — so a single press started an
> unrequested, uncancellable rewrite. The trigger is now `Sparkles` "AI Assistant" in
> the rail, the expanded pane and on `Alt+I` (`ai-assistant` in the shortcut
> registry); it opens the panel with the composer focused and sends nothing. Improve
> starts where the other three actions do — at its chip. `DockSeed`, `seedPageId` and
> `consumeSeed` were deleted with the effect that consumed them; the `seedPageId`
> page-mismatch guard went with them because there is no longer a pending action for
> a navigation to strand.

### One thread, four chips

The six-mode tablist does not survive into the dock. Improve, Summarize, Diagram, and
Quality become **chips that seed the conversation** rather than modes you switch into.
This removes the mode-vs-context two-axis problem outright instead of bolting a
context switcher onto it.

**Generate stays on `/ai`.** It creates a new document rather than acting on an open
one, and its upload zone plus long-form prompt fit badly in a 420px column. `/ai`
loses its context chip entirely — it becomes the no-document home for Ask and
Generate.

> **Amended by #1177 — a chip may carry a parameter.** Improve is the one action of
> the four that is parameterised: `/llm/improve` takes one of five passes (grammar,
> structure, clarity, technical, completeness), `/ai?mode=improve` has always let the
> user pick, and the dock shipped without the control — so every docked Improve was a
> grammar pass on whatever `AiContext` happened to hold. Improve becomes a **split
> chip**: the verb, plus a caret (`aria-expanded`) that discloses the five passes on a
> row beneath the chips and folds them away again when the run starts. The chip names
> the pass in its own label whenever it is not the default, so a chip that would
> rewrite the page differently than it reads cannot exist.
>
> **This is not a new AI mode**, and the anti-goal below stands unchanged. The pass is
> an argument to an action the dock already has: it is reachable only from that
> action's own chip, it adds no destination, no screen and no verb, and the dock still
> offers exactly four. A permanently visible row of five was rejected for the two
> reasons a 420px column makes obvious — it spends a whole line on a setting most runs
> leave alone, and sitting under all four chips it would imply the pass applies to
> Summarize, Diagram and Quality, which it does not.
>
> Two sibling gaps are left open **deliberately**, not by oversight: the Diagram chip's
> `diagramType` is dock-unreachable in the same way (every docked diagram is a
> flowchart), and `ImproveModeInput`'s MCP `searchWeb` toggle has no dock equivalent.
> Whoever closes them should reuse the split-chip pattern rather than inventing a
> second one.

### Color

Violet marks the AI surface (panel header, streaming indicator, assistant avatar) per
ADR-010. Steel remains the interaction accent for chips, `Apply`, and the send button.
**Violet is never a button fill** — it identifies the surface, it does not invite a
click.

## Behavior

### Threads

Conversations are keyed by `pageId` and retained. Moving between documents **swaps**
threads; it never destroys one. `AiProvider` moves from `AiAssistantPage` up to
`AppLayout` so a thread outlives navigation. The `?pageId=` URL param becomes one
*input* to context resolution, not its definition.

### Diffs

Diffs render inline in the thread with `Apply` / `Skip`, writing straight into the
TipTap editor.

- `Apply` requires edit mode. In read mode, offer to enter it rather than failing.
- If the document changed under a pending diff, offer a re-diff. **Never silently
  overwrite.**

### Selection

The existing bubble-menu AI Improve on a text selection routes into the dock instead
of opening its own popover.

### Composer

The prompt is a `<textarea>`, not an `<input>` — Enter submits, Shift+Enter inserts a
newline, matching `ImproveMode.tsx`. This resolves #1120's complaint in the surface
where it actually matters.

## States

| State | Behavior |
|---|---|
| Empty thread | Chips and composer only, no placeholder chat bubbles |
| Streaming | Violet streaming indicator; composer disabled |
| Diff pending | Inline diff card with `Apply` / `Skip` |
| Apply conflict | Document edited under a pending diff → offer re-diff |
| Read mode | `Apply` offers to enter edit mode first |
| Rail flyout | Hover or focus a rail icon → outline/actions fly out |
| Model unavailable | Reuse the existing `modelsError` retry chip |

## Responsive

- **≥ ~1100px:** rail (40px) + assistant (~420px), as drawn.
- **< ~1100px:** the rail+assistant pair would starve the editor. The assistant takes
  the full pane width and the rail hides.
- **< `md`:** no right pane exists at all today. The assistant opens as a
  drag-to-expand **bottom sheet** over the article, mirroring how the left sidebar
  already becomes a slide-over.

## Accessibility

- `prefers-reduced-motion: reduce` strips the flyout and bottom-sheet springs.
- The 40px rail must stay operable under `forced-colors: active`.
- Chips and the send button keep the 1px `--color-border-interactive` border required
  by ADR-010's hybrid neumorphism (WCAG 1.4.11, 3:1).
- The dock is a labelled landmark; opening it moves focus to the composer, and Escape
  returns focus to the trigger.

## Scope

**In scope**

- Dock on `/pages/:id`
- Per-page thread retention
- `AiProvider` hoisted to `AppLayout`
- Mobile bottom sheet below `md`
- The four seeding chips

**Untouched**

- Everything `ArticleRightPane` does today: outline, tags, actions, resize, `.` collapse
- `/ai` keeps Generate

**Anti-goals**

- No multi-page context basket
- No new AI modes — a *sub-mode* of an action the dock already has is a parameter of
  that action, not a mode (see #1177's amendment above)
- No changes to the visual system

## Sequencing

Three PRs, in order:

1. **Hoist `AiProvider` to `AppLayout` + per-page thread retention.** Independently
   valuable — this alone fixes the data-loss bug in #1126. No visual change.
2. **The dock.** Rail coordination, chips, inline diff apply, `<textarea>` composer.
3. **Mobile bottom sheet.**

## Affected files

- `frontend/src/features/ai/AiContext.tsx` — thread keying, provider hoist, decouple
  `pageId` from the search param
- `frontend/src/shared/components/layout/AppLayout.tsx` — mount `AiProvider`; pane
  coordination at `:374`
- `frontend/src/shared/components/article/ArticleRightPane.tsx` — rail flyout; rewire
  the `Wand2` button
- `frontend/src/features/ai/AiAssistantPage.tsx` — drop the context chip; `/ai` becomes
  Ask + Generate
- `frontend/src/features/ai/modes/*` — Improve/Summarize/Diagram/Quality become chip
  prompts rather than mode screens
- New: the dock component and its mobile sheet variant
