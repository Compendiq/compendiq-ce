# Issue: Implement Confluence Section/Column macro support for multi-column layouts

## Problem

Confluence Data Center provides **two ways** to create multi-column layouts:

1. **Page Layouts** (`<ac:layout>` / `<ac:layout-section>` / `<ac:layout-cell>`) — **Already supported** ✅
2. **Section/Column macros** (`<ac:structured-macro ac:name="section">` / `<ac:structured-macro ac:name="column">`) — **Not supported** ❌

When a Confluence page uses Section/Column macros, the content converter falls through to the "unknown macro" handler (line 287 of `content-converter.ts`), rendering them as:

```html
<div class="confluence-macro-unknown" data-macro-name="section">
  <!-- column structure is lost, content is flattened -->
</div>
```

This destroys the multi-column layout and displays a degraded "[Confluence macro: section]" placeholder instead.

## Confluence XHTML Storage Format

### Section/Column macros use `ac:structured-macro` (unlike Page Layouts which use dedicated `ac:layout` elements):

```xml
<ac:structured-macro ac:name="section">
  <ac:parameter ac:name="border">true</ac:parameter>
  <ac:rich-text-body>
    <ac:structured-macro ac:name="column">
      <ac:parameter ac:name="width">30%</ac:parameter>
      <ac:rich-text-body>
        <p>Left column content</p>
      </ac:rich-text-body>
    </ac:structured-macro>
    <ac:structured-macro ac:name="column">
      <ac:parameter ac:name="width">70%</ac:parameter>
      <ac:rich-text-body>
        <p>Right column content</p>
      </ac:rich-text-body>
    </ac:structured-macro>
  </ac:rich-text-body>
</ac:structured-macro>
```

### Key differences from Page Layouts:

| Feature | Page Layouts (`ac:layout`) | Section/Column macros |
|---------|---------------------------|----------------------|
| Element type | Dedicated XML elements | `ac:structured-macro` |
| Column widths | Predefined types (two_equal, etc.) | Custom px/% per column |
| Number of columns | Fixed (1-3) | Unlimited |
| Border support | No | Yes (`border` parameter) |
| Nesting | No | Yes (sections inside columns) |
| Usage | Built-in page editor | Macro browser / storage format |

### Parameters:

**Section macro:**
- `border` (boolean) — show border around section

**Column macro:**
- `width` (string) — column width as px (`100px`) or percentage (`50%`)

## Current Behavior

Section/Column macros hit the unknown macro fallback at `content-converter.ts:287-296`:

```typescript
// Remove remaining unknown macros - preserve as data attributes
for (const macro of byTag(doc, 'ac:structured-macro')) {
  const name = getMacroName(macro) || 'unknown';
  const bodyEl = byTag(macro, 'ac:rich-text-body')[0];
  const div = doc.createElement('div');
  div.className = 'confluence-macro-unknown';
  div.setAttribute('data-macro-name', name);
  div.innerHTML = bodyEl?.innerHTML ?? `[Confluence macro: ${name}]`;
  macro.replaceWith(div);
}
```

**Result**: The section wrapper is converted to `confluence-macro-unknown`, and nested column macros inside it also become unknown macro divs. Column widths, border settings, and the grid structure are all lost.

## Affected Files

### Backend (conversion logic)
- `backend/src/core/services/content-converter.ts` — add section/column macro handling
- `backend/src/core/services/content-converter.test.ts` — add tests
- `backend/src/core/services/__fixtures__/confluence-xhtml.ts` — add test fixtures

### Frontend (rendering & styling)
- `frontend/src/index.css` — add CSS Grid styles for section/column layout
- `frontend/src/shared/components/article/article-extensions.ts` — add TipTap node extensions
- `frontend/src/shared/components/article/ArticleViewer.tsx` — whitelist data attributes in DOMPurify

### Frontend (round-trip)
- `backend/src/core/services/content-converter.ts` — add `htmlToConfluence()` reverse conversion

## Implementation Plan

### Phase 1: Backend — `confluenceToHtml()` conversion

Add handling for section/column macros **before** the unknown macro fallback (before line 287):

```typescript
// Process section/column macros -> grid divs (must run inside-out: columns first, then section)
for (const macro of byTag(doc, 'ac:structured-macro')) {
  if (getMacroName(macro) !== 'column') continue;
  const width = getParamValue(macro, 'width');
  const bodyEl = byTag(macro, 'ac:rich-text-body')[0];
  const div = doc.createElement('div');
  div.className = 'confluence-column';
  if (width) {
    div.setAttribute('data-cell-width', width);
    div.style.width = width; // or use CSS grid
  }
  div.innerHTML = bodyEl?.innerHTML ?? '';
  macro.replaceWith(div);
}

for (const macro of byTag(doc, 'ac:structured-macro')) {
  if (getMacroName(macro) !== 'section') continue;
  const border = getParamValue(macro, 'border');
  const bodyEl = byTag(macro, 'ac:rich-text-body')[0];
  const div = doc.createElement('div');
  div.className = 'confluence-section';
  if (border === 'true') div.setAttribute('data-border', 'true');
  div.innerHTML = bodyEl?.innerHTML ?? '';
  macro.replaceWith(div);
}
```

**Important**: Process columns first (inside-out), then sections — same pattern used for `ac:layout-cell` → `ac:layout-section`.

### Phase 2: Backend — `htmlToConfluence()` round-trip

Add reverse conversion to reconstruct the section/column macros from HTML divs:

```typescript
// Process outside-in: sections first, then columns
for (const div of doc.querySelectorAll('div.confluence-section')) {
  const macro = doc.createElement('ac:structured-macro');
  macro.setAttribute('ac:name', 'section');
  const border = div.getAttribute('data-border');
  if (border === 'true') {
    const param = doc.createElement('ac:parameter');
    param.setAttribute('ac:name', 'border');
    param.textContent = 'true';
    macro.appendChild(param);
  }
  const body = doc.createElement('ac:rich-text-body');
  while (div.firstChild) body.appendChild(div.firstChild);
  macro.appendChild(body);
  div.replaceWith(macro);
}

for (const div of doc.querySelectorAll('div.confluence-column')) {
  const macro = doc.createElement('ac:structured-macro');
  macro.setAttribute('ac:name', 'column');
  const width = div.getAttribute('data-cell-width');
  if (width) {
    const param = doc.createElement('ac:parameter');
    param.setAttribute('ac:name', 'width');
    param.textContent = width;
    macro.appendChild(param);
  }
  const body = doc.createElement('ac:rich-text-body');
  while (div.firstChild) body.appendChild(div.firstChild);
  macro.appendChild(body);
  div.replaceWith(macro);
}
```

### Phase 3: Backend — Markdown conversion

Add Turndown rule for section/column in `htmlToMarkdown()`:

```typescript
turndownService.addRule('confluenceSection', {
  filter: (node) => node.nodeName === 'DIV' && node.classList.contains('confluence-section'),
  replacement: (content) => `\n${content}\n`,
});

turndownService.addRule('confluenceColumn', {
  filter: (node) => node.nodeName === 'DIV' && node.classList.contains('confluence-column'),
  replacement: (content) => `\n${content.trim()}\n\n---\n`,
});
```

### Phase 4: Frontend — CSS styling

Add to `frontend/src/index.css`:

```css
/* Section/Column macros */
.confluence-section {
  display: flex;
  gap: 1rem;
  margin: 1rem 0;
}
.confluence-section[data-border="true"] {
  border: 1px solid var(--border);
  border-radius: 0.375rem;
  padding: 1rem;
}
.confluence-column {
  flex: 1;
  min-width: 0;
}
/* Respect explicit widths */
.confluence-column[data-cell-width] {
  flex: none;
}

/* Responsive: stack on mobile */
@media (max-width: 768px) {
  .confluence-section {
    flex-direction: column;
  }
  .confluence-column {
    width: 100% !important;
  }
}
```

**Note**: Use `flex` instead of `grid` here because section/column macros support arbitrary numbers of columns with custom widths, unlike the fixed layout types.

### Phase 5: Frontend — TipTap extensions

Add TipTap node extensions in `article-extensions.ts`:

```typescript
const ConfluenceSection = Node.create({
  name: 'confluenceSection',
  group: 'block',
  content: 'block+',
  parseHTML() {
    return [{ tag: 'div.confluence-section' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', { ...HTMLAttributes, class: 'confluence-section' }, 0];
  },
});

const ConfluenceColumn = Node.create({
  name: 'confluenceColumn',
  group: 'block',
  content: 'block+',
  parseHTML() {
    return [{ tag: 'div.confluence-column' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', { ...HTMLAttributes, class: 'confluence-column' }, 0];
  },
});
```

Also whitelist `data-border` and `data-cell-width` in DOMPurify config.

### Phase 6: Tests

Add test fixtures and test cases covering:
- Basic two-column section
- Three+ column section
- Section with border parameter
- Columns with px widths
- Columns with percentage widths
- Column without explicit width (auto)
- Nested content inside columns (tables, code blocks, panels)
- Nested sections (section inside a column)
- Round-trip stability (confluenceToHtml → htmlToConfluence → confluenceToHtml)
- Double round-trip stability
- Markdown conversion (htmlToMarkdown for section/column)

## Acceptance Criteria

- [ ] Section/Column macros are converted to styled HTML divs (not "unknown macro")
- [ ] Column widths (px and %) are preserved and applied
- [ ] Section border parameter is preserved and rendered
- [ ] Round-trip conversion (HTML → Confluence XHTML) preserves structure
- [ ] CSS renders columns side-by-side on desktop, stacked on mobile
- [ ] TipTap editor displays column layout correctly
- [ ] Nested content (tables, code, panels) renders inside columns
- [ ] All existing macro tests continue to pass
- [ ] New tests cover all section/column variations

## References

- [Column Macro — Atlassian Documentation](https://confluence.atlassian.com/doc/column-macro-51872396.html)
- [Section Macro — Atlassian Documentation](https://confluence.atlassian.com/conf59/section-macro-792499196.html)
- [Confluence Storage Format — Atlassian Documentation](https://confluence.atlassian.com/doc/confluence-storage-format-790796544.html)
- Existing layout implementation: `content-converter.ts` lines 264-285 (pattern to follow)
