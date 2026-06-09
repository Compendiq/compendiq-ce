# Unit C — #723: AI Improve must not destroy images / draw.io Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AI Improve + Accept must keep images and draw.io diagrams rendering, with all `data-confluence-*` and `.confluence-drawio`/`data-diagram-name` structure intact, even if the LLM drops the line.

**Architecture:** Two layers. (1) **Placeholder protection** for the improve round-trip: before `htmlToMarkdown`, swap media nodes (`<img>`, `.confluence-drawio`, `.mermaid`, layout/column) for opaque text tokens; on Accept, re-derive the same tokens from the page's current `body_html` and re-inject the originals verbatim after `markdownToHtml`, with a diff-based guard that re-appends any media the LLM dropped. (2) **Converter coverage**: a turndown rule + `markdownToHtml` reconstruction for `confluence-drawio` so the conversion is lossless for non-improve callers too.

**Tech Stack:** TypeScript, jsdom, turndown (+gfm), marked; Vitest. Pure-function tests (no DB) for the converter; the apply-path change is covered by the existing route test that hits real Postgres.

**Branch:** `feature/issue-723-improve-media` off `dev`.

---

### Task 1: `protectMedia` / `restoreMedia` in content-converter

**Files:**
- Modify: `backend/src/core/services/content-converter.ts` (add two exported functions near `htmlToMarkdown` at `:874`)
- Test: `backend/src/core/services/content-converter.media.test.ts` (new)

Token format: `CQ_MEDIA_PLACEHOLDER_<index>` — pure `[A-Z_0-9]`, so it survives turndown, `sanitizeLlmInput`, markdown, and the LLM as plain text. Media nodes protected, in document order: `img`, `div.confluence-drawio`, `div.mermaid`/`.confluence-mermaid`, `div.confluence-section`, `div.confluence-column`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { protectMedia, restoreMedia, htmlToMarkdown, markdownToHtml } from './content-converter.js';

const DRAWIO = '<div class="confluence-drawio" data-diagram-name="Arch"><img src="/api/attachments/5/Arch.png" alt="d"><a class="drawio-edit-link" data-drawio="true" href="#">Edit</a></div>';
const IMG = '<img src="/api/attachments/5/photo.png" data-confluence-image-source="attachment" data-confluence-filename="photo.png" alt="Photo">';

describe('protectMedia / restoreMedia', () => {
  it('replaces media with deterministic tokens and restores them verbatim', () => {
    const html = `<p>Intro</p>${IMG}<p>Mid</p>${DRAWIO}<p>End</p>`;
    const { html: protectedHtml, media } = protectMedia(html);
    expect(protectedHtml).toContain('CQ_MEDIA_PLACEHOLDER_0');
    expect(protectedHtml).toContain('CQ_MEDIA_PLACEHOLDER_1');
    expect(protectedHtml).not.toContain('confluence-drawio');
    expect(media).toHaveLength(2);

    const restored = restoreMedia(protectedHtml, media);
    expect(restored).toContain('data-diagram-name="Arch"');
    expect(restored).toContain('data-confluence-filename="photo.png"');
  });

  it('is deterministic — same input yields the same token order', () => {
    const html = `${IMG}${DRAWIO}`;
    expect(protectMedia(html).media.map((m) => m.token))
      .toEqual(protectMedia(html).media.map((m) => m.token));
  });

  it('survives a full markdown round-trip and re-injects media (LLM-drops-line safe)', () => {
    const html = `<p>Intro</p>${DRAWIO}${IMG}`;
    const { html: protectedHtml, media } = protectMedia(html);
    const md = htmlToMarkdown(protectedHtml);          // tokens are plain text in MD
    expect(md).toContain('CQ_MEDIA_PLACEHOLDER_0');
    const back = restoreMedia(markdownToHtmlSync(md), media); // see helper note below
    expect(back).toContain('confluence-drawio');
    expect(back).toContain('data-confluence-filename');
  });
});
```

> `markdownToHtml` is async; in the test `await` it (make the test `async`) — the `markdownToHtmlSync` above is shorthand for `await markdownToHtml(md)`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/core/services/content-converter.media.test.ts`
Expected: FAIL — `protectMedia`/`restoreMedia` not exported.

- [ ] **Step 3: Implement `protectMedia` / `restoreMedia`**

Add to `content-converter.ts` (reuse the module's jsdom helper used by `htmlToConfluence`/`htmlToMarkdown` — e.g. `new JSDOM(html)` or the existing `parseHtml` helper):

```ts
export interface ProtectedMedia { token: string; html: string; }

const MEDIA_TOKEN_PREFIX = 'CQ_MEDIA_PLACEHOLDER_';
const MEDIA_SELECTOR = [
  'img',
  'div.confluence-drawio',
  'div.confluence-mermaid',
  'div.mermaid',
  'div.confluence-section',
  'div.confluence-column',
].join(',');

/**
 * #723: Replace rich/media nodes with opaque text tokens before the lossy
 * HTML→Markdown→HTML round-trip used by AI Improve. Document order makes the
 * tokens deterministic, so the same source HTML re-protected at Accept time
 * yields the same tokens — no need to persist the map.
 */
export function protectMedia(html: string): { html: string; media: ProtectedMedia[] } {
  const dom = new JSDOM(`<body>${html}</body>`);
  const doc = dom.window.document;
  const media: ProtectedMedia[] = [];
  // Outermost-first: a div.confluence-drawio contains an <img>; protect the
  // wrapper and skip its descendants.
  const nodes = Array.from(doc.body.querySelectorAll(MEDIA_SELECTOR))
    .filter((n) => !n.parentElement?.closest('div.confluence-drawio, div.confluence-mermaid, div.mermaid'));
  for (const node of nodes) {
    const token = `${MEDIA_TOKEN_PREFIX}${media.length}`;
    media.push({ token, html: (node as Element).outerHTML });
    node.replaceWith(doc.createTextNode(` ${token} `));
  }
  return { html: doc.body.innerHTML, media };
}

/**
 * Re-inject protected media. Replaces `<p>TOKEN</p>` (markdown wrapped the lone
 * token in a paragraph) and bare TOKEN occurrences with the original HTML.
 */
export function restoreMedia(html: string, media: ProtectedMedia[]): string {
  let out = html;
  for (const { token, html: original } of media) {
    out = out.replace(new RegExp(`<p>\\s*${token}\\s*</p>`, 'g'), original);
    out = out.split(token).join(original);
  }
  return out;
}
```

> If `JSDOM` isn't directly in scope, use the same DOM-construction helper the rest of `content-converter.ts` uses (grep the file for how `htmlToConfluence` parses HTML).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run src/core/services/content-converter.media.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/core/services/content-converter.ts backend/src/core/services/content-converter.media.test.ts
git commit -m "feat(content): protectMedia/restoreMedia for lossless AI Improve round-trip (#723)"
```

---

### Task 2: Wire protection into improve (request) + apply (Accept) with a drop-guard

**Files:**
- Modify: `backend/src/routes/llm/_helpers.ts:42-66` (add `opts.protectMedia` to `assembleContextIfNeeded`)
- Modify: `backend/src/routes/llm/llm-improve.ts:52` (pass `{ protectMedia: true }`)
- Modify: `backend/src/routes/llm/llm-conversations.ts:112-135` (add `body_html` to SELECT; restore + guard)
- Test: extend `backend/src/routes/llm/apply-improvement.test.ts`

- [ ] **Step 1: Write the failing apply test**

In `apply-improvement.test.ts` (real DB), seed a page whose `body_html` contains a draw.io diagram + an attachment image, post an `improvedMarkdown` that contains the placeholder tokens but NOT the media (simulating the LLM keeping the tokens), and assert the saved `body_html` still has both:

```ts
it('preserves drawio + image through improve→apply even if the LLM only kept the tokens (#723)', async () => {
  const drawio = '<div class="confluence-drawio" data-diagram-name="Arch"><img src="/api/attachments/{ID}/Arch.png"></div>';
  const img = '<img src="/api/attachments/{ID}/p.png" data-confluence-filename="p.png" data-confluence-image-source="attachment">';
  // insert a page with body_html = `<p>Old</p>${drawio}${img}` ; capture its confluence_id + version
  // improvedMarkdown mirrors what protectMedia+htmlToMarkdown produce:
  const improvedMarkdown = 'Improved intro\n\nCQ_MEDIA_PLACEHOLDER_0\n\nCQ_MEDIA_PLACEHOLDER_1\n';

  const res = await app.inject({ method: 'POST', url: '/api/llm/improvements/apply',
    payload: { pageId, improvedMarkdown, version } });

  expect(res.statusCode).toBe(200);
  const saved = await query<{ body_html: string }>('SELECT body_html FROM pages WHERE id=$1', [internalId]);
  expect(saved.rows[0]!.body_html).toContain('data-diagram-name="Arch"');
  expect(saved.rows[0]!.body_html).toContain('data-confluence-filename="p.png"');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/routes/llm/apply-improvement.test.ts`
Expected: FAIL — saved `body_html` lost the diagram/image.

- [ ] **Step 3: Add the `protectMedia` option to `assembleContextIfNeeded`**

`_helpers.ts` — import `protectMedia` and extend the signature/non-subpage branch:

```ts
export async function assembleContextIfNeeded(
  userId: string,
  pageId: string | undefined,
  content: string,
  includeSubPages?: boolean,
  opts?: { protectMedia?: boolean },
): Promise<{ markdown: string; multiPageSuffix: string }> {
  if (includeSubPages && pageId) {
    /* ...unchanged sub-page branch... */
  }
  const html = opts?.protectMedia ? protectMedia(content).html : content;
  return { markdown: htmlToMarkdown(html), multiPageSuffix: '' };
}
```

`llm-improve.ts:52` — pass the flag:

```ts
    const { markdown, multiPageSuffix } = await assembleContextIfNeeded(userId, body.pageId, content, includeSubPages, { protectMedia: true });
```

- [ ] **Step 4: Restore media + drop-guard on Accept**

`llm-conversations.ts` — add `body_html` to the existing page SELECT (`:112-119`):

```ts
    const existing = await query<{
      id: number; version: number; title: string; space_key: string;
      source: string; confluence_id: string | null; body_html: string | null;
    }>(
      `SELECT id, version, title, space_key, source, confluence_id, body_html FROM pages
       WHERE ${isNumericId ? 'id = $1' : 'confluence_id = $1'} AND deleted_at IS NULL`,
      [isNumericId ? parseInt(pageId, 10) : pageId],
    );
```

Replace the conversion (`:132-134`) with protect-derive + restore + guard:

```ts
    // #723: re-derive the same media tokens from the page's CURRENT body_html
    // (deterministic, document order) and re-inject originals verbatim so AI
    // Improve can never strip images/draw.io. Guard: re-append any media the LLM
    // dropped entirely (token missing from the improved markdown).
    const { media } = protectMedia(existingPage.body_html ?? '');
    let bodyHtml = await markdownToHtml(improvedMarkdown);
    bodyHtml = restoreMedia(bodyHtml, media);
    const dropped = media.filter((m) => !bodyHtml.includes(m.html));
    if (dropped.length > 0) {
      bodyHtml += dropped.map((m) => m.html).join('\n');
      fastify.log.warn({ pageId, dropped: dropped.length }, '#723: re-appended media dropped during AI Improve');
    }
    const bodyText = htmlToText(bodyHtml);
```

Import `protectMedia`, `restoreMedia` from `content-converter`.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && npx vitest run src/routes/llm/apply-improvement.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/llm/_helpers.ts backend/src/routes/llm/llm-improve.ts backend/src/routes/llm/llm-conversations.ts backend/src/routes/llm/apply-improvement.test.ts
git commit -m "fix(improve): protect media across the AI Improve round-trip + drop-guard (#723)"
```

---

### Task 3: Converter coverage — lossless `confluence-drawio` turndown ↔ markdownToHtml

**Files:**
- Modify: `backend/src/core/services/content-converter.ts` (add a turndown rule near `:937`; add reconstruction in `markdownToHtml` at `:945`)
- Test: `backend/src/core/services/content-converter.media.test.ts` (extend)

- [ ] **Step 1: Write the failing round-trip test**

```ts
it('drawio survives a direct htmlToMarkdown → markdownToHtml round-trip (#723 converter coverage)', async () => {
  const html = '<div class="confluence-drawio" data-diagram-name="Net Arch"><img src="/api/attachments/5/Net%20Arch.png"></div>';
  const md = htmlToMarkdown(html);
  expect(md).toContain('```drawio');
  expect(md).toContain('Net Arch');
  const back = await markdownToHtml(md);
  expect(back).toContain('class="confluence-drawio"');
  expect(back).toContain('data-diagram-name="Net Arch"');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/core/services/content-converter.media.test.ts`
Expected: FAIL — turndown flattens the drawio div; no `drawio` fence.

- [ ] **Step 3: Add the turndown rule + reconstruction**

In the turndown rules block (after the `panel` rule at `:929-937`):

```ts
  // #723: draw.io diagrams — emit a fenced block carrying the diagram name so
  // markdownToHtml can rebuild the .confluence-drawio wrapper losslessly.
  turndownService.addRule('confluenceDrawio', {
    filter: (node) => node.nodeName === 'DIV' && node.classList.contains('confluence-drawio'),
    replacement: (_content, node) => {
      const name = (node as HTMLElement).getAttribute('data-diagram-name') ?? 'diagram';
      return `\n\n\`\`\`drawio\n${name}\n\`\`\`\n\n`;
    },
  });
```

In `markdownToHtml` (`:945`), after the markdown→HTML conversion, post-process ```drawio fences back into the wrapper. If conversion uses `marked`, a ```drawio block becomes `<pre><code class="language-drawio">NAME\n</code></pre>`; rewrite those:

```ts
  // #723: rebuild draw.io wrappers from ```drawio fences.
  html = html.replace(
    /<pre><code class="language-drawio">([\s\S]*?)\n?<\/code><\/pre>/g,
    (_m, name) => {
      const safe = String(name).trim();
      return `<div class="confluence-drawio" data-diagram-name="${safe.replace(/"/g, '&quot;')}"></div>`;
    },
  );
```

> Confirm the exact `<pre><code class="language-...">` shape your markdown lib emits (run `htmlToMarkdown`→`markdownToHtml` on a fixture and inspect) and adjust the regex to match.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run src/core/services/content-converter.media.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/core/services/content-converter.ts backend/src/core/services/content-converter.media.test.ts
git commit -m "feat(content): lossless confluence-drawio turndown<->markdown rule (#723)"
```

---

### Task 4: Docs + full verification

**Files:**
- Modify: `docs/architecture/11-content-pipeline.md` (note media protection in the AI Improve round-trip + the drawio fence rule)

- [ ] **Step 1:** Update `docs/architecture/11-content-pipeline.md` with the placeholder-protection step and the new turndown rule.
- [ ] **Step 2:** `cd backend && npx vitest run src/core/services/content-converter.media.test.ts src/routes/llm/apply-improvement.test.ts` — green.
- [ ] **Step 3:** `cd backend && npm run lint && npm run typecheck` — clean.
- [ ] **Step 4:** Open PR `fix(improve): preserve images and draw.io across AI Improve (#723)` targeting `dev`.

## Acceptance mapping (#723)
- Improve+Accept keeps image + drawio rendering → Tasks 1+2.
- `data-confluence-*` and `.confluence-drawio`/`data-diagram-name` survive (write-back + edit button keep working) → Task 2 verbatim re-injection.
- LLM cannot drop media → placeholder re-derivation + drop-guard (Task 2).
- Tests cover image + drawio (+ mermaid/layout via the shared selector) → Tasks 1–3.
