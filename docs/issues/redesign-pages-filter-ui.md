# Issue: Redesign the PagesPage filter UI for better aesthetics and usability

## Problem

The filter section on the Pages page works functionally but feels visually cluttered and plain:

1. **Native `<select>` elements** — look like OS-default dropdowns, break the glassmorphic design language used everywhere else
2. **Advanced filters are a wall of dropdowns** — 7 selects + 2 date inputs in a single `flex-wrap` row that wraps unpredictably
3. **No active filter indication** — only a count badge on the toggle button; user can't see at a glance *which* filters are active
4. **Labels filter is single-select** — labels are inherently multi-value but the dropdown only allows selecting one
5. **Search input has no clear button** — must manually select and delete text
6. **Date inputs use wrong CSS class** — `glass-select` applied to `<input type="date">`
7. **Sort mixed with filters** — sort dropdown sits alongside filters with no visual separation
8. **No mobile responsiveness** — hardcoded `min-w-*` values cause horizontal overflow on small screens

## Current Layout

```
┌─ GLASS-CARD ────────────────────────────────────────────────────────────┐
│ [🔍 Search pages...      ] [All Spaces ▼] [All Sources ▼] [Sort ▼]    │
│                                                        [🔽 Filters (3)]│
├─ border-t (when expanded) ──────────────────────────────────────────────┤
│ Author        Labels       Freshness     Embedding    Quality          │
│ [All ▼]      [All ▼]      [Any ▼]       [Any ▼]      [Any ▼]         │
│ Modified From  Modified To                                              │
│ [📅 ____]     [📅 ____]                            [✕ Clear filters]  │
└─────────────────────────────────────────────────────────────────────────┘
```

**Issues visible:**
- All native `<select>` — no glassmorphic styling on dropdown menus (only the trigger)
- Advanced filters are a flat grid of labeled dropdowns — no visual hierarchy
- Wrapping is arbitrary based on viewport width — no structured grid
- Sort looks identical to filters — no visual distinction
- No pills showing "Author: John" or "Freshness: Stale" for active filters

## Affected Files

- `frontend/src/features/pages/PagesPage.tsx` — filter section (lines 221-410)
- `frontend/src/index.css` — `glass-select`, `glass-input` utilities
- `frontend/src/features/search/SearchPage.tsx` — has same pattern (for consistency)

## Implementation Plan

### Phase 1: Add active filter pills below the search bar

Show dismissible pills for each active filter so users can see and remove filters at a glance:

```tsx
{/* Active filter pills */}
{activeFilterCount > 0 && (
  <div className="flex flex-wrap items-center gap-1.5">
    {author && (
      <FilterPill label="Author" value={author} onClear={() => { setAuthor(''); setPage(1); }} />
    )}
    {labels && (
      <FilterPill label="Labels" value={labels} onClear={() => { setLabels(''); setPage(1); }} />
    )}
    {freshness && (
      <FilterPill label={freshnessLabels[freshness]} onClear={() => { setFreshness(''); setPage(1); }} />
    )}
    {/* ... more pills ... */}
    <button onClick={clearAllFilters} className="text-xs text-muted-foreground hover:text-foreground">
      Clear all
    </button>
  </div>
)}
```

Create a `FilterPill` component:
```tsx
function FilterPill({ label, value, onClear }: { label: string; value?: string; onClear: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-primary/20 bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
      {label}{value ? `: ${value}` : ''}
      <button onClick={onClear} className="ml-0.5 rounded-full p-0.5 hover:bg-primary/20">
        <X size={10} />
      </button>
    </span>
  );
}
```

### Phase 2: Visually separate sort from filters

Move the sort selector out of the filter row and give it a distinct visual treatment:

```tsx
<div className="flex flex-wrap items-center gap-3">
  {/* Search — takes available space */}
  <div className="relative flex-1 min-w-48">
    <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
    <input ... className="glass-input pl-10 pr-8" />
    {search && (
      <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 ...">
        <X size={14} />
      </button>
    )}
  </div>

  {/* Vertical divider */}
  <div className="h-7 w-px bg-border/40" />

  {/* Sort — visually separated */}
  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
    <ArrowUpDown size={12} />
    <select value={sort} ... className="glass-select">
      ...
    </select>
  </div>

  {/* Vertical divider */}
  <div className="h-7 w-px bg-border/40" />

  {/* Filter controls */}
  <select ... className="glass-select">All Spaces</select>
  <select ... className="glass-select">All Sources</select>
  <button ...>Filters (3)</button>
</div>
```

### Phase 3: Restructure advanced filters into a grouped grid

Replace the flat `flex-wrap` with organized groups using a CSS grid:

```tsx
{showAdvancedFilters && (
  <div className="border-t border-border/40 pt-3">
    <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
      {/* Content filters */}
      <FilterField label="Author">
        <select ...>...</select>
      </FilterField>
      <FilterField label="Labels">
        <select ...>...</select>
      </FilterField>

      {/* Status filters */}
      <FilterField label="Freshness">
        <select ...>...</select>
      </FilterField>
      <FilterField label="Quality">
        <select ...>...</select>
      </FilterField>

      {/* Technical filters */}
      <FilterField label="Embedding">
        <select ...>...</select>
      </FilterField>

      {/* Date range — spans 2 columns */}
      <div className="col-span-2 grid grid-cols-2 gap-3">
        <FilterField label="Modified from">
          <input type="date" ... className="glass-input w-full" />
        </FilterField>
        <FilterField label="Modified to">
          <input type="date" ... className="glass-input w-full" />
        </FilterField>
      </div>
    </div>

    {/* Clear button — right-aligned below grid */}
    {activeFilterCount > 0 && (
      <div className="mt-3 flex justify-end">
        <button onClick={clearAllFilters} ...>Clear filters</button>
      </div>
    )}
  </div>
)}
```

Create a `FilterField` wrapper for consistent label + input styling:
```tsx
function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-[11px] font-medium text-muted-foreground/70">{label}</label>
      {children}
    </div>
  );
}
```

**Responsive grid:**
- `grid-cols-2` on mobile (< sm)
- `sm:grid-cols-3` on tablet
- `lg:grid-cols-4` on desktop

### Phase 4: Add clear button to search input

Add an `X` button inside the search input when text is present:

```diff
  <div className="relative flex-1 min-w-48">
    <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
    <input
      type="text"
      placeholder="Search pages..."
      value={search}
      onChange={(e) => { setSearch(e.target.value); setPage(1); }}
-     className="glass-input pl-10 pr-4"
+     className="glass-input pl-10 pr-8"
    />
+   {search && (
+     <button
+       onClick={() => { setSearch(''); setPage(1); }}
+       className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
+     >
+       <X size={14} />
+     </button>
+   )}
  </div>
```

### Phase 5: Fix date inputs CSS class

Replace `glass-select` with `glass-input` on date inputs:

```diff
- <input type="date" ... className="glass-select w-full" />
+ <input type="date" ... className="glass-input w-full" />
```

### Phase 6: Enhance freshness and quality filters with color coding

Add colored dots next to filter options to match the existing badge colors used in the page list:

```tsx
// Freshness options with status colors
<option value="fresh">🟢 Fresh (&lt;7 days)</option>
<option value="recent">🔵 Recent (7-30 days)</option>
<option value="aging">🟡 Aging (30-90 days)</option>
<option value="stale">🔴 Stale (&gt;90 days)</option>
```

Or better — when replacing with custom components in Phase 7, render actual colored dots:
```tsx
<div className="flex items-center gap-2">
  <span className="h-2 w-2 rounded-full bg-green-500" />
  Fresh (&lt;7 days)
</div>
```

### Phase 7: Replace native selects with custom Popover selects (optional enhancement)

For filters that benefit from richer rendering (color dots, multi-select, search), replace native `<select>` with Radix Popover-based custom selects:

**Priority replacements:**
1. **Labels** — needs multi-select with checkboxes (most impactful)
2. **Freshness** — would benefit from colored status dots
3. **Quality** — would benefit from colored score indicators

Example using Radix Popover for Labels multi-select:
```tsx
<Popover.Root>
  <Popover.Trigger asChild>
    <button className="glass-select w-full text-left">
      {selectedLabels.length > 0
        ? `${selectedLabels.length} labels`
        : 'All Labels'}
    </button>
  </Popover.Trigger>
  <Popover.Content className="glass-card max-h-48 overflow-y-auto p-1">
    {filterOptions?.labels.map((label) => (
      <label key={label} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-foreground/5">
        <input type="checkbox" checked={selectedLabels.includes(label)} onChange={...} />
        {label}
      </label>
    ))}
  </Popover.Content>
</Popover.Root>
```

**Keep native `<select>` for:** Space, Source, Sort, Embedding (simple single-select, few options).

### Phase 8: Mobile responsive adjustments

Remove hardcoded `min-w-*` values and use responsive classes:

```diff
- <div className="min-w-40">
+ <div className="w-full sm:w-auto">
```

Adjust the main filter row to stack on mobile:
```diff
- <div className="flex flex-wrap items-center gap-3">
+ <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
```

Search input should be full-width on mobile:
```diff
- <div className="relative flex-1 min-w-48">
+ <div className="relative w-full sm:flex-1 sm:min-w-48">
```

### Phase 9: Update tests

- Test filter pills render for each active filter
- Test clicking pill `X` clears that specific filter
- Test "Clear all" removes all pills
- Test search clear button appears and works
- Test grid layout renders correctly
- Test responsive breakpoints (mock viewport)
- Test date inputs use correct `glass-input` class

## Proposed Final Layout

```
┌─ GLASS-CARD ────────────────────────────────────────────────────────────┐
│ [🔍 Search pages...        ✕]  │  [↕ Modified ▼]  │  [Spaces ▼]      │
│                                 │                    │  [Sources ▼]     │
│                                 │                    │  [🔽 Filters (3)]│
├─ Filter pills ──────────────────────────────────────────────────────────┤
│ [Author: John ✕] [🟡 Aging ✕] [Quality: Good ✕]           Clear all  │
├─ Advanced (grid, when expanded) ────────────────────────────────────────┤
│ Author           Labels (multi)   Freshness          Quality           │
│ [All Authors ▼]  [2 labels ▼]    [🟢 Fresh    ▼]   [⭐ Good     ▼]  │
│                                                                         │
│ Embedding        Modified from    Modified to                           │
│ [Any ▼]          [📅 2025-01-01]  [📅 2025-03-19]                     │
│                                                    [✕ Clear filters]   │
└─────────────────────────────────────────────────────────────────────────┘
```

## Acceptance Criteria

- [ ] Active filters show as dismissible pills below the search row
- [ ] Each pill shows filter name + value with a close button
- [ ] "Clear all" link removes all active filters
- [ ] Sort is visually separated from filters (divider)
- [ ] Search input has a clear (X) button when text is present
- [ ] Advanced filters use a structured responsive grid (2/3/4 columns)
- [ ] Date inputs use `glass-input` class (not `glass-select`)
- [ ] Filter layout stacks vertically on mobile
- [ ] Labels filter supports multi-select (optional, Phase 7)
- [ ] Freshness/quality filters show color indicators (optional, Phase 7)
- [ ] All existing filter tests pass
- [ ] New tests cover pills, clear button, grid layout
