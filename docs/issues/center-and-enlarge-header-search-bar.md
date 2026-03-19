# Issue: Center the search bar in the header and make it larger

## Problem

The search bar (CommandPalette trigger button) is currently a small, auto-sized button tucked into the right side of the header next to the theme toggle and user menu. It's easy to overlook and doesn't communicate that search is a primary action.

## Current Layout

```
┌─ HEADER (h-11, glass-header) ─────────────────────────────────────────────────┐
│ [☰] [Logo AtlasMind]  [Breadcrumb ... flex-1 ...]   [🔍Search ⌘K] [🌙] [👤] │
│      ← fixed →        ← stretches to fill →         ← right, auto-width →    │
└───────────────────────────────────────────────────────────────────────────────┘
```

**Problems:**
- Search button is **auto-width** (~110px), same visual weight as theme toggle
- Positioned in the **right cluster** with theme/user — not prominent
- Breadcrumb takes `flex-1` and pushes search to the far right
- Small `text-xs` (12px) and `py-1` (4px vertical padding) make it barely visible
- Doesn't signal that search is a primary navigation method

## Desired Layout

```
┌─ HEADER (h-11, glass-header) ─────────────────────────────────────────────────┐
│ [☰] [Logo AtlasMind]  [    🔍 Search pages...  ⌘K    ]          [🌙] [👤]   │
│      ← fixed →        ← centered, larger, flex-1 →              ← right →    │
└───────────────────────────────────────────────────────────────────────────────┘
```

The search bar should:
- Be **centered** in the header, taking available space between logo and right actions
- Be **larger** — taller, wider, with a more prominent appearance
- Look like a search input (even though it opens a modal on click)
- Replace the breadcrumb's `flex-1` role or share the center space

## Current Code

`AppLayout.tsx:140-178`:
```tsx
<header className="... flex h-11 ... items-center ... px-4">
  {/* Mobile hamburger */}
  <button className="... md:hidden"> ... </button>

  {/* Logo */}
  <Link to="/" className="... mr-3"> AtlasMind </Link>

  {/* Breadcrumb — takes all remaining space */}
  <div className="flex min-w-0 flex-1 items-center">
    <Breadcrumb />
  </div>

  {/* Right side: search + theme + user */}
  <div className="flex items-center gap-3 ml-3">
    <button onClick={openCommandPalette}
      className="flex items-center gap-1.5 rounded-lg bg-foreground/5 px-2.5 py-1 text-xs text-muted-foreground hover:bg-foreground/8">
      <Search size={12} />
      <span className="hidden sm:inline">Search...</span>
      <kbd>⌘K</kbd>
    </button>
    <ThemeToggle />
    <UserMenu />
  </div>
</header>
```

## Affected Files

- `frontend/src/shared/components/layout/AppLayout.tsx` — header layout (lines 140-178)
- `frontend/src/shared/components/layout/AppLayout.test.tsx` — update tests

## Implementation Plan

### Phase 1: Move search bar to center position with `flex-1`

Restructure the header into three clear sections: left (logo), center (search), right (theme + user). Move the search button out of the right-side `<div>` and give it its own centered position:

```diff
  <header className="... flex h-11 ... items-center ... px-4">
    {/* Mobile hamburger */}
    <button className="... md:hidden"> ... </button>

    {/* Logo */}
    <Link to="/" className="... mr-3"> AtlasMind </Link>

-   {/* Breadcrumb — takes all remaining space */}
-   <div className="flex min-w-0 flex-1 items-center">
-     <Breadcrumb />
-   </div>
-
-   {/* Right side: search + theme + user */}
-   <div className="flex items-center gap-3 ml-3">
-     <button onClick={openCommandPalette} className="...">
-       <Search size={12} />
-       <span>Search...</span>
-       <kbd>⌘K</kbd>
-     </button>
+   {/* Center: search bar — takes available space */}
+   <button
+     onClick={openCommandPalette}
+     className="mx-4 flex flex-1 items-center gap-2 rounded-xl bg-foreground/5 px-3 py-1.5 text-sm text-muted-foreground hover:bg-foreground/8 transition-colors max-w-xl"
+   >
+     <Search size={14} />
+     <span className="hidden sm:inline">Search pages...</span>
+     <kbd className="ml-auto hidden rounded border border-border/50 px-1.5 py-0.5 text-[10px] sm:inline">
+       {navigator.platform?.includes('Mac') ? '\u2318' : 'Ctrl'}K
+     </kbd>
+   </button>
+
+   {/* Right side: theme + user */}
+   <div className="flex items-center gap-3 ml-3">
      <ThemeToggle />
      <UserMenu />
    </div>
  </header>
```

Key changes:
- `flex-1` — search bar stretches to fill available center space
- `max-w-xl` (576px) — caps maximum width so it doesn't stretch too wide on ultrawide monitors
- `mx-4` — margins to separate from logo and right section
- `rounded-xl` — matches the header's border radius style
- `py-1.5` and `text-sm` — taller and larger text than current `py-1` / `text-xs`
- `Search size={14}` — slightly larger icon (was 12)
- `ml-auto` on `<kbd>` — pushes keyboard shortcut to the right edge

### Phase 2: Relocate breadcrumb

The breadcrumb currently occupies the center space. Options:

**Option A (recommended)**: Remove breadcrumb from header entirely — the sidebar tree already shows navigation context, and the page title is in the page view.

**Option B**: Move breadcrumb below the header as a secondary bar (increases vertical space usage).

**Option C**: Show breadcrumb inside the search bar as subtle text when not on a page.

For Option A, simply remove the breadcrumb div:
```diff
- {/* Breadcrumb — takes all remaining space */}
- <div className="flex min-w-0 flex-1 items-center">
-   <Breadcrumb />
- </div>
```

### Phase 3: Make search bar visually prominent

Enhance the search bar styling to look like a proper search input:

```tsx
<button
  onClick={openCommandPalette}
  className={cn(
    'mx-4 flex flex-1 items-center gap-2 max-w-xl',
    'rounded-xl border border-border/30 bg-foreground/5 px-3 py-1.5',
    'text-sm text-muted-foreground',
    'hover:bg-foreground/8 hover:border-border/50',
    'transition-colors',
  )}
>
  <Search size={14} className="shrink-0" />
  <span className="hidden sm:inline">Search pages...</span>
  <kbd className="ml-auto hidden rounded border border-border/50 px-1.5 py-0.5 text-[10px] font-mono sm:inline">
    {navigator.platform?.includes('Mac') ? '\u2318' : 'Ctrl'}K
  </kbd>
</button>
```

Additions:
- `border border-border/30` — subtle border makes it look like an input field
- `hover:border-border/50` — border highlights on hover
- `font-mono` on kbd — monospace for keyboard shortcut

### Phase 4: Mobile responsive adjustments

On mobile (< sm), the search text is already hidden. Ensure the centered search bar still works:

```tsx
{/* On mobile, show a compact search icon button */}
<button
  onClick={openCommandPalette}
  className={cn(
    'mx-2 flex items-center gap-2 sm:mx-4 sm:flex-1 sm:max-w-xl',
    'rounded-xl border border-border/30 bg-foreground/5',
    'px-2 py-1.5 sm:px-3',
    'text-sm text-muted-foreground',
    'hover:bg-foreground/8 hover:border-border/50 transition-colors',
  )}
>
  <Search size={14} className="shrink-0" />
  <span className="hidden sm:inline">Search pages...</span>
  <kbd className="ml-auto hidden rounded border border-border/50 px-1.5 py-0.5 text-[10px] font-mono sm:inline">
    {navigator.platform?.includes('Mac') ? '\u2318' : 'Ctrl'}K
  </kbd>
</button>
```

- `sm:flex-1 sm:max-w-xl` — only expands on sm+ screens
- `mx-2 sm:mx-4` — smaller margins on mobile
- `px-2 sm:px-3` — tighter padding on mobile

### Phase 5: Update tests

Update `AppLayout.test.tsx`:
- Test search bar is centered (has `flex-1` class)
- Test search bar has larger dimensions
- Test breadcrumb is removed (if Option A chosen)
- Test search button still opens CommandPalette
- Test mobile layout (search icon only, no flex-1)

## Acceptance Criteria

- [ ] Search bar is centered in the header between logo and right actions
- [ ] Search bar takes available space (`flex-1`) with `max-w-xl` cap
- [ ] Search bar is larger — taller padding (`py-1.5`), bigger text (`text-sm`), bigger icon (14px)
- [ ] Search bar has input-like appearance (subtle border)
- [ ] Keyboard shortcut hint (`⌘K` / `Ctrl+K`) is right-aligned inside the bar
- [ ] Clicking the search bar still opens CommandPalette
- [ ] `Ctrl+K` / `⌘K` keyboard shortcut still works
- [ ] Mobile layout works — compact search icon, no stretching
- [ ] Breadcrumb handled (removed or relocated)
- [ ] All existing layout tests pass
