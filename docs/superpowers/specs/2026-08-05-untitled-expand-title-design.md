# Untitled expand sections — design

**Date:** 2026-08-05
**Issue:** #1227 (an untitled expand / ui-expand section acquires a fabricated `title` parameter on write-back)
**Status:** implemented

## Problem

A Confluence expand section with **no** `title` parameter comes back from our
round-trip with one — the literal string `Click to expand`.

```
in:   <ac:structured-macro ac:name="expand"><ac:rich-text-body><p>body</p></ac:rich-text-body></ac:structured-macro>
html: <details data-macro-name="expand"><summary>Click to expand</summary><p>body</p></details>
out:  <ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">Click to expand</ac:parameter><ac:rich-text-body><p>body</p></ac:rich-text-body></ac:structured-macro>
```

Identical for `ui-expand`. Reproduced on `dev` @ `babd666`.

Two lines cause it, in `backend/src/core/services/content-converter.ts`:

- Forward (`:242`): `const title = getParamValue(macro, 'title') ?? 'Click to expand'`, then
  `summary.textContent = title`. The summary is never empty, so absence stops
  being representable at the very first hop.
- Reverse (`:769`): `if (summary) { … emit <ac:parameter ac:name="title"> … }`.
  The presence of a summary is the only signal the reverse pass has.

Every path that pushes a converted body back is affected: editor save, AI-Improve
apply, draft publish, version restore. The customer's Confluence page gains a
parameter it never had, and its rendering changes — Confluence renders its own
default label when no title is set, so the fabricated value is close but not
identical, and it becomes a *stored* value rather than a default the vendor
controls.

This is the same **fabrication** class as #1222 (wrong title appears) and the
`expanded=false` case handled in #1129 (parameter written that the source never
had). It is pre-existing for the native macro, not a regression from #1211,
#1221 or #1129.

### What the naive fix breaks

The issue's own Option A — "forward pass emits no `<summary>`, reverse pass skips
the `title` parameter when the summary is empty" — ships two regressions.

**1. A summary-less `<details>` ejects its own body.** The TipTap `Details` node
declares `content: 'detailsSummary block*'`
(`frontend/src/shared/components/article/article-extensions.ts:54`), so a
`<details>` whose first child is not a summary cannot parse as written.
Measured through a real `@tiptap/core` editor with this repo's extensions:

```
IN : <details data-macro-name="expand"><p>body</p></details>
OUT: <details data-macro-name="expand"><summary></summary></details><p>body</p>
```

`ArticleViewer` mounts the same `Details` / `DetailsSummary` nodes from
`article-extensions.ts` (`ArticleViewer.tsx:110-150`), so this is read view as
well as edit mode.

**2. It collapses a distinction #1232 deliberately preserved.** Confluence
storage distinguishes *no* `title` parameter from an explicitly empty
`<ac:parameter ac:name="title"/>`, and `expandTokenAttrs` (`:1473-1486`) carries
that difference through the Markdown token layer on purpose — presence of the
`title` key means "there is a summary", so an explicitly empty one is not
confused with none. A blanket "skip when trimmed empty" silently deletes a real
empty parameter: the same fabrication class, inverted.

The issue's suggested rendering hook does not work either.
`summary:empty::before` never matches — ProseMirror renders
`<summary><br class="ProseMirror-trailingBreak"></summary>` for an empty
textblock in **both** editable and non-editable modes, so `:empty` is false
either way.

### One thing already true on `dev`

The Markdown token layer already emits a summary-less `<details>`:
`markdownToHtml`'s `EXPAND` rebuild returns the bare tag when the token carries
no `title` attribute (`:1933-1936`). `parseExpandTokenAttrs` defaults `title` to
`null`, so a model-echoed `[[[EXPAND name=expand open=0 params=]]]` reaches
`markdownToHtml` → Improve-apply → the editor, and ejects the body per the
measurement above. That hole is latent today; this design retires it rather than
inheriting it.

## The contract

| Confluence storage | `body_html` | back to storage |
|---|---|---|
| no `title` param | `<summary></summary>` | no `title` param |
| `<ac:parameter ac:name="title"/>` | `<summary></summary>` + `data-macro-params='{"title":""}'` | `<ac:parameter ac:name="title"/>` |
| `<ac:parameter ac:name="title">Foo</ac:parameter>` | `<summary>Foo</summary>` | `title=Foo` |

**Invariant: every `<details>` this codebase produces carries a `<summary>`.**

That invariant is what makes the rest cheap. The TipTap schema is untouched, the
body-ejection hole becomes unreachable instead of being worked around, and the
muted default label has a real node to attach to.

`getParamValue` returns `child.textContent`, which is `''` for
`<ac:parameter ac:name="title"/>` and `null` only when the parameter is absent.
The `??` at `:242` fires on `null` alone, so **the three states are already
distinguishable at the point of the bug** — they are flattened one line later, by
the unconditional `delete extraParams.title` at `:254`. The marker is therefore
not new machinery; it is declining to delete something `collectDirectTextParams`
has already put in the map.

## Backend — `content-converter.ts`

### Forward pass (`confluenceToHtml`, ~`:242-273`)

- Drop the `?? 'Click to expand'` default; `summary.textContent = title ?? ''`.
- Replace the unconditional `delete extraParams.title` with a conditional one:
  keep the key **only** when its value is `''`.

The `<summary>` element itself is still always appended.

### Reverse pass (`htmlToConfluence`, ~`:769-827`)

- Decide on `summary.textContent.trim() !== ''` rather than on the summary's
  existence. When the *trimmed* text is non-empty, emit the parameter carrying
  the **untrimmed** text. A whitespace-only summary counts as untitled.
- `summary.remove()` still runs unconditionally whenever a summary exists — no
  `<summary>` may ship to Confluence as a literal HTML5 element.
- `:816`'s `if (paramName === 'title' && summary) continue` becomes
  `… && hasTitle`, so the `data-macro-params` marker is consulted **exactly
  when** the summary is blank. This is why a typed title always wins, and why
  the failure mode that got the issue's Option B rejected does not apply: the
  marker is never reachable while the user's own text is present.
- **Honour the marker only when its value is `''`.** A stale non-empty `title`
  in `data-macro-params` — hand-edited or legacy HTML — must not resurrect a
  title the user has just cleared. The summary remains the source of truth for
  any real string.

### Token layer (#1232)

- `markdownToHtml`'s `EXPAND` rebuild (`:1936`) always emits a summary:
  `${tag}<summary>${escapeHtmlText(title ?? '')}</summary>`. This is what makes
  the ejection hole unreachable.
- `expandTokenAttrs`' `if (summary)` guard stays — it is still correct for HTML
  that lacks one. Its comment at `:1479-1483` must be rewritten: the
  absent-vs-empty distinction now rides in `params`, and `title` presence records
  only whether the HTML had a summary at all.

## Frontend — the muted default label

An untitled section renders a muted label in the summary line, in read view and
in the editor, and **nothing is stored** for it.

### Mechanism

A ProseMirror decoration plugin on `DetailsSummary` (`addProseMirrorPlugins`)
stamps `data-expand-placeholder="<label>"` on any empty `detailsSummary`,
choosing the label from the parent `details` node's `macroName` attribute.

`Editor` and `ArticleViewer` both register `DetailsSummary` from
`article-extensions.ts`, so one change covers edit mode and read view. It does
not touch the global `Placeholder` at `Editor.tsx:1506`, whose CSS is scoped to
`p.is-editor-empty:first-child` (`index.css:2223`) and is unaffected.

Not CSS `:empty`, for the reason given above; and not a
`:has(> br.ProseMirror-trailingBreak)` selector, which would pin a ProseMirror
internal. A decoration is also computable under jsdom, so it is testable — the
CSS form is not.

CSS mirrors the existing placeholder idiom but **without** `float: left` and
`height: 0`: the `::before` must contribute the summary's height, because the
summary is the click target.

```css
.tiptap summary[data-expand-placeholder]::before {
  content: attr(data-expand-placeholder);
  color: var(--color-muted-foreground);
  pointer-events: none;
}
```

### Label map

| `data-macro-name` | label | source |
|---|---|---|
| `expand` | `Click here to expand...` | **measured** — local vanilla Confluence DC 9.2.14 |
| `ui-expand` | `Click here to expand` | **measured** — Refined's public DC demo |
| anything else, or unstamped | `Click to expand` | fixed generic fallback |

The intent is that Compendiq's read view matches what the page looks like in
Confluence, so neither macro-specific string was taken on trust. Both were
measured during implementation:

- **`expand`** — `expand-macro.default-title=Click here to expand...` in
  `com/atlassian/confluence/plugins/expand/i18n/i18n.properties`, pulled out of
  the `confluence-expand-macro-19.2.44` plugin bundled with the running local
  DC 9.2.14 container. `ExpandMacro.class` references that exact key (and
  `expand-macro.mobile.default-title`, "Tap here to expand...", which we do not
  model). Note the **trailing ellipsis**.
- **`ui-expand`** — rendered by the vendor's own instance. `POST
  /rest/api/contentbody/convert/view` on `confluence-dc-demo.refined.com`
  (anonymous, the same instance #1129 used for the storage format) with a
  title-less `ui-expand` returns
  `<button class="rwui_expandable_item_title rwui_expand" …> Click here to
  expand </button>` — **no ellipsis**. The near-collision with the native
  string is real, not a transcription slip, and both are pinned by test.
  The demo's 17 existing `ui-expand` instances are all titled, so the convert
  endpoint was the only way to see the default.

The generic fallback is unchanged and deliberately not a guess at any
third-party macro's wording.

### Insert (`Editor.tsx:710`)

The seeded `{ type: 'detailsSummary', content: [{ type: 'text', text: 'Click to expand' }] }`
becomes `{ type: 'detailsSummary' }` with no content, and the selection lands
inside it — a `TextSelection` near the inserted summary; `.focus()` alone does
not get there. A user who types gets a real title; a user who moves to the body
gets a genuinely untitled section and no fabricated parameter.

The body paragraph's `Content here...` seed is left alone.

## Edge cases

- Whitespace-only summary → untitled.
- **No summary at all** (legacy or model-produced HTML reaching the reverse pass
  directly) → `hasTitle` is false, `summary.remove()` is skipped, and the marker
  path applies as it would for an empty one. Same outcome as today: no `title`
  parameter unless `data-macro-params` carries an empty one.
- Malformed `data-macro-params` → the existing `try/catch` swallows it and the
  section is untitled. Safe.
- Stale non-empty `title` marker with a blank summary → no parameter emitted.
- Nested expands → unaffected; the reverse loop already runs innermost-first
  (#1233).
- `open` / `expanded` handling → untouched.

## Tests

**Backend (`content-converter.test.ts`)**

- Untitled `expand` and `ui-expand`: forward emits `<summary></summary>` with no
  `title` in `data-macro-params`; the round-trip emits no `title` parameter.
- Explicitly empty `<ac:parameter ac:name="title"/>`: the marker is written, and
  the round-trip emits an empty `title` parameter.
- A title typed over a previously-untitled section is emitted.
- A title typed over a previously-empty-parameter section is emitted (marker
  ignored).
- A cleared title is dropped.
- A stale **non-empty** `title` marker with a blank summary emits nothing.
- `markdownToHtml` never produces a summary-less `<details>` — including for a
  token with no `title` attribute.
- Existing titled-section cases unchanged. The assertions at `:1336` and `:1367`
  change, and the comment block at `:1341-1345` recording #1227 as deferred is
  retired.

**Frontend**

- The decoration stamps the correct per-macro label on an empty
  `detailsSummary`, and nothing on a filled one.
- `ArticleViewer` shows the label in non-editable mode.
- Insert produces an empty summary.

## Documentation

`docs/architecture/11-content-pipeline.md` records the three-state `<details>`
contract and the every-`<details>`-carries-a-`<summary>` invariant (repo rule 6).

## Out of scope

- **Already-stored `Click to expand` titles.** The fix is forward-only. Pages
  already saved through Compendiq keep the parameter; it is user-clearable by
  emptying the summary in the editor, which now actually removes it — because of
  this fix. Documented, not migrated.
- No heuristic heal-on-read. Treating a stored title of exactly
  `Click to expand` as absent would destroy a deliberate title spelled the same
  way, which is the class of silent rewrite this issue exists to stop.
- No audit script or blast-radius scan.
- The `Content here...` body seed on insert.

## Risks

- **Parameter ordering.** The empty-title round-trip emits its `title` parameter
  from the `data-macro-params` loop, i.e. *after* `expanded` rather than before.
  Confluence does not care, but any existing test that byte-compares the XHTML
  needs a look.
- **Unverified default strings.** Both label values are unconfirmed until an
  instance is consulted; see the label map above for the fallback.
- **Marker is not user-clearable.** A section that arrived with an explicitly
  empty `title` parameter cannot be made *truly* untitled from the editor, since
  nothing in the UI clears `data-macro-params`. Accepted: the two states render
  identically in Compendiq and the case is vanishingly rare (Confluence's own
  editor does not produce an empty title parameter).
