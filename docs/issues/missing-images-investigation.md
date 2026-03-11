# Images and draw.io diagrams not displayed — broken image placeholders

## Bug Description

All images and draw.io diagrams from Confluence appear as broken image placeholders in the page viewer. No inline images load at all.

## Root Cause Analysis

After a deep investigation of the full image pipeline (sync → storage → content conversion → API proxy → frontend rendering), **multiple issues** contribute to this problem. Some are confirmed code bugs, others are architectural gaps that cause silent failures.

---

### Bug 1: Draw.io XML-only fallback creates a filename mismatch (Confirmed)

**Files:** `backend/src/services/content-converter.ts:169`, `backend/src/services/attachment-handler.ts:166-173`

The content converter **always** generates a `.png` URL for draw.io diagrams:
```typescript
// content-converter.ts:169
img.src = `/api/attachments/${pageId}/${encodeURIComponent(diagramName)}.png`;
```

But when no PNG export exists in Confluence, the sync handler falls back to the XML file or bare name and caches under the **actual** attachment title:
```typescript
// attachment-handler.ts:171-172
attachment = xmlAttachment;
cacheAs = xmlAttachment.title;  // e.g. "diagram.xml" or "diagram"
```

**Result:** The HTML references `/api/attachments/{pageId}/diagram.png` but the cached file is `diagram.xml` → local cache miss. The on-demand fallback (`fetchAndCacheAttachment`) also fails because it searches by `title === "diagram.png"` which doesn't match `"diagram.xml"`.

**Fix:** Either:
- (a) In the content converter, detect available format and use the correct extension, OR
- (b) In the attachment handler, always cache draw.io fallbacks as `{name}.png` (rename on save), OR
- (c) In `fetchAndCacheAttachment`, try multiple filename patterns for draw.io attachments (`.png`, `.xml`, bare name)

---

### Bug 2: Image sync regex is fragile with attribute ordering (Potential)

**File:** `backend/src/services/attachment-handler.ts:224`

```typescript
const imagePattern = /<ac:image[^>]*>[\s\S]*?<ri:attachment\s+ri:filename="([^"]+)"[\s\S]*?<\/ac:image>/g;
```

This regex requires `ri:filename` to be the **first attribute** on `<ri:attachment>`. Confluence XHTML can include other attributes like `ri:version-at-save` before `ri:filename`:
```xml
<ri:attachment ri:version-at-save="1" ri:filename="image.png" />
```

This would NOT be matched by the regex. The content converter (JSDOM-based) handles any attribute order correctly, so the HTML will reference the image, but the sync will miss downloading it.

**Mitigated by** the on-demand fallback, but adds latency and relies on Confluence being reachable at view time.

**Fix:** Use JSDOM instead of regex (like `extractDrawioDiagramNames` already does), or make the regex more flexible: `<ri:attachment[^>]+ri:filename="([^"]+)"`.

---

### Bug 3: Sync skips attachment retries for unchanged pages (Architectural)

**File:** `backend/src/services/sync-service.ts:189-191`

```typescript
if (existing.rows.length > 0 && existing.rows[0].version >= page.version.number) {
  return;  // Skip — page hasn't changed
}
```

If the initial sync caches a page successfully but **fails to download some/all attachments** (caught per-attachment at `attachment-handler.ts:194,264`), subsequent syncs will see the same page version and **skip attachment downloads entirely**. Attachments that failed on first sync are never retried — they can only be fetched via the on-demand fallback.

**Impact:** If there was a transient Confluence error during the first sync (timeout, rate limit, network blip), all images for those pages remain broken until the page is edited in Confluence (bumping the version number) or the `cached_pages` row is manually deleted.

**Fix:** Track attachment sync status (e.g., a flag or count in `cached_pages`, or check filesystem for expected files) and retry attachment downloads even when page version hasn't changed.

---

### Bug 4: No attachment metadata tracking in the database (Architectural)

Attachments are stored only on the filesystem (`data/attachments/{pageId}/`) with no database table tracking what was downloaded, what failed, or what's expected. This means:
- No way to query "which pages have missing attachments?"
- No retry queue for failed downloads
- If the `data/attachments/` directory is lost, there's no record of what needs re-downloading
- The sync service has no way to know if it should re-attempt attachment downloads without re-fetching the page from Confluence

---

### Bug 5: Silent failure chain — no error surfaces to the user (UX)

The entire image loading chain swallows errors silently:

1. **Sync**: `attachment-handler.ts:194,264` — catches download errors, logs them, continues
2. **On-demand route**: `routes/attachments.ts:32-36` — catches fetch errors, returns 500 or 404
3. **Frontend**: `use-authenticated-src.ts:129,133` — `fetchAuthenticatedBlob` returns `null` on any error
4. **ArticleViewer**: `ArticleViewer.tsx:234-236` — if `blobUrl` is null, the original unauthenticated `/api/attachments/` URL stays → browser gets 401 → broken image icon

**The user never sees any error message or indication of WHY images are broken.** No toast, no console warning, no "click to retry" on the image.

---

## Steps to Reproduce

1. Sync a Confluence space that contains pages with embedded images and/or draw.io diagrams
2. Navigate to any synced page in the app
3. Observe: all images show as broken image placeholders
4. Check browser DevTools Network tab: image requests to `/api/attachments/...` return 401 (unauthenticated direct load) or 404/500 (authenticated fetch failure)

## Expected Behavior

- All inline images from Confluence should display correctly
- Draw.io diagrams should render as their PNG preview (or show a meaningful placeholder with "View in Confluence" link)
- Failed image loads should show a clear error state (not a raw broken image icon)
- Sync should retry failed attachment downloads

## Environment

- Confluence Data Center 9.2.15
- Backend: Fastify 5 + Node.js
- Frontend: React 19 + TipTap v3

## Suggested Fix Priority

1. **Bug 1** (draw.io filename mismatch) — High, confirmed code bug
2. **Bug 5** (silent failure chain) — High, blocks debugging
3. **Bug 2** (regex fragility) — Medium, switch to JSDOM
4. **Bug 3** (no retry on unchanged pages) — Medium, architectural improvement
5. **Bug 4** (no DB tracking) — Low, longer-term improvement
