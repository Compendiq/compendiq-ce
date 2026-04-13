# Issue: Search quality degraded — no sentence matching, embeddings unused for page search

## Bug Description

The article search has significant quality issues:

1. **Cannot find articles by sentence** — searching for a phrase or sentence that exists verbatim in an article returns no results
2. **Embeddings are not used for page search** — vector/semantic search is only used in RAG (AI chat), never for the main article search
3. **Relevance sorting is broken** — the SearchPage maps "relevance" to "modified" date, so results are never ranked by relevance
4. **SearchPage uses the wrong API endpoint** — calls `/api/pages` instead of the dedicated `/api/search` endpoint (which has snippets, ranking, and facets)

## Root Cause Analysis

### Problem 1: `plainto_tsquery` can't find sentence fragments

Both `/api/pages` and `/api/search` use PostgreSQL's `plainto_tsquery('english', ...)` for full-text search:

```sql
-- search.ts:44-46 and pages-crud.ts:68
to_tsvector('english', COALESCE(cp.title, '') || ' ' || COALESCE(cp.body_text, ''))
  @@ plainto_tsquery('english', $1)
```

**How `plainto_tsquery` works:**
- Tokenizes each word separately
- Applies English stemming (e.g., "running" → "run", "configured" → "configur")
- **Removes stop words** ("the", "is", "a", "an", "in", "on", "to", "for", etc.)
- Combines remaining stems with `&` (AND) operator
- Has **no phrase/proximity matching** — word order and adjacency are ignored

**Example failure cases:**

| User searches for | `plainto_tsquery` produces | Problem |
|---|---|---|
| `"how to configure the server"` | `'configur' & 'server'` | "how", "to", "the" are stop words — removed |
| `"it is not working"` | `'work'` | Only "working" survives stop word removal and stemming |
| `"the error message says"` | `'error' & 'messag' & 'say'` | Matches any page mentioning errors, messages, or saying — too broad |
| `"SSL certificate has expired"` | `'ssl' & 'certif' & 'expir'` | Close match but stemming can miss exact phrases |
| `"to be or not to be"` | *(empty query)* | ALL words are stop words — matches nothing or everything |

**No ILIKE fallback**: When full-text search returns 0 results, there is no fallback to substring matching (`ILIKE '%phrase%'`). The user gets an empty result set.

### Problem 2: Embeddings not used for article search

The system has a **complete embedding infrastructure** that is only used by the AI chat (RAG):

```
Current search architecture:
┌─────────────────────────────────────────────────┐
│ /api/pages (PagesPage, SearchPage)              │
│   → plainto_tsquery full-text search ONLY       │ ← NO embeddings
│   → No semantic understanding                   │
│   → No synonym matching                         │
│   → Fails on sentence fragments                 │
└─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────┐
│ /api/llm/chat (AI Assistant RAG)                │
│   → hybridSearch() with RRF                     │ ← HAS embeddings
│   → Vector search (cosine similarity)           │
│   → Keyword search (plainto_tsquery)            │
│   → Semantic understanding                      │
│   → Finds conceptually similar content          │
└─────────────────────────────────────────────────┘
```

The `hybridSearch()` function in `rag-service.ts` already implements everything needed:
- Vector search via pgvector HNSW index
- Keyword search via `plainto_tsquery`
- Reciprocal Rank Fusion (RRF) to combine results
- RBAC-aware access control
- Per-page deduplication

But this is **never called from the page/search endpoints**.

### Problem 3: Relevance sorting is broken on SearchPage

`SearchPage.tsx:65`:
```typescript
if (sort) sp.set('sort', sort === 'relevance' ? 'modified' : sort);
//                                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^
//                                  Relevance is mapped to 'modified'!
```

When a user selects "Sort by relevance", the frontend sends `sort=modified` to the backend, so results are sorted by last modified date instead of search rank. The user sees recently edited pages first, regardless of how well they match the query.

Additionally, the `/api/pages` backend endpoint doesn't support `sort=relevance` at all — it only supports `title`, `modified`, `author`, `quality` (`pages-crud.ts:134-139`). The dedicated `/api/search` endpoint DOES support `sort=relevance` via `ts_rank()`.

### Problem 4: SearchPage uses wrong API endpoint

`SearchPage.tsx:72`:
```typescript
queryFn: () => apiFetch(`/pages?${qs}`),
//                       ^^^^^^
//                       Calls /api/pages instead of /api/search!
```

The dedicated `/api/search` endpoint provides:
- `ts_rank()` scoring for relevance ranking
- `ts_headline()` for snippet extraction with `<mark>` highlighting
- Facet aggregation (spaces, authors, tags with counts)

But `SearchPage` calls `/api/pages` instead, which:
- Has no relevance scoring
- Has no server-side snippet extraction
- Has no facet aggregation
- Returns full page metadata (overkill for search results)

## Affected Files

### Backend
- `backend/src/routes/knowledge/search.ts` — dedicated search endpoint (underused)
- `backend/src/routes/knowledge/pages-crud.ts` — `/api/pages` search (no embedding support, lines 66-69)
- `backend/src/domains/llm/services/rag-service.ts` — `hybridSearch()` (only used by RAG)

### Frontend
- `frontend/src/features/search/SearchPage.tsx` — calls wrong endpoint, broken relevance sort

### Database
- `page_embeddings` table — HNSW index exists but unused for page search
- `pages` table — GIN FTS index is the only search mechanism

## Implementation Plan

### Phase 1: Fix SearchPage to use `/api/search` endpoint

Update `SearchPage.tsx` to call the dedicated search endpoint:

```diff
- if (query) sp.set('search', query);
+ if (query) sp.set('q', query);
  ...
- if (sort) sp.set('sort', sort === 'relevance' ? 'modified' : sort);
+ if (sort) sp.set('sort', sort);
  ...
- queryFn: () => apiFetch(`/pages?${qs}`),
+ queryFn: () => apiFetch(`/search?${qs}`),
```

Update the response type to match `/api/search` response shape (includes `rank`, `snippet`, `facets`).

### Phase 2: Add ILIKE fallback for full-text search

When `plainto_tsquery` returns no results, fall back to `ILIKE` substring matching. This ensures sentence fragments that contain mostly stop words still find results.

In `search.ts` and `pages-crud.ts`, add a fallback:

```typescript
// Primary: full-text search
conditions.push(
  `to_tsvector('english', ...) @@ plainto_tsquery('english', $1)`
);

// If zero results, retry with ILIKE fallback
if (dataResult.rows.length === 0 && q.trim().length >= 3) {
  // Fallback: substring match on title OR body_text
  const fallbackResult = await query(
    `SELECT ... FROM pages cp
     WHERE (cp.title ILIKE $1 OR cp.body_text ILIKE $1)
       AND ... (access control)
     ORDER BY cp.last_modified_at DESC
     LIMIT $2`,
    [`%${q.trim()}%`, limit],
  );
  // Return fallback results with rank=0
}
```

### Phase 3: Add `websearch_to_tsquery` for better natural language search

PostgreSQL 11+ supports `websearch_to_tsquery()` which handles natural language queries better than `plainto_tsquery`:

```sql
-- plainto_tsquery: splits into AND-joined stems (loses stop words entirely)
plainto_tsquery('english', 'how to configure the server')
-- → 'configur' & 'server'

-- websearch_to_tsquery: supports quoted phrases, OR, NOT
websearch_to_tsquery('english', '"configure the server"')
-- → 'configur' <-> 'server'  (phrase/proximity match!)

-- phraseto_tsquery: preserves word order with proximity matching
phraseto_tsquery('english', 'configure the server')
-- → 'configur' <-> 'server'  (adjacent after stop word removal)
```

Replace `plainto_tsquery` with a smarter approach:

```typescript
// Use phraseto_tsquery for phrase matching, fall back to plainto_tsquery for broader match
const searchCondition = `(
  to_tsvector('english', ...) @@ phraseto_tsquery('english', $1)
  OR
  to_tsvector('english', ...) @@ plainto_tsquery('english', $1)
)`;
```

This gives phrase matches (word order preserved) higher priority while still matching broader keyword queries.

### Phase 4: Add hybrid search (embeddings) to `/api/search`

Add an optional `mode` parameter to `/api/search` that enables embedding-based semantic search:

```typescript
const SearchQuerySchema = z.object({
  q: z.string().min(1).max(500),
  mode: z.enum(['keyword', 'semantic', 'hybrid']).default('hybrid'),
  // ... existing params
});
```

**When `mode=hybrid`** (default):
1. Run vector search in parallel with keyword search (reuse from `rag-service.ts`)
2. Combine with Reciprocal Rank Fusion (RRF)
3. Generate snippets from the best-matching chunks
4. Return unified ranked results

**When `mode=keyword`**: Current behavior (full-text only)
**When `mode=semantic`**: Vector search only (best for natural language questions)

Implementation approach — extract and reuse `vectorSearch()` and `keywordSearch()` from `rag-service.ts`:

```typescript
// search.ts — hybrid search branch
import { vectorSearch, keywordSearch, reciprocalRankFusion } from '../../domains/llm/services/rag-service.js';

if (mode === 'hybrid' || mode === 'semantic') {
  const embedding = await providerGenerateEmbedding(userId, q);
  const vecResults = await vectorSearch(userId, embedding[0], 20);

  if (mode === 'hybrid') {
    const kwResults = await keywordSearch(userId, q, 20);
    const combined = reciprocalRankFusion(vecResults, kwResults);
    // Map to search response format with snippets...
  }
}
```

**Performance note**: Embedding generation adds ~100-300ms latency per search. To mitigate:
- Default to `hybrid` only when the user's pages have embeddings
- Add an embedding cache for recently searched queries
- Show keyword results immediately, then enhance with semantic results (progressive loading)

### Phase 5: Frontend — add search mode toggle and use hybrid results

Update `SearchPage.tsx`:
- Add a search mode toggle (Keyword / Semantic / Hybrid)
- Default to Hybrid when embeddings are available
- Show semantic relevance scores alongside results
- Use server-provided snippets from `ts_headline()` instead of client-side highlighting

### Phase 6: Add `pg_trgm` fuzzy matching for typo tolerance

The `pg_trgm` extension is already loaded (migration 001) but unused. Add trigram-based fuzzy matching as a third search signal:

```sql
-- Add trigram index (one-time migration)
CREATE INDEX idx_pages_title_trgm ON pages USING GIN (title gin_trgm_ops);

-- Use similarity for fuzzy title matching
SELECT *, similarity(title, $1) AS trgm_score
FROM pages
WHERE title % $1  -- trigram similarity threshold (default 0.3)
ORDER BY trgm_score DESC;
```

This helps when users make typos or search for partial words.

### Phase 7: Update tests

**Backend** (`search.test.ts`):
- Test ILIKE fallback when FTS returns no results
- Test `phraseto_tsquery` for sentence-level matching
- Test hybrid search mode with mocked embeddings
- Test search mode parameter validation

**Backend** (`rag-service.test.ts`):
- Verify exported functions work independently (not just via `hybridSearch`)

**Frontend** (`SearchPage.test.tsx`):
- Test calling `/api/search` instead of `/api/pages`
- Test relevance sort sends `sort=relevance` (not `modified`)
- Test search mode toggle
- Test server-side snippet rendering

## Acceptance Criteria

- [ ] Searching for a sentence that exists in an article finds that article
- [ ] `phraseto_tsquery` is used for phrase/proximity matching
- [ ] ILIKE fallback finds results when full-text search returns nothing
- [ ] SearchPage calls `/api/search` endpoint (not `/api/pages`)
- [ ] Relevance sorting works correctly (uses `ts_rank`, not modified date)
- [ ] Hybrid search mode uses embeddings + keywords with RRF for ranking
- [ ] Search mode toggle available in SearchPage UI (keyword / semantic / hybrid)
- [ ] `pg_trgm` fuzzy matching provides typo tolerance for title search
- [ ] All existing search tests pass
- [ ] New tests cover phrase search, ILIKE fallback, hybrid mode, and relevance sort fix
- [ ] Performance: hybrid search responds within 500ms for typical queries
