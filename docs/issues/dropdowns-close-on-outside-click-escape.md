# Issue: Custom dropdowns don't close on outside click or Escape key press

## Bug Description

Several custom dropdown components in the app remain open when:
- Clicking outside the dropdown area
- Pressing the Escape key

Users must click the exact toggle button again to close them. This violates standard UI behavior where dropdowns dismiss on outside interaction.

## Affected Components

| Component | File | Click Outside | Escape | Status |
|-----------|------|:---:|:---:|--------|
| **Sidebar space dropdown** | `SidebarTreeView.tsx:554-661` | ❌ | ❌ | **Broken** |
| **ParentPagePicker** | `GenerateMode.tsx:42-165` | ❌ | ❌ | **Broken** |
| **CommentsSidebar** | `CommentsSidebar.tsx` | ⚠️ backdrop only | ❌ | **Partial** |
| LocationPicker | `LocationPicker.tsx` | ✅ Radix Popover | ✅ | Correct |
| PagesPage filters | `PagesPage.tsx` | ✅ native `<select>` | ✅ | Correct |
| SearchPage filters | `SearchPage.tsx` | ✅ native `<select>` | ✅ | Correct |
| TagEditor | `TagEditor.tsx` | ✅ manual impl | ✅ | Correct |
| CommandPalette | `CommandPalette.tsx` | ✅ backdrop | ✅ | Correct |

## Root Cause Analysis

### Sidebar space dropdown (`SidebarTreeView.tsx:554-661`)

The space selector in the sidebar tree uses a custom dropdown with bare `useState`:

```typescript
const [spaceDropdownOpen, setSpaceDropdownOpen] = useState(false);

// Toggle on button click only — no other close triggers
onClick={() => setSpaceDropdownOpen(!spaceDropdownOpen)}

// Renders when open
{spaceDropdownOpen && (
  <div className="absolute left-0 right-0 top-full z-50 ...">
    {/* Options that close on selection */}
  </div>
)}
```

**Missing:**
- No `useRef` + `mousedown` listener for outside-click detection
- No `keydown` listener for Escape
- Dropdown only closes when an option is explicitly selected

### ParentPagePicker (`GenerateMode.tsx:42-165`)

Same pattern — bare `useState` with no dismiss handlers:

```typescript
const [isOpen, setIsOpen] = useState(false);

// Toggle only
onClick={() => setIsOpen(!isOpen)}

// Closes on selection
onClick={() => {
  onSelect(page.id, page.title);
  setIsOpen(false);
  setSearch('');
}}
```

**Note:** This component is already planned for replacement with `LocationPicker` (Radix Popover) in the AI Assistant save/location bugs issue. However, until that's done, the fix is still needed.

### Existing correct patterns in the codebase

**`TagEditor.tsx`** — manual click-outside + Escape handling:
```typescript
// Click outside (lines 54-63)
useEffect(() => {
  function handleClickOutside(event: MouseEvent) {
    if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
      setShowSuggestions(false);
    }
  }
  document.addEventListener('mousedown', handleClickOutside);
  return () => document.removeEventListener('mousedown', handleClickOutside);
}, []);

// Escape key (lines 92-94)
} else if (event.key === 'Escape') {
  setShowSuggestions(false);
}
```

**`LocationPicker.tsx`** — Radix Popover (automatic):
```tsx
<Popover.Root open={open} onOpenChange={setOpen}>
  <Popover.Trigger asChild>...</Popover.Trigger>
  <Popover.Portal>
    <Popover.Content>...</Popover.Content>
  </Popover.Portal>
</Popover.Root>
```

### No shared `useClickOutside` hook

The codebase has no reusable hook for this common pattern. Each component implements its own logic.

## Affected Files

- `frontend/src/shared/components/layout/SidebarTreeView.tsx` — sidebar space dropdown (lines 554-661)
- `frontend/src/features/ai/modes/GenerateMode.tsx` — ParentPagePicker (lines 42-165)
- `frontend/src/shared/components/article/CommentsSidebar.tsx` — missing Escape handling
- `frontend/src/shared/hooks/` — new `useClickOutside` hook

## Implementation Plan

### Phase 1: Create a reusable `useClickOutside` hook

Create `frontend/src/shared/hooks/use-click-outside.ts`:

```typescript
import { useEffect, type RefObject } from 'react';

/**
 * Calls `handler` when a click/touch occurs outside the referenced element.
 */
export function useClickOutside(
  ref: RefObject<HTMLElement | null>,
  handler: () => void,
  enabled = true,
) {
  useEffect(() => {
    if (!enabled) return;

    function onPointerDown(event: MouseEvent | TouchEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        handler();
      }
    }

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
    };
  }, [ref, handler, enabled]);
}
```

### Phase 2: Fix sidebar space dropdown (`SidebarTreeView.tsx`)

Add click-outside and Escape handling:

```typescript
const spaceDropdownRef = useRef<HTMLDivElement>(null);

// Close on click outside
useClickOutside(spaceDropdownRef, () => setSpaceDropdownOpen(false), spaceDropdownOpen);

// Close on Escape
useEffect(() => {
  if (!spaceDropdownOpen) return;
  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      setSpaceDropdownOpen(false);
    }
  }
  document.addEventListener('keydown', onKeyDown);
  return () => document.removeEventListener('keydown', onKeyDown);
}, [spaceDropdownOpen]);
```

Wrap the dropdown container with the ref:
```diff
- <div className="relative">
+ <div className="relative" ref={spaceDropdownRef}>
```

### Phase 3: Fix ParentPagePicker (`GenerateMode.tsx`)

Same pattern as Phase 2:

```typescript
const containerRef = useRef<HTMLDivElement>(null);

useClickOutside(containerRef, () => {
  setIsOpen(false);
  setSearch('');
}, isOpen);

// Add Escape handling to the search input
onKeyDown={(e) => {
  if (e.key === 'Escape') {
    setIsOpen(false);
    setSearch('');
  }
}}
```

And wrap with ref:
```diff
- <div className="relative">
+ <div className="relative" ref={containerRef}>
```

### Phase 4: Fix CommentsSidebar — add Escape handling

Add Escape key listener to close the sidebar panel:

```typescript
useEffect(() => {
  if (!isOpen) return;
  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') setIsOpen(false);
  }
  document.addEventListener('keydown', onKeyDown);
  return () => document.removeEventListener('keydown', onKeyDown);
}, [isOpen]);
```

### Phase 5: Migrate TagEditor to use shared hook

Refactor `TagEditor.tsx` to use the new `useClickOutside` hook instead of its inline implementation:

```diff
- useEffect(() => {
-   function handleClickOutside(event: MouseEvent) {
-     if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
-       setShowSuggestions(false);
-     }
-   }
-   document.addEventListener('mousedown', handleClickOutside);
-   return () => document.removeEventListener('mousedown', handleClickOutside);
- }, []);
+ useClickOutside(containerRef, () => setShowSuggestions(false), showSuggestions);
```

### Phase 6: Tests

**New hook test** (`use-click-outside.test.ts`):
- Test that handler is called on mousedown outside ref element
- Test that handler is NOT called on mousedown inside ref element
- Test that handler is NOT called when `enabled = false`
- Test cleanup on unmount

**SidebarTreeView tests:**
- Test space dropdown closes on outside click
- Test space dropdown closes on Escape key

**GenerateMode tests:**
- Test ParentPagePicker closes on outside click
- Test ParentPagePicker closes on Escape key

**CommentsSidebar tests:**
- Test sidebar closes on Escape key

## Acceptance Criteria

- [ ] Sidebar space dropdown closes when clicking outside
- [ ] Sidebar space dropdown closes when pressing Escape
- [ ] ParentPagePicker dropdown closes when clicking outside
- [ ] ParentPagePicker dropdown closes when pressing Escape
- [ ] CommentsSidebar closes when pressing Escape
- [ ] Shared `useClickOutside` hook is reusable across all components
- [ ] `TagEditor` refactored to use shared hook
- [ ] All existing dropdown tests pass
- [ ] New tests cover click-outside and Escape behavior
