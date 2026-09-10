# Macro identity on `<details>` — design

**Date:** 2026-08-04
**Issue:** prerequisite extracted from #1129 (Confluence "UI Expand" macro, Refined Toolkit)
**Status:** approved, not yet implemented

## Problem

`htmlToConfluence` writes `ac:name="expand"` on **every** `<details>` element it
finds (`backend/src/core/services/content-converter.ts:607-610`). The forward
pass emits a bare `<details>` with no record of which macro produced it
(`:162-181`).

That is correct only while exactly one macro maps to `<details>`. The moment a
second one does — which is what #1129 proposes for Refined's "UI Expand" — the
write-back collapses both onto the native Atlassian `expand` macro. A Refined UI
Expand section on a synced page would be **silently rewritten into a native
expand macro on the first editor save**, deleting the third-party macro from the
customer's Confluence page.

This is a data-integrity failure, not a rendering one, and it happens even if the
Refined macro key is identified correctly. It must be fixed before any second
`<details>` producer is added.

### Why the obvious fix does not work

Writing a `data-*` attribute in the backend forward pass is not sufficient on its
own. The TipTap `Details` node
(`frontend/src/shared/components/article/article-extensions.ts:51-65`) declares
exactly one attribute, `open`. ProseMirror serializes only declared attributes,
so an undeclared `data-macro-name` is parsed away on load and absent from the
HTML the editor saves. The reverse pass then sees a plain `<details>` and takes
the `expand` branch anyway.

`UnknownMacro` (`:1072-1100`) exists for precisely this reason: it declares
`macroName` and `macroParams` so the #865 safety net survives an editor save.
This design follows that precedent.

## What is already safe (and must stay that way)

A Refined UI Expand macro today falls through to the `confluence-macro-unknown`
branch (`content-converter.ts:493-508`), which preserves `data-macro-name`, all
parameters as JSON in `data-macro-params`, and the rich-text body. The reverse
pass rebuilds the exact `ac:structured-macro`. Content is **not** at risk today —
it round-trips losslessly through save, AI-Improve apply, draft publish and
version restore.

What is missing today is only the *editing affordance*: the macro renders as a
placeholder div rather than an expandable section. #1129 wants full parity with
the native expand — collapsible rendering, inline-editable body and title — and
that requires mapping it to `<details>`, which is what makes this prerequisite
necessary.

## Design

### Editor schema

`Details` gains two attributes, mirroring `UnknownMacro`'s shape and naming:

- `macroName` — parsed from `data-macro-name`, rendered back to it, default `null`
- `macroParams` — parsed from `data-macro-params` (a JSON string), rendered back, default `null`

Reusing `UnknownMacro`'s attribute names is deliberate: the two paths then read
the same, and a macro that later graduates from the fallback into a real node
keeps the same attribute name, making that migration a parse rule rather than a
rename.

### Forward pass (`confluenceToHtml`)

The expand branch (`content-converter.ts:162-181`) stamps
`data-macro-name="expand"` on the `<details>` it creates, and
`data-macro-params` with any parameters **other than `title`**.

`title` remains in `<summary>` and is deliberately *not* duplicated into the JSON
— one source of truth per value, and the reverse pass already reconstructs the
`title` parameter from `<summary>`.

### Reverse pass (`htmlToConfluence`)

The `<details>` loop (`:607`) reads `data-macro-name` and writes it as `ac:name`,
**defaulting to `expand` when the attribute is absent**. The `title` parameter is
rebuilt from `<summary>` as today; remaining parameters are re-emitted from
`data-macro-params`.

An unrecognised `macroName` is **passed through**, not coerced to `expand`.
Coercion is the silent-rewrite bug in miniature; passthrough preserves whatever
the element actually was. This grants no new capability: `UnknownMacro` already
round-trips arbitrary `data-macro-name` values, so a save can already emit an
arbitrary `ac:name`. Tightening that trust boundary is a separate, larger piece
of work and is explicitly out of scope here.

### Why `absent → expand` is safe

Only the native expand branch produces `<details>` today, so every `<details>` in
every stored `body_html` is genuinely a native expand. The default is therefore
correct for all existing content — **no data migration is required** — and
equally correct for sections created in the editor (`Editor.tsx:710`).

Stamping the attribute explicitly at `Editor.tsx:710` was considered and rejected
as redundant. The tradeoff accepted: the safety property lives in one line of the
reverse pass rather than being visible at the insertion site, so that line
carries a comment explaining it.

## Behaviour change

**None.** Every existing `<details>` is stamped `expand` on the way out and
writes back as `expand`. This change is pure setup for #1129 and delivers no
user-visible behaviour on its own.

## Testing

Four cases. The first three are the design, not coverage padding.

1. **Mixed-document round-trip** — a native expand and a foreign-macro
   `<details>` in one document write back as two *different* `ac:name` values.
   This is the test the change exists for.
2. **ProseMirror survival** (frontend) — load HTML carrying `data-macro-name`
   into the editor, serialize out, assert the attribute survives. This is the
   failure mode that would silently reintroduce the bug, and it is invisible to
   backend-only tests.
3. **Unrecognised value passthrough** — `macroName="whatever"` produces
   `ac:name="whatever"`, never `expand`.
4. **Existing expand fixtures unchanged** — the no-op proof. Mirror the current
   cases at `content-converter.test.ts:100`, `:490`, `:741`.

## Files affected

- `backend/src/core/services/content-converter.ts` — forward branch `:162-181`, reverse loop `:607-624`
- `frontend/src/shared/components/article/article-extensions.ts` — `Details` node `:51-65`
- `backend/src/core/services/content-converter.test.ts` — cases 1, 3, 4
- frontend editor round-trip test — case 2
- `docs/architecture/11-content-pipeline.md` — content-pipeline change, per the repo's diagram rule

## Out of scope

- The Refined UI Expand forward branch itself. It needs the real `ac:name`,
  the default-expanded parameter name and value vocabulary, and the title
  parameter name — obtainable only from a "View Storage Format" export on an
  instance with Refined Macro Toolkit installed. The local Confluence container
  is vanilla. That work stays on #1129.
- Round-tripping `open` / default-expanded. Neither pass handles it today;
  the native `expand` macro has no such parameter, so it is new converter work
  belonging to the #1129 branch that needs it.
- Tightening the trust boundary on client-supplied `data-macro-name`.
