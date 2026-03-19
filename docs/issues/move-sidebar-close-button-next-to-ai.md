# Issue: Move sidebar collapse button to the right of the AI navigation tab

## Problem

The sidebar collapse button (`PanelLeftClose` icon) is currently placed in the **"Pages" section header row**, far from the navigation tabs. Users expect it to be at the top of the sidebar, next to the navigation, where it's more discoverable and accessible.

## Current Layout

```
┌─ NAV TABS ─────────────────────────────┐
│  [Pages]     [Graph]     [AI]          │  ← No close button here
├─ SECTION HEADER ───────────────────────┤
│  Pages       [📂+]  [+]  [◀ Close]    │  ← Close button buried here
├─ SPACE SELECTOR ───────────────────────┤
│  [All Spaces ▼]                        │
├─ PAGE TREE ────────────────────────────┤
│  📄 Homepage                           │
│  📂 Engineering                        │
│    📄 Setup Guide                      │
└────────────────────────────────────────┘
```

**Problem**: The collapse button is in the "Pages" header row alongside "Create Folder" and "Create Space" buttons. It's visually grouped with page actions, not with sidebar navigation. When the user wants to close the sidebar, they have to scan past the nav tabs to find it.

## Desired Layout

```
┌─ NAV TABS ─────────────────────────────┐
│  [Pages]  [Graph]  [AI]  [◀ Close]    │  ← Close button here
├─ SECTION HEADER ───────────────────────┤
│  Pages              [📂+]  [+]        │  ← Only page actions remain
├─ SPACE SELECTOR ───────────────────────┤
│  [All Spaces ▼]                        │
├─ PAGE TREE ────────────────────────────┤
│  📄 Homepage                           │
│  📂 Engineering                        │
│    📄 Setup Guide                      │
└────────────────────────────────────────┘
```

The collapse button moves to the nav tabs row, right of the AI button, consistent with the pattern of sidebar toggles being at the top of the sidebar.

## Current Code

**Nav tabs** (`SidebarTreeView.tsx:496-518`):
```tsx
<nav className="flex shrink-0 items-center gap-0.5 px-2 pt-2 pb-1">
  {navItems.map(({ icon: Icon, label, path }) => (
    <Link key={path} to={path} className="flex flex-1 items-center justify-center ...">
      <Icon size={14} /> {label}
    </Link>
  ))}
  {/* No collapse button here */}
</nav>
```

**Section header** (`SidebarTreeView.tsx:520-552`):
```tsx
<div className="flex h-8 shrink-0 items-center justify-between px-3">
  <span>Pages</span>
  <div className="flex items-center gap-1">
    <button><FolderPlus /></button>   {/* Create Folder */}
    <button><Plus /></button>          {/* Create Space */}
    <button><PanelLeftClose /></button> {/* Collapse — MOVE THIS */}
  </div>
</div>
```

## Affected Files

- `frontend/src/shared/components/layout/SidebarTreeView.tsx` — lines 496-551
- `frontend/src/shared/components/layout/SidebarTreeView.test.tsx` — update button location tests

## Implementation Plan

### Phase 1: Move collapse button to nav tabs row

In `SidebarTreeView.tsx`, move the `PanelLeftClose` button from the section header (line 543-550) into the nav tabs `<nav>` element (after line 517):

```diff
  <nav className="flex shrink-0 items-center gap-0.5 px-2 pt-2 pb-1" aria-label="Main navigation">
    {navItems.map(({ icon: Icon, label, path }) => {
      // ... existing nav link rendering
    })}
+   <button
+     onClick={toggleTreeSidebar}
+     className="rounded-lg p-1.5 text-muted-foreground hover:bg-[var(--glass-pill-hover)] hover:text-foreground transition-all duration-200"
+     aria-label="Collapse sidebar"
+     title="Collapse sidebar (,)"
+   >
+     <PanelLeftClose size={14} />
+   </button>
  </nav>
```

Note: The button uses `p-1.5` to match the nav item padding, and does **not** use `flex-1` so it stays compact while the nav links share equal width.

### Phase 2: Remove collapse button from section header

Remove the collapse button from the "Pages" section header, keeping only the page action buttons:

```diff
  <div className="flex h-8 shrink-0 items-center justify-between px-3">
    <span className="text-xs font-semibold text-muted-foreground/60">Pages</span>
    <div className="flex items-center gap-1">
      <button> <FolderPlus size={14} /> </button>
      <button> <Plus size={14} /> </button>
-     <button onClick={toggleTreeSidebar}>
-       <PanelLeftClose size={14} />
-     </button>
    </div>
  </div>
```

### Phase 3: Adjust nav tabs spacing

The nav tabs row now has 3 flex-1 links + 1 fixed-width button. Ensure the layout doesn't break:

- Nav links: `flex-1` (share available space equally)
- Collapse button: fixed width (no `flex-1`)
- Add a subtle separator or slight gap before the collapse button for visual separation:

```tsx
<nav className="flex shrink-0 items-center gap-0.5 px-2 pt-2 pb-1">
  {navItems.map(/* ... */)}
  <div className="mx-0.5 h-4 w-px bg-border/30" />  {/* Optional subtle divider */}
  <button onClick={toggleTreeSidebar} ...>
    <PanelLeftClose size={14} />
  </button>
</nav>
```

### Phase 4: Update tests

Update `SidebarTreeView.test.tsx`:
- Test that collapse button is within the `<nav>` element
- Test that collapse button is after the AI nav link
- Test that clicking collapse button still toggles sidebar state
- Test that "Pages" section header no longer contains the collapse button

## Acceptance Criteria

- [ ] Collapse button appears to the right of the AI tab in the nav row
- [ ] Collapse button no longer appears in the "Pages" section header
- [ ] Collapse button click still toggles sidebar open/closed
- [ ] Keyboard shortcut (`,`) still works
- [ ] Nav tabs (Pages, Graph, AI) retain equal width and aren't squeezed
- [ ] Collapse button is visually distinct from nav tabs (not flex-1)
- [ ] Layout looks correct at different sidebar widths (180px–600px)
- [ ] Mobile sidebar behavior unchanged
- [ ] Existing tests updated and passing
