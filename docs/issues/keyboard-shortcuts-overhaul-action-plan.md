# Keyboard Shortcuts Overhaul -- Action Plan

## 1. Current State Analysis

### 1.1 Architecture Overview

The keyboard shortcuts system is split across four layers:

| Layer | File | Purpose | Status |
|-------|------|---------|--------|
| **Hook** | `frontend/src/shared/hooks/use-keyboard-shortcuts.ts` | Global keydown listener with modifier/editable-target suppression | Good, well-tested |
| **Registry** | `frontend/src/shared/lib/shortcut-registry.ts` | Display-only lookup table for hints and modal | Partially connected |
| **Modal** | `frontend/src/shared/components/layout/KeyboardShortcutsModal.tsx` | Visual list for users | **Hardcoded, ignores the registry** |
| **Hint badge** | `frontend/src/shared/components/ShortcutHint.tsx` | Platform-aware `<kbd>` badge | Good, reads from registry |

### 1.2 Current Shortcut Inventory (13 registered, ~6 inline)

**Global shortcuts** (registered in `AppLayout.tsx` lines 50-110 via `useKeyboardShortcuts`):

| Shortcut | Action | Notes |
|----------|--------|-------|
| `,` | Toggle left sidebar | Single-char, WCAG 2.1.4 concern |
| `.` | Toggle right panel | Single-char, WCAG 2.1.4 concern |
| `\` | Zen mode (both panels) | Single-char, WCAG 2.1.4 concern |
| `Ctrl+K` | Command palette | No conflicts |
| `Alt+N` | New page | No conflicts (previously was Ctrl+N, already fixed) |
| `?` | Show shortcuts modal | Single-char, WCAG 2.1.4 concern |
| `Ctrl+/` | Show shortcuts modal | Duplicate of `?` with modifier |
| `Escape` | Close shortcuts modal | OK |

**Page-view shortcuts** (registered in `PageViewPage.tsx` lines 284-321 via `useKeyboardShortcuts`):

| Shortcut | Action | Notes |
|----------|--------|-------|
| `Ctrl+S` | Save article | Intentional browser override |
| `Ctrl+E` | Toggle edit/view | Partial Chrome conflict (URL bar) |
| `Escape` | Exit edit mode | Checks for open dialogs first |

**Component-level shortcuts** (inline `onKeyDown`, NOT in the hook system):

| Shortcut | Action | Component | File |
|----------|--------|-----------|------|
| `+`, `-`, `0` | Zoom in/out/reset | DiagramLightbox | `DiagramLightbox.tsx:58-71` |
| `Escape` | Close | CommandPalette | `CommandPalette.tsx:171` |
| `Arrow Up/Down` | Navigate results | CommandPalette | `CommandPalette.tsx:161-166` |
| `Enter` | Select result | CommandPalette | `CommandPalette.tsx:167-169` |
| `Escape` | Close lightbox | ImageLightbox | `PageViewPage.tsx:43-47` |
| `Enter`, `Escape` | Submit/cancel folder | SidebarTreeView | `SidebarTreeView.tsx:666-671` |

### 1.3 What Works Well

1. **`useKeyboardShortcuts` hook** -- Clean design with proper editable-target suppression, modifier key handling, Mac/Windows detection via `navigator.userAgentData` with `navigator.userAgent` fallback, and TipTap editor awareness. Well-tested (12 tests, all meaningful).

2. **`ShortcutHint` component** -- Platform-aware badge that reads from the registry. Used on search bar, sidebar toggle, right panel toggle, and edit button. Good test coverage (6 tests).

3. **`shortcut-registry.ts`** -- Centralized display-only registry with `SHORTCUTS` array, `getShortcutsByCategory()`, `getShortcutHint()`, and `formatKeysForPlatform()`. Good test coverage (17 tests).

4. **Editable suppression** -- Non-modifier shortcuts are correctly suppressed inside `<input>`, `<textarea>`, `contentEditable`, and TipTap editors.

5. **Browser conflict avoidance** -- `Ctrl+N` was already replaced with `Alt+N`. The `alt` modifier is already supported in the hook.

### 1.4 What Is Problematic

#### Problem 1: Three disconnected sources of truth

The `KeyboardShortcutsModal` (lines 24-53) has its own hardcoded `getShortcutGroups()` function that duplicates shortcut definitions. It does NOT use the `shortcut-registry.ts` at all. This means:
- The registry says `Alt+N` for new page (correct), but the modal says `Ctrl+N` (wrong, line 39 shows `${mod}+N`).
- Any shortcut added to `AppLayout.tsx` must be manually duplicated in both `shortcut-registry.ts` AND `KeyboardShortcutsModal.tsx`.
- The registry's `actions` category is never displayed (modal only has Panels/Navigation/Editor).

The `shortcut-registry.ts` is a "display-only lookup table" by its own comment (line 2-8). Actual key bindings live at their call-sites. This was a deliberate choice but creates drift risk.

#### Problem 2: No navigation shortcuts for main sections

The sidebar has three primary nav items (defined in `SidebarTreeView.tsx` line 31-35):
```
{ icon: BookOpen, label: 'Pages', path: '/' }
{ icon: Share2,   label: 'Graph', path: '/graph' }
{ icon: Bot,      label: 'AI',    path: '/ai' }
```

There are NO keyboard shortcuts to navigate between these sections. Users must click.

#### Problem 3: WCAG 2.1.4 non-compliance for single-character shortcuts

Six shortcuts use single printable characters (`,`, `.`, `\`, `?`, `+`, `-`, `0`) with no mechanism to turn them off, remap them, or scope them to a focused component. Per WCAG 2.1.4 (Level A), at least one of these mechanisms must be provided.

#### Problem 4: No shortcut enable/disable toggle

There is no user preference to disable or customize keyboard shortcuts. This is required by WCAG 2.1.4 for single-character shortcuts and is a standard feature in apps like Gmail.

#### Problem 5: Missing shortcuts for common actions

| Action | Available via | Shortcut |
|--------|--------------|----------|
| Pin/Unpin page | ArticleRightPane button only | None |
| Delete page | ArticleRightPane button only | None |
| Navigate to Pages | Sidebar click only | None |
| Navigate to Graph | Sidebar click only | None |
| Navigate to AI | Sidebar click only | None |
| Navigate to Settings | UserMenu click only | None |
| Navigate to Trash | No direct link | None |
| Sync pages | Settings/command palette only | None |
| Focus search | `Ctrl+K` opens palette | Exists, but no way to go directly to search results page |

#### Problem 6: No visual sequence feedback

If "G then X" sequences are implemented, there is no UI affordance to show that "G" has been pressed and the system is waiting for the second key.

#### Problem 7: Escape key conflicts

Three different handlers compete for `Escape`:
- `AppLayout.tsx` line 104-109: closes shortcuts modal
- `PageViewPage.tsx` line 309-318: exits edit mode (with dialog check)
- `CommandPalette.tsx` line 171: closes palette (inline `onKeyDown`)

The current workaround (checking `document.querySelector('[role="dialog"]')`) is fragile. Priority-based handling would be more robust.

---

## 2. Best Practices Research Findings

### 2.1 WCAG Accessibility Requirements

**WCAG 2.1.4 Character Key Shortcuts (Level A)** -- If a shortcut uses only letter, punctuation, number, or symbol characters, then at least one must be true:
- A mechanism exists to turn the shortcut off
- A mechanism exists to remap it to include a non-printable modifier key
- The shortcut is only active when the component has focus

**WCAG 2.1.1 Keyboard** -- All functionality must be operable through a keyboard interface.

**WCAG 2.4.3 Focus Order** -- Keyboard navigation order must be logical and meaningful.

**WCAG 2.4.7 Focus Visible** -- Focus indicator must be visible for all keyboard-operable elements.

**WCAG 2.2 (2023)** -- Enhanced focus appearance requirements; minimum 3:1 contrast ratio.

### 2.2 Industry Conventions

**Gmail pattern** -- "G then X" for section navigation (g+i = inbox, g+s = starred, g+t = sent). Shortcuts are OFF by default and must be explicitly enabled in settings. This satisfies WCAG 2.1.4.

**Notion pattern** -- Uses `Ctrl+` or `Cmd+` for most shortcuts. Single-character shortcuts (like `/` for slash commands) only activate when the editor is focused (satisfying WCAG 2.1.4 via component-focus scoping).

**VS Code pattern** -- Chord shortcuts (`Ctrl+K Ctrl+S` for keybindings). Full remapping support. `Ctrl+Shift+P` for command palette (equivalent to our `Ctrl+K`).

**Common conventions across apps**:
- `?` for shortcuts help (Gmail, GitHub, Jira)
- `Ctrl+K` / `Cmd+K` for command palette (Slack, Notion, Linear, GitHub)
- `/` for search or commands (YouTube, Reddit, Notion)
- `Escape` for closing modals/overlays (universal)

### 2.3 Key Design Principles

1. **Discoverability** -- Shortcuts should be visible on buttons and in tooltips, not just in a hidden modal.
2. **Consistency** -- Follow platform conventions (Ctrl on Windows/Linux, Cmd on Mac).
3. **Non-destructive defaults** -- Destructive actions (delete) should require modifier keys or confirmation.
4. **Layered complexity** -- Basic shortcuts for common actions, advanced sequences for power users.
5. **Graceful degradation** -- Everything must also work with mouse/touch.
6. **No browser conflicts** -- Never override `Ctrl+T`, `Ctrl+W`, `Ctrl+N`, `Ctrl+Tab`, `Ctrl+L`.

---

## 3. Action Plan

### Phase 1: Unify the modal with the registry (eliminate drift)

**Goal**: Make the `KeyboardShortcutsModal` render directly from `shortcut-registry.ts`, eliminating the hardcoded `getShortcutGroups()` function.

**Files to change**:

| File | Change |
|------|--------|
| `frontend/src/shared/components/layout/KeyboardShortcutsModal.tsx` (lines 14-53) | Remove the entire `ShortcutRow`, `ShortcutGroup`, and `getShortcutGroups()` function. Import `getShortcutsByCategory`, `getCategoryLabel`, `formatKeysForPlatform` from `shortcut-registry.ts`. Render categories from `getShortcutsByCategory()` map, using `getCategoryLabel()` for titles and `formatKeysForPlatform()` for key display. |
| `frontend/src/shared/components/layout/KeyboardShortcutsModal.tsx` (lines 5-8) | Remove the local `isMac()` and `modLabel()` functions. Use the existing `isMac()` logic from `ShortcutHint.tsx` or extract it to a shared utility. |
| `frontend/src/shared/lib/shortcut-registry.ts` | Add a `scope` field to `ShortcutDefinition` (optional: `'global' | 'page' | 'editor'`). Add TipTap editor shortcuts as a separate static array for the modal display. |
| `frontend/src/shared/components/layout/KeyboardShortcutsModal.test.tsx` | Update test assertions: "shows all shortcut categories" should check for 'Actions' category as well. "shows key descriptions" should check for registry-defined labels, not hardcoded strings. |

**Detailed changes for `KeyboardShortcutsModal.tsx`**:
- Line 1: Add import `import { getShortcutsByCategory, getCategoryLabel, formatKeysForPlatform } from '../../lib/shortcut-registry';`
- Lines 5-53: Delete the local `isMac()`, `modLabel()`, `ShortcutRow`, `ShortcutGroup`, `getShortcutGroups()`.
- Line 80: Replace `const groups = getShortcutGroups()` with `const grouped = getShortcutsByCategory()` and convert the Map to an array for rendering.
- Lines 109-126: Update the render loop to iterate over the Map entries, using `getCategoryLabel(category)` for section titles and `formatKeysForPlatform(shortcut.keys, isMac)` for key display.
- Add a static `TIPTAP_SHORTCUTS` array for formatting shortcuts (Ctrl+B, Ctrl+I, Ctrl+Z, Ctrl+Shift+Z, Tab, Shift+Tab) and render it as an additional "Editor Formatting" section at the bottom.

**Acceptance criteria**:
- Modal content is generated entirely from registry data
- No duplicate shortcut definitions remain
- `Alt+N` correctly displays for new page (current bug fixed)
- All existing modal tests pass (with updated assertions)

---

### Phase 2: Extract shared `isMac()` utility

**Goal**: The `isMac()` function is duplicated in three places. Extract it to a shared utility.

**Current duplications**:
1. `frontend/src/shared/hooks/use-keyboard-shortcuts.ts` lines 42-51
2. `frontend/src/shared/components/ShortcutHint.tsx` lines 14-23 (named `isMacPlatform`)
3. `frontend/src/shared/components/layout/KeyboardShortcutsModal.tsx` lines 5-8 (uses legacy `navigator.platform`)

**Files to change**:

| File | Change |
|------|--------|
| `frontend/src/shared/lib/platform.ts` (new) | Create with a single exported `isMac()` function using the modern `navigator.userAgentData` API with `navigator.userAgent` fallback (same implementation as in `use-keyboard-shortcuts.ts` lines 42-51). |
| `frontend/src/shared/lib/platform.test.ts` (new) | Test `isMac()` with: default jsdom (non-Mac), mocked `userAgentData`, mocked `userAgent`, and `typeof navigator === 'undefined'`. |
| `frontend/src/shared/hooks/use-keyboard-shortcuts.ts` | Remove local `isMac()` (lines 42-51). Import from `../lib/platform`. |
| `frontend/src/shared/components/ShortcutHint.tsx` | Remove local `isMacPlatform()` (lines 14-23). Import `isMac` from `../lib/platform`. |
| `frontend/src/shared/lib/shortcut-registry.ts` | No change needed (it takes `isMac` as a parameter to `formatKeysForPlatform`). |

**Acceptance criteria**:
- Single `isMac()` definition used everywhere
- All existing tests still pass
- New unit tests for the platform utility

---

### Phase 3: Add WCAG 2.1.4 compliance -- shortcut enable/disable toggle

**Goal**: Provide a mechanism to disable single-character shortcuts, satisfying WCAG 2.1.4 Level A.

**Design**: Add a `shortcutsEnabled` boolean to the `useUiStore` (persisted). When disabled, only modifier-based shortcuts (Ctrl+K, Ctrl+S, etc.) fire. Single-character shortcuts (`,`, `.`, `\`, `?`) are suppressed. This is the Gmail approach: shortcuts are a user preference.

**Files to change**:

| File | Change |
|------|--------|
| `frontend/src/stores/ui-store.ts` | Add `shortcutsEnabled: boolean` (default `true`) and `setShortcutsEnabled: (enabled: boolean) => void` to the persisted state. |
| `frontend/src/shared/hooks/use-keyboard-shortcuts.ts` | Add a check: if the shortcut has no `mod` and no `alt` modifier, and `shortcutsEnabled` is false, skip it. Import `useUiStore` selector. Alternatively, accept an `enabled` parameter. |
| `frontend/src/shared/components/layout/KeyboardShortcutsModal.tsx` | Add a toggle switch in the modal footer: "Enable single-key shortcuts" with a note explaining which shortcuts are affected. |
| `frontend/src/shared/components/layout/UserMenu.tsx` | **Required.** Add a "Keyboard Shortcuts: On/Off" toggle in the user menu dropdown. Must be accessible even when single-char shortcuts are disabled (since `?` would be disabled). Replace hardcoded `<kbd>?</kbd>` with `<ShortcutHint shortcutId="shortcuts-help" />`. |

**Alternative approach** (simpler): Instead of a global toggle, modify the hook to accept an `enableSingleKey?: boolean` parameter. AppLayout passes `!useUiStore((s) => s.shortcutsDisabled)` for this parameter.

**Acceptance criteria**:
- User can disable single-character shortcuts via a persisted toggle
- Modifier shortcuts (Ctrl+K, Ctrl+S, Alt+N) always work regardless of toggle
- Toggle state survives page reload (persisted in localStorage)
- WCAG 2.1.4 requirement satisfied

---

### Phase 4: Add "G then X" navigation sequences

**Goal**: Add vim/Gmail-style two-key navigation sequences for main sections.

**Proposed shortcuts**:

| Sequence | Action | Route |
|----------|--------|-------|
| `G then P` | Go to Pages | `/` |
| `G then G` | Go to Graph | `/graph` |
| `G then A` | Go to AI | `/ai` |
| `G then S` | Go to Settings | `/settings` |
| `G then T` | Go to Trash | `/trash` |

**Implementation**:

Add a `pendingPrefix` state to `useKeyboardShortcuts`. When a key matching a sequence prefix (`g`) is pressed (outside editable elements, without modifiers):
1. Store it as `pendingPrefix` with a 800ms timeout (longer than Gmail's ~500ms for better usability).
2. On next keypress within the timeout, check if `pendingPrefix + key` matches a sequence.
3. If match: execute the action, clear prefix.
4. If no match or timeout: clear prefix, process key normally.

**Files to change**:

| File | Change |
|------|--------|
| `frontend/src/shared/hooks/use-keyboard-shortcuts.ts` | Add `ShortcutDefinition.sequence?: string` field (e.g., `'g p'`). Add `pendingPrefix` ref and timeout handling to `handleKeyDown`. Sequences are only processed outside editable elements. |
| `frontend/src/shared/lib/shortcut-registry.ts` | Add new entries to `SHORTCUTS`: `go-pages`, `go-graph`, `go-ai`, `go-settings`, `go-trash` with `keys: 'g p'` etc. Add new category label mapping if needed or use 'navigation'. |
| `frontend/src/shared/components/layout/AppLayout.tsx` | Add sequence shortcuts to the `shortcuts` array with navigation actions. |
| `frontend/src/shared/hooks/use-keyboard-shortcuts.test.ts` | Add tests: sequence fires on correct second key, sequence cancels after timeout, sequence does not fire inside editable elements, sequence clears on non-matching second key. |

**Visual feedback**: Add a small, transient toast or floating indicator when `G` is pressed showing "G..." to indicate a sequence is pending. This can be a lightweight Zustand atom or a simple DOM element managed by the hook.

**Files for visual feedback**:

| File | Change |
|------|--------|
| `frontend/src/stores/keyboard-shortcuts-store.ts` | Add `pendingSequence: string | null` and `setPendingSequence` to the store. |
| `frontend/src/shared/components/layout/AppLayout.tsx` | Add a floating indicator near the bottom-right that shows `pendingSequence` when non-null (e.g., "G ..."). Auto-dismiss on sequence complete or timeout. |

**Registry entries to add**:

```
{ id: 'go-pages',    keys: 'g p', label: 'Go to Pages',    category: 'navigation' }
{ id: 'go-graph',    keys: 'g g', label: 'Go to Graph',    category: 'navigation' }
{ id: 'go-ai',       keys: 'g a', label: 'Go to AI',       category: 'navigation' }
{ id: 'go-settings', keys: 'g s', label: 'Go to Settings', category: 'navigation' }
{ id: 'go-trash',    keys: 'g t', label: 'Go to Trash',    category: 'navigation' }
```

**Acceptance criteria**:
- `G` then `P` navigates to Pages from any page
- `G` then `G` navigates to Graph from any page
- `G` then `A` navigates to AI from any page
- Sequences do NOT fire inside input/textarea/editor
- Pending state times out after 800ms
- Visual "G..." indicator appears during pending state
- All new shortcuts appear in the modal
- Tests cover sequence matching, timeout, cancellation

---

### Phase 5: Add action shortcuts for page view

**Goal**: Add shortcuts for common page-level actions.

**Proposed shortcuts**:

| Shortcut | Action | Scope |
|----------|--------|-------|
| `Alt+P` | Pin/Unpin page | Page view |
| `Alt+Shift+D` | Delete page (with confirmation) | Page view |
| `Alt+I` | AI Improve | Page view |

Note: `Alt+Backspace` was in the prior plan but is risky (OS-level word deletion). `Alt+D` conflicts with browser address bar on Windows/Linux (Firefox/Chrome). `Alt+Shift+D` avoids this. `Alt+E` conflicts with `Ctrl+E` confusion, so `Alt+I` (Improve) is used for AI.

**Files to change**:

| File | Change |
|------|--------|
| `frontend/src/shared/lib/shortcut-registry.ts` | Add entries: `pin-page` (`alt+p`), `delete-page` (`alt+shift+d`), `ai-improve` (`alt+i`). Rename exported type `ShortcutDefinition` to `ShortcutRegistryEntry` to avoid collision with the hook's `ShortcutDefinition`. |
| `frontend/src/features/pages/PageViewPage.tsx` | Add `Alt+P` (pin toggle), `Alt+D` (delete with confirm), `Alt+I` (navigate to AI improve) to the `pageShortcuts` array. Import pin/delete handlers (may need to lift from ArticleRightPane or duplicate logic). |
| `frontend/src/shared/components/article/ArticleRightPane.tsx` | Add `<ShortcutHint>` badges to the Pin and Delete buttons. |
| `frontend/src/features/pages/PageViewPage.test.tsx` | Add tests for Alt+P, Alt+D, Alt+I keyboard handling. |

**Acceptance criteria**:
- Alt+P toggles pin state of current page
- Alt+D triggers delete confirmation dialog
- Alt+I navigates to AI improve mode for current page
- Shortcuts appear in modal and on buttons
- Tests verify behavior

---

### Phase 6: Improve Escape key handling with priority system

**Goal**: Replace the fragile dialog-detection pattern with a proper priority-based Escape handler.

**Design**: Use a stack-based approach where the most recently opened overlay gets priority for Escape. When `Escape` is pressed:
1. If CommandPalette is open -> close it (highest priority, handled inline)
2. If ShortcutsModal is open -> close it
3. If any Radix Dialog is open -> let Radix handle it
4. If editing a page -> exit edit mode
5. Otherwise -> no-op

**Files to change**:

| File | Change |
|------|--------|
| `frontend/src/shared/hooks/use-keyboard-shortcuts.ts` | Add a `priority` field to `ShortcutDefinition` (optional number, default 0). When multiple shortcuts match the same key, execute only the highest-priority one whose `condition` callback returns true. |
| `frontend/src/shared/components/layout/AppLayout.tsx` | Set Escape shortcuts with explicit priorities: modal close (priority 10), no-op fallback (priority 0). |
| `frontend/src/features/pages/PageViewPage.tsx` | Set Escape edit-mode-exit at priority 5. Remove the `document.querySelector('[role="dialog"]')` hack (line 315). |

**Alternatively** (simpler): Rather than a priority system, remove the Escape shortcut from `AppLayout` entirely (the Radix Dialog already handles Escape natively for the shortcuts modal) and only keep Escape in `PageViewPage` for exiting edit mode, with the existing dialog check retained as a safety guard. This avoids over-engineering.

**Recommended approach**: The simpler alternative. The current system works; the dialog check is defensive, not fragile. The only real fix needed is to remove the redundant Escape handler in `AppLayout` since `KeyboardShortcutsModal` uses Radix Dialog which has built-in Escape handling.

**Files to change (simplified)**:

| File | Change |
|------|--------|
| `frontend/src/shared/components/layout/AppLayout.tsx` (lines 104-109) | Remove the Escape shortcut entry entirely. The Radix `Dialog.Root` in `KeyboardShortcutsModal` already handles Escape via `onOpenChange`. |
| `frontend/src/shared/components/layout/AppLayout.test.tsx` | Update tests that check for Escape behavior if any exist. |

**Acceptance criteria**:
- Escape closes shortcuts modal (via Radix, not custom handler)
- Escape exits edit mode when editing (via PageViewPage handler)
- Escape closes command palette (via inline handler in CommandPalette)
- No double-fire or missed Escape events

---

### Phase 7: Add shortcut hints to more buttons

**Goal**: Make shortcuts discoverable by showing `<ShortcutHint>` badges on key buttons.

**Buttons to update**:

| Button | File | Line | Shortcut ID | Display |
|--------|------|------|-------------|---------|
| Save button (editing) | `PageViewPage.tsx` | ~428 | `save` (new) | Inline `<ShortcutHint>` |
| Pin button | `ArticleRightPane.tsx` | ~432 | `pin-page` (Phase 5) | Inline `<ShortcutHint>` |
| Delete button | `ArticleRightPane.tsx` | ~449 | `delete-page` (Phase 5) | `title` attribute only |
| AI Improve button | `ArticleRightPane.tsx` | ~418 | `ai-improve` (Phase 5) | `title` attribute only |
| New Page button (PagesPage) | Look up in PagesPage.tsx | -- | `new-page` | Inline `<ShortcutHint>` |
| Nav items (Pages/Graph/AI) | `SidebarTreeView.tsx` | ~485-505 | `go-pages`, `go-graph`, `go-ai` | `title` attribute with "G then P" etc. |

**Registry entries to add** (for shortcuts that exist but are not in the registry):

```
{ id: 'save', keys: 'ctrl+s', label: 'Save article', category: 'editor' }
```

Note: `save` is already handled by `PageViewPage` but not in the registry for hint display. It must be added.

**Acceptance criteria**:
- At least 4 additional buttons show shortcut hints
- Navigation items show sequence hints in `title` attributes
- Hints update correctly for Mac vs Windows

---

### Phase 8: Add TipTap editor shortcuts to modal

**Goal**: Document the built-in TipTap formatting shortcuts in the shortcuts modal so users know they exist.

**Shortcuts to document**:

| Shortcut | Action |
|----------|--------|
| `Ctrl+B` | Bold |
| `Ctrl+I` | Italic |
| `Ctrl+U` | Underline |
| `Ctrl+Z` | Undo |
| `Ctrl+Shift+Z` | Redo |
| `Ctrl+Shift+X` | Strikethrough |
| `` Ctrl+` `` | Inline code |
| `Tab` | Indent list |
| `Shift+Tab` | Outdent list |
| `Ctrl+Shift+7` | Ordered list |
| `Ctrl+Shift+8` | Bullet list |

**Files to change**:

| File | Change |
|------|--------|
| `frontend/src/shared/lib/shortcut-registry.ts` | Add a separate `TIPTAP_SHORTCUTS` exported array (not in `SHORTCUTS` since they are not handled by our hook). Same `ShortcutDefinition` shape but without `id` being functional. Use a new category `'formatting'` or simply label them differently. |
| `frontend/src/shared/lib/shortcut-registry.ts` | Add `'formatting'` to `ShortcutCategory` type and `CATEGORY_LABELS`. |
| `frontend/src/shared/components/layout/KeyboardShortcutsModal.tsx` | Render the TipTap shortcuts as an additional "Formatting (Editor)" section, visually separated with a note like "Active when editing an article". |

**Acceptance criteria**:
- TipTap shortcuts appear in the modal under a "Formatting" section
- Section has a note indicating these are only active in the editor
- Tests verify the formatting section renders

---

### Phase 9: Update all tests

**Goal**: Ensure full test coverage for all changes.

**New tests needed**:

| Test file | Tests to add |
|-----------|-------------|
| `frontend/src/shared/lib/platform.test.ts` (new) | `isMac()` with various navigator configs |
| `frontend/src/shared/hooks/use-keyboard-shortcuts.test.ts` | Sequence shortcuts (2-key), sequence timeout, sequence cancellation, single-key disable toggle |
| `frontend/src/shared/lib/shortcut-registry.test.ts` | New entries (`go-pages`, `go-graph`, etc.), `formatKeysForPlatform` for sequence keys |
| `frontend/src/shared/components/layout/KeyboardShortcutsModal.test.tsx` | Modal renders from registry, shows all categories including "Actions" and "Formatting", TipTap section present |
| `frontend/src/shared/components/ShortcutHint.test.tsx` | Rendering sequence keys (`g p`), rendering new shortcut IDs |
| `frontend/src/features/pages/PageViewPage.test.tsx` | Alt+P pin toggle, Alt+D delete with confirm, Alt+I AI improve navigation |
| `frontend/src/shared/components/layout/AppLayout.test.tsx` | G-then-P/G/A navigation sequences, verify Escape does not double-fire |

**Existing tests to update**:

| Test file | Changes needed |
|-----------|---------------|
| `frontend/src/shared/components/layout/KeyboardShortcutsModal.test.tsx` | Update "shows all shortcut categories" to check for "Actions" and "Formatting". Update "shows key descriptions" to match registry labels (not hardcoded ones that may change). |
| `frontend/src/shared/lib/shortcut-registry.test.ts` | Add assertions for new entries. Update count-based tests if any. |

---

## 4. Implementation Order and Dependencies

```
Phase 1 (Unify modal with registry)
  |
  v
Phase 2 (Extract isMac utility) -- can run in parallel with Phase 1
  |
  v
Phase 3 (WCAG 2.1.4 toggle) -- depends on Phase 2
  |
  v
Phase 4 (G-then-X sequences) -- depends on Phases 1, 2, 3
  |
  v
Phase 5 (Action shortcuts) -- can run in parallel with Phase 4
  |
  v
Phase 6 (Escape key cleanup) -- independent, can run anytime after Phase 1
  |
  v
Phase 7 (Shortcut hints on buttons) -- depends on Phases 4, 5 (needs registry entries)
  |
  v
Phase 8 (TipTap shortcuts in modal) -- depends on Phase 1
  |
  v
Phase 9 (Test updates) -- runs alongside each phase
```

**Recommended implementation batches**:

| Batch | Phases | Estimated complexity |
|-------|--------|---------------------|
| Batch A | 1 + 2 + 6 | Small (refactor, no new features) |
| Batch B | 3 + 8 | Medium (new UI toggle, new modal section) |
| Batch C | 4 | Medium-Large (sequence handling, visual feedback) |
| Batch D | 5 + 7 | Medium (new shortcuts, hint badges) |
| Batch E | 9 | Small (tests, runs throughout) |

---

## 5. Proposed Final Shortcut Map

### Panels

| Shortcut | Action | WCAG 2.1.4 |
|----------|--------|-------------|
| `,` | Toggle left sidebar | Requires toggle to be ON |
| `.` | Toggle right panel | Requires toggle to be ON |
| `\` | Zen mode (both panels) | Requires toggle to be ON |

### Navigation

| Shortcut | Action | WCAG 2.1.4 |
|----------|--------|-------------|
| `Ctrl+K` | Command palette / search | OK (has modifier) |
| `Alt+N` | Create new page | OK (has modifier) |
| `?` | Show shortcuts help | Requires toggle to be ON |
| `Ctrl+/` | Show shortcuts help | OK (has modifier) |
| `G then P` | Go to Pages | Requires toggle to be ON |
| `G then G` | Go to Graph | Requires toggle to be ON |
| `G then A` | Go to AI | Requires toggle to be ON |
| `G then S` | Go to Settings | Requires toggle to be ON |
| `G then T` | Go to Trash | Requires toggle to be ON |

### Editor

| Shortcut | Action | Scope |
|----------|--------|-------|
| `Ctrl+S` | Save article | Page view, editing |
| `Ctrl+E` | Toggle edit/view mode | Page view |
| `Escape` | Exit edit mode | Page view, editing |

### Actions

| Shortcut | Action | Scope |
|----------|--------|-------|
| `Alt+P` | Pin/Unpin page | Page view |
| `Alt+Shift+D` | Delete page (confirm) | Page view |
| `Alt+I` | AI Improve | Page view |

### Formatting (TipTap, display only)

| Shortcut | Action |
|----------|--------|
| `Ctrl+B` | Bold |
| `Ctrl+I` | Italic |
| `Ctrl+U` | Underline |
| `Ctrl+Z` | Undo |
| `Ctrl+Shift+Z` | Redo |
| `Ctrl+Shift+X` | Strikethrough |
| `` Ctrl+` `` | Inline code |
| `Tab` | Indent list |
| `Shift+Tab` | Outdent list |

### Diagram Lightbox (scoped, display only)

| Shortcut | Action |
|----------|--------|
| `+` | Zoom in |
| `-` | Zoom out |
| `0` | Reset zoom |

---

## 6. Key Decisions and Rationale

| Decision | Rationale |
|----------|-----------|
| "G then X" over `Alt+1/2/3` | Matches Gmail convention, more memorable, leaves Alt+number free for future |
| 800ms sequence timeout (not 500ms) | More accessible; users with motor impairments need more time |
| `Alt+Shift+D` over `Alt+D` or `Alt+Backspace` | `Alt+Backspace` is word-deletion on macOS; `Alt+D` conflicts with browser address bar on Windows/Linux (Firefox/Chrome) |
| `Alt+I` for AI Improve (not `Alt+E`) | `Alt+E` could be confused with `Ctrl+E` (edit toggle); `I` for Improve |
| WCAG toggle over remapping | Toggle is simpler to implement and maintain than a full remapping UI |
| Keep registry as display-only (not binding-source) | The registry already works well for display. Making it the binding source would require a major refactor of the hook pattern. The dual-maintenance cost is acceptable given the registry test that validates all IDs exist. |
| No `Shift` modifier shortcuts | `Shift+letter` produces uppercase, conflicts with typing. Reserve `Shift` for TipTap only. |

---

## 7. Files Summary

### Files to create (2)

| File | Purpose |
|------|---------|
| `frontend/src/shared/lib/platform.ts` | Shared `isMac()` utility |
| `frontend/src/shared/lib/platform.test.ts` | Tests for platform utility |

### Files to modify (11)

| File | Changes |
|------|---------|
| `frontend/src/shared/lib/shortcut-registry.ts` | Add ~10 new entries, add `formatting` category, add `TIPTAP_SHORTCUTS` array, add `scope` field |
| `frontend/src/shared/lib/shortcut-registry.test.ts` | Add tests for new entries, formatting category |
| `frontend/src/shared/hooks/use-keyboard-shortcuts.ts` | Add sequence support, import shared `isMac`, accept toggle parameter |
| `frontend/src/shared/hooks/use-keyboard-shortcuts.test.ts` | Add sequence tests, toggle tests |
| `frontend/src/shared/components/layout/KeyboardShortcutsModal.tsx` | Render from registry, add TipTap section, add toggle switch |
| `frontend/src/shared/components/layout/KeyboardShortcutsModal.test.tsx` | Update assertions for registry-driven content |
| `frontend/src/shared/components/layout/AppLayout.tsx` | Add navigation sequences, remove redundant Escape, add sequence visual indicator |
| `frontend/src/shared/components/layout/AppLayout.test.tsx` | Test sequence navigation |
| `frontend/src/shared/components/ShortcutHint.tsx` | Import shared `isMac` |
| `frontend/src/features/pages/PageViewPage.tsx` | Add Alt+P, Alt+D, Alt+I shortcuts |
| `frontend/src/features/pages/PageViewPage.test.tsx` | Test new shortcuts |
| `frontend/src/shared/components/article/ArticleRightPane.tsx` | Add ShortcutHint to Pin/Delete buttons |
| `frontend/src/stores/ui-store.ts` | Add `shortcutsEnabled` preference |
| `frontend/src/stores/keyboard-shortcuts-store.ts` | Add `pendingSequence` state for visual indicator |
| `frontend/src/shared/components/layout/SidebarTreeView.tsx` | Add title attributes with shortcut sequences to nav items |

---

## 8. Risk Assessment

| Risk | Mitigation |
|------|-----------|
| Sequence detection interferes with normal typing | Sequences only fire outside editable elements; `g` is not prevented, only deferred |
| WCAG toggle confuses users who did not enable shortcuts | Default is `true` (enabled), matching current behavior; toggle is opt-out |
| Alt+key shortcuts conflict with browser menu bar (Windows/Linux) | Alt+P, Alt+D, Alt+I do not correspond to common browser menu accelerators. Test on Windows with Firefox/Chrome. |
| Breaking existing tests | Each phase is incremental; tests are updated alongside code changes |
| Modal becomes too long with TipTap shortcuts | Use collapsible sections or a scrollable layout (already has `max-h-[60vh] overflow-y-auto`) |

---

## Research Sources

- [WCAG 2.1.4 Character Key Shortcuts -- W3C Understanding](https://www.w3.org/WAI/WCAG21/Understanding/character-key-shortcuts.html)
- [WCAG 2.1.1 Keyboard -- W3C Understanding](https://www.w3.org/WAI/WCAG21/Understanding/keyboard.html)
- [Keyboard Navigation: Complete Web Accessibility Guide -- Level Access](https://www.levelaccess.com/blog/keyboard-navigation-complete-web-accessibility-guide/)
- [Designing Keyboard Shortcuts on the Web -- Quentin Golsteyn](https://golsteyn.com/writing/designing-keyboard-shortcuts/)
- [The UX of Keyboard Shortcuts -- Medium](https://medium.com/design-bootcamp/the-art-of-keyboard-shortcuts-designing-for-speed-and-efficiency-9afd717fc7ed)
- [Gmail Keyboard Shortcuts -- Google Support](https://support.google.com/mail/answer/6594?hl=en&co=GENIE.Platform%3DDesktop)
- [Notion Keyboard Shortcuts -- Notion Help Center](https://www.notion.com/help/keyboard-shortcuts)
- [Creating a Keyboard Shortcut Hook in React -- Tania Rascia](https://www.taniarascia.com/keyboard-shortcut-hook-react/)
- [Custom Keyboard Interaction -- NZ Government Accessibility Guide](https://govtnz.github.io/web-a11y-guidance/ka/accessible-ux-best-practices/keyboard-a11y/keyboard-operability/custom-keyboard-interaction.html)
- [WCAG 2.1.4 Character Key Shortcuts Explained -- Stark](https://www.getstark.co/wcag-explained/operable/keyboard-accessible/character-key-shortcuts/)
