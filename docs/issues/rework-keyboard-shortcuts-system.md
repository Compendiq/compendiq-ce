# Issue: Rework keyboard shortcuts for power-user workflow

## Problem

The app has a basic keyboard shortcuts system but it's insufficient for power-user, keyboard-driven workflows:

1. **Only 11 shortcuts exist** — most actions require mouse clicks
2. **Shortcuts are not visible on buttons** — users must press `?` or memorize them
3. **Modal shortcut list is hardcoded** — disconnected from actual definitions, easy to get out of sync
4. **Major actions have no shortcuts** — pin/unpin, delete, navigate pages, toggle AI, sync, embed, etc.
5. **No category for "actions"** — only panels, navigation, and editor categories exist
6. **TipTap editor shortcuts are undocumented** — Ctrl+B, Ctrl+I, etc. exist but aren't shown
7. **Some shortcuts conflict with browsers** — `Ctrl+N` overrides browser "new tab/window"

## Current Shortcut Inventory

### Registered via `useKeyboardShortcuts` hook (11 total)

| Shortcut | Action | Scope | Browser Conflict? |
|----------|--------|-------|:-:|
| `,` | Toggle left sidebar | Global | — |
| `.` | Toggle right panel | Global | — |
| `\` | Toggle both panels (zen mode) | Global | — |
| `Ctrl+K` | Open command palette | Global | — |
| `Ctrl+N` | Create new page | Global | **Yes — new tab/window** |
| `?` | Show shortcuts | Global | — |
| `Ctrl+/` | Show shortcuts | Global | — |
| `Esc` | Close modal | Global | — |
| `Ctrl+S` | Save article | PageView | **Yes — save page** (intentional) |
| `Ctrl+E` | Toggle edit/view | PageView | **Partial — Chrome URL bar** |
| `Esc` | Exit edit mode | PageView | — |

### Component-level (not documented)

| Shortcut | Action | Component |
|----------|--------|-----------|
| `Enter` | Submit | AskMode, GenerateMode, TagEditor |
| `↑↓` | Navigate | CommandPalette, TagEditor |
| `Esc` | Close | CommandPalette, DrawioEditor, ImageLightbox |

### TipTap editor (not documented)

| Shortcut | Action |
|----------|--------|
| `Ctrl+B` | Bold |
| `Ctrl+I` | Italic |
| `Ctrl+Z` | Undo |
| `Ctrl+Shift+Z` | Redo |
| `Ctrl+`` ` | Inline code |
| `Tab/Shift+Tab` | Indent/outdent |

## Architecture Issues

### 1. Hardcoded modal list is disconnected from definitions

The `KeyboardShortcutsModal` has its own hardcoded `getShortcutGroups()` function (line 24-53) that duplicates shortcut info. If a shortcut is added to `AppLayout.tsx` or `PageViewPage.tsx`, the modal must be manually updated separately.

### 2. No centralized shortcut registry

Shortcuts are defined in multiple files with no single source of truth:
- `AppLayout.tsx` — 8 global shortcuts
- `PageViewPage.tsx` — 3 editor shortcuts
- `CommandPalette.tsx` — inline `onKeyDown`
- Various components — inline `onKeyDown`

### 3. No shortcut hint rendering utility

There's no shared component to render keyboard hints on buttons. The only hint is `<kbd>⌘K</kbd>` on the search button (manually coded).

## Affected Files

### Core system
- `frontend/src/shared/hooks/use-keyboard-shortcuts.ts` — hook + types
- `frontend/src/shared/components/layout/KeyboardShortcutsModal.tsx` — modal display
- `frontend/src/shared/components/layout/AppLayout.tsx` — global shortcuts
- `frontend/src/features/pages/PageViewPage.tsx` — editor shortcuts

### Components that need shortcut hints
- `frontend/src/shared/components/layout/SidebarTreeView.tsx` — new folder, new space buttons
- `frontend/src/features/pages/PagesPage.tsx` — page actions, filters
- `frontend/src/features/pages/PageViewPage.tsx` — edit, save, delete buttons
- `frontend/src/shared/components/article/ArticleRightPane.tsx` — pin button
- `frontend/src/features/ai/AiAssistantPage.tsx` — mode switching

## Implementation Plan

### Phase 1: Create a centralized shortcut registry

Replace the scattered shortcut definitions with a single registry in a new file:

Create `frontend/src/shared/lib/shortcut-registry.ts`:

```typescript
export type ShortcutCategory = 'navigation' | 'panels' | 'editor' | 'actions' | 'ai';

export interface ShortcutEntry {
  id: string;                    // Unique identifier (e.g., 'toggle-sidebar')
  key: string;                   // Display label (e.g., 'Ctrl+K')
  keys: string[];                // KeyboardEvent.key values to match
  mod?: boolean;                 // Requires Ctrl/Cmd
  description: string;           // Human-readable description
  category: ShortcutCategory;
  scope?: 'global' | 'page' | 'editor' | 'ai';  // When it's active
}

// Single source of truth for all shortcuts
export const SHORTCUTS: Record<string, ShortcutEntry> = {
  // -- Panels --
  'toggle-sidebar':       { id: 'toggle-sidebar',       key: ',',      keys: [','],       description: 'Toggle left sidebar',                  category: 'panels',     scope: 'global' },
  'toggle-right-panel':   { id: 'toggle-right-panel',   key: '.',      keys: ['.'],       description: 'Toggle right panel',                   category: 'panels',     scope: 'global' },
  'toggle-zen':           { id: 'toggle-zen',           key: '\\',     keys: ['\\'],      description: 'Toggle both panels (zen mode)',         category: 'panels',     scope: 'global' },

  // -- Navigation --
  'command-palette':      { id: 'command-palette',      key: 'Ctrl+K', keys: ['k'],       mod: true,  description: 'Open command palette / search',  category: 'navigation', scope: 'global' },
  'new-page':             { id: 'new-page',             key: 'Alt+N',  keys: ['n'],       mod: false, description: 'Create new page',                category: 'navigation', scope: 'global' },
  'show-shortcuts':       { id: 'show-shortcuts',       key: '?',      keys: ['?'],       description: 'Show keyboard shortcuts',               category: 'navigation', scope: 'global' },
  'go-pages':             { id: 'go-pages',             key: 'G then P', keys: ['p'],     description: 'Go to Pages',                          category: 'navigation', scope: 'global' },
  'go-ai':                { id: 'go-ai',                key: 'G then A', keys: ['a'],     description: 'Go to AI Assistant',                   category: 'navigation', scope: 'global' },
  'go-graph':             { id: 'go-graph',             key: 'G then G', keys: ['g'],     description: 'Go to Graph',                          category: 'navigation', scope: 'global' },
  'go-settings':          { id: 'go-settings',          key: 'G then S', keys: ['s'],     description: 'Go to Settings',                       category: 'navigation', scope: 'global' },

  // -- Editor --
  'save':                 { id: 'save',                 key: 'Ctrl+S', keys: ['s'],       mod: true,  description: 'Save current article',       category: 'editor',     scope: 'page' },
  'toggle-edit':          { id: 'toggle-edit',          key: 'Ctrl+E', keys: ['e'],       mod: true,  description: 'Toggle edit / view mode',    category: 'editor',     scope: 'page' },
  'exit-edit':            { id: 'exit-edit',            key: 'Esc',    keys: ['Escape'],  description: 'Exit edit mode / close modal',          category: 'editor',     scope: 'page' },

  // -- Actions --
  'delete-page':          { id: 'delete-page',          key: 'Alt+Backspace', keys: ['Backspace'], description: 'Delete current page',        category: 'actions',    scope: 'page' },
  'pin-page':             { id: 'pin-page',             key: 'Alt+P',  keys: ['p'],       description: 'Pin / unpin current page',              category: 'actions',    scope: 'page' },
  'sync-page':            { id: 'sync-page',            key: 'Alt+R',  keys: ['r'],       description: 'Sync current page from Confluence',     category: 'actions',    scope: 'page' },
  'embed-page':           { id: 'embed-page',           key: 'Alt+E',  keys: ['e'],       description: 'Embed current page',                   category: 'actions',    scope: 'page' },

  // -- AI --
  'ai-ask':               { id: 'ai-ask',               key: 'Alt+A',  keys: ['a'],       description: 'Switch to AI Ask mode',                category: 'ai',         scope: 'global' },
  'ai-generate':          { id: 'ai-generate',          key: 'Alt+G',  keys: ['g'],       description: 'Switch to AI Generate mode',            category: 'ai',         scope: 'global' },
};

/** Get all shortcuts for a given scope. */
export function getShortcutsForScope(scope: string): ShortcutEntry[] {
  return Object.values(SHORTCUTS).filter((s) => s.scope === scope || s.scope === 'global');
}

/** Get all shortcuts grouped by category (for the modal). */
export function getShortcutGroups(): Array<{ title: string; shortcuts: ShortcutEntry[] }> {
  const groups = new Map<string, ShortcutEntry[]>();
  for (const entry of Object.values(SHORTCUTS)) {
    const list = groups.get(entry.category) || [];
    list.push(entry);
    groups.set(entry.category, list);
  }
  return Array.from(groups.entries()).map(([title, shortcuts]) => ({
    title: title.charAt(0).toUpperCase() + title.slice(1),
    shortcuts,
  }));
}

/** Look up a shortcut by ID (for rendering hints on buttons). */
export function getShortcutHint(id: string): string | undefined {
  return SHORTCUTS[id]?.key;
}
```

### Phase 2: Fix browser-conflicting shortcuts

Replace `Ctrl+N` (new tab conflict) with a non-conflicting alternative:

| Current | Proposed | Reason |
|---------|----------|--------|
| `Ctrl+N` (new page) | `Alt+N` | `Ctrl+N` opens a new browser tab/window |

Use `Alt+` modifier for app-specific actions that don't conflict with browser or OS shortcuts.

**Safe Alt+ shortcuts** (don't conflict with browsers):
- `Alt+N` — New page
- `Alt+P` — Pin/unpin page
- `Alt+R` — Refresh/sync page
- `Alt+E` — Embed page
- `Alt+A` — AI Ask mode
- `Alt+G` — AI Generate mode
- `Alt+Backspace` — Delete page

Update `useKeyboardShortcuts` to support `alt` modifier:

```diff
  export interface ShortcutDefinition {
    key: string;
    keys: string[];
    mod?: boolean;      // Ctrl/Cmd
+   alt?: boolean;      // Alt/Option
    description: string;
    category: ShortcutCategory;
    action: () => void;
  }
```

### Phase 3: Add "G then X" navigation sequences (vim-style)

Implement two-key sequences for navigation (no browser conflicts, no modifier needed):

- `G → P` — Go to Pages
- `G → A` — Go to AI Assistant
- `G → G` — Go to Graph
- `G → S` — Go to Settings

Implementation: add a `pendingKey` state to the hook. When `G` is pressed, set a 500ms timeout. If a second key arrives within the timeout, execute the sequence. If not, cancel.

```typescript
// In use-keyboard-shortcuts.ts
let pendingPrefix: string | null = null;
let pendingTimeout: ReturnType<typeof setTimeout> | null = null;

function handleKeyDown(event: KeyboardEvent) {
  // Check for sequence completions first
  if (pendingPrefix) {
    const seqKey = `${pendingPrefix} then ${event.key}`;
    clearTimeout(pendingTimeout!);
    pendingPrefix = null;

    const match = shortcuts.find(s => s.key === seqKey);
    if (match) {
      event.preventDefault();
      match.action();
      return;
    }
  }

  // Check for sequence starters (e.g., 'G')
  const startsSequence = shortcuts.some(s => s.key.startsWith(`${event.key} then `));
  if (startsSequence && !isEditableTarget(event)) {
    pendingPrefix = event.key;
    pendingTimeout = setTimeout(() => { pendingPrefix = null; }, 500);
    return;
  }

  // Normal single-key matching...
}
```

### Phase 4: Create `<ShortcutHint>` component for buttons

Create a reusable component to display shortcut hints on buttons:

`frontend/src/shared/components/ShortcutHint.tsx`:

```tsx
import { getShortcutHint } from '../lib/shortcut-registry';

interface ShortcutHintProps {
  shortcutId: string;
  className?: string;
}

/** Renders a compact keyboard shortcut badge next to a button label. */
export function ShortcutHint({ shortcutId, className }: ShortcutHintProps) {
  const hint = getShortcutHint(shortcutId);
  if (!hint) return null;

  const isMac = /Mac|iPhone|iPad/.test(navigator.platform ?? '');
  const display = hint
    .replace('Ctrl+', isMac ? '⌘' : 'Ctrl+')
    .replace('Alt+', isMac ? '⌥' : 'Alt+');

  return (
    <kbd className={cn(
      'ml-auto rounded border border-border/40 bg-background/50 px-1 py-0.5 text-[10px] font-mono text-muted-foreground/60',
      className,
    )}>
      {display}
    </kbd>
  );
}
```

Usage on buttons:

```tsx
<button onClick={handleSave} title="Save (Ctrl+S)">
  <Save size={14} /> Save <ShortcutHint shortcutId="save" />
</button>

<button onClick={toggleEdit} title="Edit (Ctrl+E)">
  <Pencil size={14} /> Edit <ShortcutHint shortcutId="toggle-edit" />
</button>

<button onClick={handlePin} title="Pin (Alt+P)">
  <Pin size={14} /> Pin <ShortcutHint shortcutId="pin-page" />
</button>
```

### Phase 5: Generate `KeyboardShortcutsModal` from registry

Replace the hardcoded `getShortcutGroups()` in the modal with the centralized registry:

```diff
- import { getShortcutGroups } from './shortcut-helpers';
+ import { getShortcutGroups } from '../../lib/shortcut-registry';

  export function KeyboardShortcutsModal() {
    const groups = getShortcutGroups();
    // ... render groups
  }
```

Add the new categories to the modal: "Actions" and "AI".

Also add a new section for TipTap editor shortcuts (static, since they come from the library):

```typescript
const editorFormattingShortcuts = [
  { key: 'Ctrl+B', description: 'Bold' },
  { key: 'Ctrl+I', description: 'Italic' },
  { key: 'Ctrl+Z', description: 'Undo' },
  { key: 'Ctrl+Shift+Z', description: 'Redo' },
  { key: 'Tab', description: 'Indent list' },
  { key: 'Shift+Tab', description: 'Outdent list' },
];
```

### Phase 6: Add shortcut hints to existing buttons

Add `<ShortcutHint>` or `title` attributes to key buttons across the app:

| Button | File | Shortcut |
|--------|------|----------|
| Save | `PageViewPage.tsx` | `Ctrl+S` |
| Edit/View toggle | `PageViewPage.tsx` | `Ctrl+E` |
| Pin/Unpin | `ArticleRightPane.tsx` | `Alt+P` |
| Delete | `PageViewPage.tsx` | `Alt+Backspace` |
| New Page | `PagesPage.tsx` | `Alt+N` |
| New Folder | `SidebarTreeView.tsx` | (title only) |
| Search | `AppLayout.tsx` | `Ctrl+K` (already shown) |
| Sidebar toggle | `SidebarTreeView.tsx` | `,` (already in title) |

For space-constrained buttons, use `title` attribute only. For prominent buttons, use inline `<ShortcutHint>`.

### Phase 7: Add new shortcuts for missing actions

Register action handlers for the new shortcuts defined in the registry:

**In `PageViewPage.tsx`:**
```typescript
const shortcuts = [
  // Existing
  { ...SHORTCUTS['save'], action: handleSave },
  { ...SHORTCUTS['toggle-edit'], action: toggleEdit },
  { ...SHORTCUTS['exit-edit'], action: exitEdit },
  // New
  { ...SHORTCUTS['delete-page'], alt: true, action: handleDelete },
  { ...SHORTCUTS['pin-page'], alt: true, action: togglePin },
  { ...SHORTCUTS['sync-page'], alt: true, action: handleSync },
  { ...SHORTCUTS['embed-page'], alt: true, action: handleEmbed },
];
useKeyboardShortcuts(shortcuts);
```

**In `AppLayout.tsx`:**
```typescript
const shortcuts = [
  // Existing
  { ...SHORTCUTS['toggle-sidebar'], action: toggleTreeSidebar },
  { ...SHORTCUTS['command-palette'], action: openCommandPalette },
  // Updated
  { ...SHORTCUTS['new-page'], alt: true, action: () => navigate('/pages/new') },
  // New navigation sequences
  { ...SHORTCUTS['go-pages'], action: () => navigate('/') },
  { ...SHORTCUTS['go-ai'], action: () => navigate('/ai') },
  { ...SHORTCUTS['go-graph'], action: () => navigate('/graph') },
  { ...SHORTCUTS['go-settings'], action: () => navigate('/settings') },
];
useKeyboardShortcuts(shortcuts);
```

### Phase 8: Update tests

**Hook tests** (`use-keyboard-shortcuts.test.ts`):
- Test `alt` modifier support
- Test two-key sequences (`G then P`)
- Test sequence timeout cancellation
- Test Alt shortcuts don't conflict with browser

**Modal tests** (`KeyboardShortcutsModal.test.tsx`):
- Test modal renders all categories from registry
- Test new categories (Actions, AI) are displayed
- Test TipTap shortcuts section renders

**Integration tests:**
- Test `<ShortcutHint>` renders correct key for current platform
- Test shortcut hints appear on buttons
- Test new shortcuts trigger correct actions

## Proposed Final Shortcut Map

### Panels
| Shortcut | Action |
|----------|--------|
| `,` | Toggle left sidebar |
| `.` | Toggle right panel |
| `\` | Toggle both panels (zen mode) |

### Navigation
| Shortcut | Action |
|----------|--------|
| `Ctrl+K` | Open command palette / search |
| `Alt+N` | Create new page |
| `?` | Show keyboard shortcuts |
| `Ctrl+/` | Show keyboard shortcuts |
| `G → P` | Go to Pages |
| `G → A` | Go to AI Assistant |
| `G → G` | Go to Graph |
| `G → S` | Go to Settings |

### Editor
| Shortcut | Action |
|----------|--------|
| `Ctrl+S` | Save article |
| `Ctrl+E` | Toggle edit/view mode |
| `Esc` | Exit edit mode / close modal |
| `Ctrl+B` | Bold (TipTap) |
| `Ctrl+I` | Italic (TipTap) |
| `Ctrl+Z` | Undo (TipTap) |
| `Ctrl+Shift+Z` | Redo (TipTap) |

### Actions
| Shortcut | Action |
|----------|--------|
| `Alt+P` | Pin / unpin current page |
| `Alt+Backspace` | Delete current page |
| `Alt+R` | Sync current page |
| `Alt+E` | Embed current page |

### AI
| Shortcut | Action |
|----------|--------|
| `Alt+A` | Switch to AI Ask mode |
| `Alt+G` | Switch to AI Generate mode |

## Acceptance Criteria

- [ ] Centralized shortcut registry as single source of truth
- [ ] `KeyboardShortcutsModal` generated from registry (not hardcoded)
- [ ] No browser-conflicting shortcuts (`Ctrl+N` replaced with `Alt+N`)
- [ ] `Alt+` modifier supported in the hook for app-specific actions
- [ ] Two-key sequences work (`G → P`, `G → A`, etc.) with 500ms timeout
- [ ] `<ShortcutHint>` component renders platform-aware keyboard badges
- [ ] Key buttons show their shortcuts (Save, Edit, Pin, Delete, New Page, etc.)
- [ ] TipTap editor shortcuts documented in the modal
- [ ] New action shortcuts work (pin, delete, sync, embed)
- [ ] New navigation shortcuts work (go-to pages/ai/graph/settings)
- [ ] All shortcuts avoid browser/OS conflicts
- [ ] All existing shortcut tests pass
- [ ] New tests cover Alt modifier, sequences, registry, and hint component
