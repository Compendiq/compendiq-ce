# Issue: AI Assistant Q&A mode returns "Internal Server Error"

> **Note:** This report describes pre-#256 (pre-multi-LLM-provider) code paths. File and symbol references below (e.g. `ollamaBreakers.embed`, `llm-chat.ts:340`, `rag-service.ts:197`) reflect the codebase at the time of the incident and may be stale as of the current tree. For the current architecture, see `docs/ARCHITECTURE-DECISIONS.md` (ADR-021) and `docs/architecture/`.

## Bug Description

When using the AI Assistant in **Ask (Q&A) mode**, asking any question results in a 500 "Internal Server Error". The request never reaches the LLM streaming phase — it fails during the RAG search or embedding generation step before the response stream starts.

## Request Flow & Failure Points

```
Frontend (AskMode.tsx:27-29)
  → POST /api/llm/ask { question, model, conversationId?, pageId?, includeSubPages }
  ↓
Backend (llm-chat.ts:310-481)
  ├─ Parse & sanitize question ✓
  ├─ Load conversation history ✓
  ├─ 🔴 hybridSearch(userId, question)  ← FAILS HERE (line 340)
  │   └─ rag-service.ts:189-230
  │       ├─ providerGenerateEmbedding(userId, question) ← May fail (Ollama/circuit breaker)
  │       ├─ vectorSearch(userId, embedding) ← May fail (standalone pages)
  │       └─ keywordSearch(userId, question) ← Likely works
  ├─ buildRagContext(searchResults)
  ├─ 🔴 assembleSubPageContext ← Uses confluence_id for standalone pages (line 348)
  ├─ reply.hijack() → SSE stream begins
  └─ providerStreamChat() → Stream LLM response
```

The error happens BEFORE `reply.hijack()` (line 434), so Fastify's error handler catches it and returns a generic JSON 500 response (line 139 of `app.ts`):

```json
{ "error": "InternalServerError", "message": "Internal Server Error", "statusCode": 500 }
```

The actual error message is stripped from the response for security (`statusCode === 500 ? 'Internal Server Error' : error.message`), making debugging impossible from the frontend.

## Root Cause Analysis

### Primary failure: Embedding generation fails

The Q&A flow **always** calls `hybridSearch()` which calls `providerGenerateEmbedding()` to embed the user's question. This fails if:

1. **Ollama is unreachable** — the embedding model (`nomic-embed-text`) can't be contacted
2. **Circuit breaker is open** — after 5 consecutive embedding failures, `ollamaBreakers.embed` blocks all requests with `CircuitBreakerOpenError: ollama-embed: LLM server temporarily unavailable`
3. **Embedding model not pulled** — `nomic-embed-text` isn't available on the Ollama server
4. **OpenAI provider misconfigured** — if user's provider is OpenAI but API key is invalid

The error from `providerGenerateEmbedding()` at `rag-service.ts:197` propagates up through `hybridSearch()` → `llm-chat.ts:340` → Fastify error handler → 500.

**No graceful degradation**: If embedding generation fails, the entire Q&A request fails. There is no fallback to keyword-only search.

### Secondary failure: Standalone page deduplication broken in RAG

The `SearchResult` interface uses `confluenceId` as the page identifier:

```typescript
// rag-service.ts:11-18
interface SearchResult {
  confluenceId: string;  // NULL for standalone pages!
  chunkText: string;
  pageTitle: string;
  ...
}
```

For standalone pages, `confluence_id` is `NULL`. This breaks three downstream operations:

**1. RRF deduplication key** (`rag-service.ts:135`):
```typescript
const key = `${result.confluenceId}:${result.chunkText.slice(0, 50)}`;
// For standalone: "null:chunk text..." — all standalone pages share the same prefix!
```

**2. Per-page deduplication** (`rag-service.ts:217-218`):
```typescript
if (!seen.has(result.confluenceId)) {
  seen.add(result.confluenceId);
// For standalone: seen.has(null) → false first time, then ALL null pages are skipped!
```

**3. Cache key generation** (`llm-chat.ts:361`):
```typescript
const docIds = searchResults.map((r) => r.confluenceId);
// Array of nulls → cache collisions between different queries
```

### Tertiary failure: Sub-page context queries use `confluence_id`

When `includeSubPages` is enabled with a `pageId`, the code at `llm-chat.ts:347-348` queries:

```sql
SELECT title, body_html FROM pages WHERE confluence_id = $1
```

For standalone pages (which have no `confluence_id`), this returns 0 rows. Additionally, `fetchSubPages()` in `subpage-context.ts:63-67` queries:

```sql
SELECT confluence_id, title, body_html FROM pages WHERE parent_id = $1
```

And then uses `row.confluence_id` as the child's ID for the recursive queue (line 80), which is `NULL` for standalone pages — breaking the recursion.

## Affected Files

### Backend (error sources)
- `backend/src/domains/llm/services/rag-service.ts` — `hybridSearch()`, `vectorSearch()`, `keywordSearch()`, RRF fusion
- `backend/src/routes/llm/llm-chat.ts` — `/api/llm/ask` handler (line 340), sub-page context (line 347-348)
- `backend/src/domains/llm/services/llm-provider.ts` — `providerGenerateEmbedding()`
- `backend/src/domains/llm/services/ollama-provider.ts` — `generateEmbedding()` with circuit breaker
- `backend/src/domains/confluence/services/subpage-context.ts` — `fetchSubPages()` uses `confluence_id`
- `backend/src/core/services/circuit-breaker.ts` — `CircuitBreakerOpenError`

### Frontend (error display)
- `frontend/src/features/ai/modes/AskMode.tsx` — sends request
- `frontend/src/features/ai/AiContext.tsx` — `runStream()` error handling
- `frontend/src/shared/lib/sse.ts` — SSE error propagation

## Implementation Plan

### Phase 1: Add graceful degradation — fall back to keyword-only search

When embedding generation fails, fall back to keyword-only search instead of failing the entire request:

```typescript
// rag-service.ts — update hybridSearch()
export async function hybridSearch(userId: string, question: string, topK = 5): Promise<SearchResult[]> {
  let vectorResults: SearchResult[] = [];
  let keywordResults: SearchResult[] = [];

  try {
    const questionEmbedding = await providerGenerateEmbedding(userId, question);
    [vectorResults, keywordResults] = await Promise.all([
      vectorSearch(userId, questionEmbedding[0]),
      keywordSearch(userId, question),
    ]);
  } catch (err) {
    logger.warn({ err }, 'Embedding generation failed, falling back to keyword-only search');
    keywordResults = await keywordSearch(userId, question);
  }

  if (vectorResults.length === 0 && keywordResults.length === 0) {
    return [];
  }

  const combined = vectorResults.length > 0
    ? reciprocalRankFusion(vectorResults, keywordResults)
    : keywordResults;

  // ... rest of deduplication
}
```

### Phase 2: Fix `SearchResult` to use universal page ID instead of `confluenceId`

Migrate from `confluenceId` to the universal `pageId` (integer) which exists for all pages:

```diff
  interface SearchResult {
-   confluenceId: string;
+   pageId: number;
+   confluenceId: string | null;  // Keep for backward compat / display
    chunkText: string;
    pageTitle: string;
    sectionTitle: string;
    spaceKey: string | null;
    score: number;
  }
```

Update `vectorSearch()`:
```diff
- SELECT cp.confluence_id, pe.chunk_text, pe.metadata, ...
+ SELECT cp.id AS page_id, cp.confluence_id, pe.chunk_text, pe.metadata, ...
```

Update `keywordSearch()`:
```diff
- SELECT cp.confluence_id, cp.title, cp.space_key, ...
+ SELECT cp.id AS page_id, cp.confluence_id, cp.title, cp.space_key, ...
```

Update RRF deduplication key:
```diff
- const key = `${result.confluenceId}:${result.chunkText.slice(0, 50)}`;
+ const key = `${result.pageId}:${result.chunkText.slice(0, 50)}`;
```

Update per-page dedup:
```diff
- if (!seen.has(result.confluenceId)) {
-   seen.add(result.confluenceId);
+ if (!seen.has(result.pageId)) {
+   seen.add(result.pageId);
```

### Phase 3: Fix sub-page context to use integer page ID

Update `llm-chat.ts:347-348`:
```diff
  const pageResult = await query<{ title: string; body_html: string }>(
-   'SELECT title, body_html FROM pages WHERE confluence_id = $1',
+   'SELECT title, body_html FROM pages WHERE id = $1',
    [body.pageId],
  );
```

Update `subpage-context.ts` — `fetchSubPages()`:
```diff
  const result = await query<{
-   confluence_id: string;
+   id: number;
    title: string;
    body_html: string;
  }>(
-   `SELECT confluence_id, title, body_html FROM pages WHERE parent_id = $1`,
+   `SELECT id, title, body_html FROM pages WHERE parent_id = $1`,
    [current.id],
  );

  for (const row of result.rows) {
    subPages.push({
-     confluenceId: row.confluence_id,
+     pageId: row.id,
      title: row.title,
      bodyHtml: row.body_html || '',
      depth: current.depth,
    });
-   queue.push({ id: row.confluence_id, depth: current.depth + 1 });
+   queue.push({ id: String(row.id), depth: current.depth + 1 });
  }
```

### Phase 4: Improve error propagation to frontend

Currently, 500 errors lose the actual message (`'Internal Server Error'` at `app.ts:139`). For LLM-specific errors, provide actionable messages:

```typescript
// llm-chat.ts — wrap hybridSearch with better error context
try {
  const searchResults = await hybridSearch(userId, question);
} catch (err) {
  if (err instanceof CircuitBreakerOpenError) {
    throw fastify.httpErrors.serviceUnavailable(
      'LLM server is temporarily unavailable. Please try again in a moment.'
    );
  }
  // Re-throw with context
  logger.error({ err }, 'RAG search failed');
  throw fastify.httpErrors.serviceUnavailable(
    'Knowledge base search failed. Check your LLM server connection.'
  );
}
```

Using 503 (Service Unavailable) instead of 500 allows the error message to reach the frontend (only 500s are stripped at `app.ts:139`).

### Phase 5: Fix frontend error display for SSE requests

Update `sse.ts` to extract meaningful error messages:

```typescript
// sse.ts — improve error extraction
if (!res.ok) {
  const errorBody = await res.json().catch(() => ({ message: res.statusText }));
  throw new Error(errorBody.message || `Request failed: ${res.status}`);
}
```

### Phase 6: Fix cache key to use pageId

Update `llm-chat.ts:361`:
```diff
- const docIds = searchResults.map((r) => r.confluenceId);
+ const docIds = searchResults.map((r) => String(r.pageId));
```

### Phase 7: Tests

**Backend:**
- Test `hybridSearch()` falls back to keyword-only when embedding fails
- Test `hybridSearch()` with circuit breaker open → graceful degradation
- Test `vectorSearch()` returns `pageId` for standalone pages
- Test RRF deduplication with standalone pages (null `confluenceId`)
- Test `/api/llm/ask` returns 503 (not 500) with actionable error message when LLM is down
- Test sub-page context with integer page IDs

**Frontend:**
- Test AskMode displays meaningful error message (not just "Internal Server Error")
- Test AskMode handles 503 gracefully

## Acceptance Criteria

- [ ] Q&A mode works when Ollama is available — no 500 error
- [ ] Q&A mode gracefully degrades to keyword-only search when embedding generation fails
- [ ] Circuit breaker open state returns 503 with actionable message (not generic 500)
- [ ] Standalone pages are correctly deduplicated in RAG results (using `pageId`, not `confluenceId`)
- [ ] Sub-page context works with standalone pages (queries by integer `id`, not `confluence_id`)
- [ ] Frontend displays meaningful error messages for LLM failures
- [ ] RAG cache keys use universal `pageId` instead of nullable `confluenceId`
- [ ] All existing Q&A tests pass
- [ ] New tests cover fallback search, error propagation, and standalone page handling
