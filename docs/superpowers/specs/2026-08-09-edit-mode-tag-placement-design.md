# Edit-mode tag placement — design

**Date:** 2026-08-09
**Branch:** `feature/edit-mode-tag-placement`
**Surface:** `/pages/:id` in edit mode — the sticky action row

## Problem

In edit mode the sticky bar's action row hands `TagEditor` the whole left half.
`TagEditor` stacks three things vertically — a pill row (~26px), a 12px gap, and an
input-plus-Add row (~38px) — so with the row's own `py-2` the bar measures **~92px**
and stays pinned above the document for the whole editing session. Cancel and Save
alone need 54px of that.

Two things are wrong, and only one of them is height.

**Height.** It is the only chrome row in the app that is not 48px. The header, the
sidebar header and the inspector header are all pinned to 48px specifically so one
rule runs across the window; this row breaks that line, and it does so on the route
where vertical space matters most.

**Scope mixing.** Three different scopes share one bar: the formatting toolbar acts
on the *selection*, `TagEditor` acts on the *page*, Cancel/Save act on the *session*.
The page-scoped control is also the least frequently used of the three and takes the
most room.

## Rejected: move it into the inspector

Tags belong with space, parent, version and author as page properties, and the
inspector's Details tab already carries those plus the AI auto-tagger in edit mode.
It is the better grouping.

It is not available. `ArticleRightPane` is `hidden md:flex` (`AppLayout.tsx:637`), so
below `md` the pane does not render and tagging while editing becomes impossible on a
phone. A responsive branch to a second mobile control is also closed off:
`useIsDockWideLayout()` is pinned by ADR-010 as the only JS width query in the app,
and every other responsive layout decision stays a Tailwind class.

One control that works at every width beats a better grouping that needs two.

## Decision

A 32px property chip in the action row opens a popover carrying the existing
`TagEditor` unchanged.

```
BEFORE — sticky, ~92px          AFTER — sticky, 48px
┌──────────────────────────┐    ┌──────────────────────────┐
│ B I U  H1 H2  ≡  ⌗  …    │    │ B I U  H1 H2  ≡  ⌗  …    │
├──────────────────────────┤    ├──────────────────────────┤
│ [api ×] [docs ×]         │ 26 │ [🏷 3 tags]  Cancel [Save]│ 32
│                          │ 12 └──────────────────────────┘
│ 🏷 Add a tag… [+ Add]    │ 38        │ click / Enter / Space
│           Cancel  [Save] │           ▼
└──────────────────────────┘      ┌────────────────────────────┐
                                  │ [api ×] [docs ×] [ops ×]   │
                                  │ 🏷 Add a tag…      [+ Add] │
                                  └────────────────────────────┘
```

44px of document returns, at every width.

### The chip

Copy is state-first, the way a property chip reads in Linear or Notion — it names the
action when there is nothing to report, and reports the value when there is:

| tags | label |
|---|---|
| 0 | `Add tags` |
| 1 | `1 tag` |
| n | `n tags` |

Styled `nm-button-ghost`: the existing 32px bordered secondary. No new CSS, and
ADR-010's 1px operable border for WCAG 1.4.11 comes with it. `data-[state=open]`
carries the open state.

Left-to-right the row now has three deliberate weights — bordered field (chip), bare
ghost (Cancel), filled primary (Save) — matching the three scopes: page, session
abort, session commit.

### Cancel's height

Cancel is `py-2` at `text-sm`, so 36px; `nm-button-primary` is 32px. Today `items-end`
hides the 4px mismatch by bottom-aligning both against the tall tag block. With a 32px
chip and `items-center` the mismatch would be visible, so Cancel goes to `py-1.5`
(6 + 20 + 6 = 32px). All three controls are then 32px and the row lands at exactly
48px with its existing `py-2`.

### Escape

The popover is a portalled layer over the editor, and `use-keyboard-shortcuts` binds
bare Escape to `handleCancelEditing()`. A layer that does not mark the key lets
Escape dismiss the popover *and* throw the user out of edit mode into a
"Discard changes?" prompt (the class of bug documented for the block menu at
CLAUDE.md's editor-block-menu note, rule 5).

`absorbBlockMenuEscape` already does both required halves — `preventDefault()` so
`use-keyboard-shortcuts` yields on `defaultPrevented`, and `stopPropagation()` so the
key reaches no other document listener. The name would be lying in a tag popover, so
its body moves to `shared/lib/absorb-portal-escape.ts` as `absorbPortalEscape` and
`use-block-menu-target.ts` re-exports the old name. Nothing pinned changes:
`block-menu-escape.test.tsx` imports the re-export, and
`EditorBlockMenu.test.tsx:622` asserts a source string in a file this does not touch.

It goes on Radix's **`onEscapeKeyDown`**, never `onKeyDown` — the latter is bypassed
when the layer unmounts in Radix's capture pass and again when the key is dispatched
from outside the layer.

### Escape peels one layer

With the autocomplete list open, Escape closes the list only; a second Escape closes
the popover. `TagEditor` already handles the key to hide suggestions — it gains a
`stopPropagation()` on that branch so the keystroke does not also reach Radix's
document listener. React 19 dispatches from the root container, which runs before a
document-level listener, so the bubble-phase stop lands first.

If that ordering ever fails, the fallback is today's behaviour — one Escape closes
everything — so the enhancement cannot regress anything.

### Unchanged

- `TagEditor`'s pills, input, autocomplete, normalisation and `isLoading` wiring.
- Tags save immediately through `useUpdatePageLabels`, independent of the document
  Save. Pre-existing behaviour; not in scope.
- The inspector Details tab keeps its read-only label pills under "Health & labels".
  They sit beside freshness and embedding status as a summary, not as a second editor.
- The sticky bar's under-mask (`-top-5 bottom-0`) and `scroll-padding-mask.test.ts`.

## Components

| File | Change |
|---|---|
| `shared/lib/absorb-portal-escape.ts` | **new** — `absorbPortalEscape(event, close)` |
| `shared/components/article/use-block-menu-target.ts` | re-export as `absorbBlockMenuEscape` |
| `shared/components/TagPopover.tsx` | **new** — chip trigger + Radix Popover over `TagEditor` |
| `shared/components/TagEditor.tsx` | `autoFocus` prop; Escape stops propagation while the list is open |
| `features/pages/PageViewPage.tsx` | action row: `TagEditor` → `TagPopover`, `items-end` → `items-center`, Cancel `py-2` → `py-1.5` |

`TagPopover` takes the same props `PageViewPage` already passes `TagEditor`
(`tags`, `onAddTag`, `onRemoveTag`, `suggestions`, `isLoading`) and forwards them
verbatim. It owns only its own open state.

## Testing

- `TagPopover.test.tsx` — chip label at 0/1/n; opens on click and on Enter; renders
  `TagEditor` inside; focuses the input on open; Escape closes the popover and is
  marked `defaultPrevented` with propagation stopped; chip carries an accessible name.
- `TagEditor.test.tsx` — Escape with suggestions open hides the list *and* stops
  propagation; Escape with no suggestions does not stop it.
- `absorb-portal-escape.test.ts` — both halves called, `close` called once.
- `PageViewPage.test.tsx` — the existing `TagEditor` module mock becomes a
  `TagPopover` mock; assert the action row renders the popover, not a stacked editor.
- `block-menu-escape.test.tsx` and `EditorBlockMenu.test.tsx` must stay green
  untouched — that is the check on the re-export.

## Docs

CLAUDE.md's UI/UX section gains a short note on the edit-mode action row: the 48px
figure, why tags are a chip rather than a block, and that any new portalled layer over
the editor must absorb Escape via `absorbPortalEscape`.
