# 9. RAG Chat Flow

End-to-end flow for a user's question through the RAG pipeline. Implemented
in `backend/src/routes/llm/llm-ask.ts` (SSE) with retrieval in
`backend/src/domains/llm/services/rag-service.ts`.

## Sequence

```mermaid
sequenceDiagram
    autonumber
    participant FE as Frontend (AiAssistantPage)
    participant BE as /api/llm/ask (SSE)
    participant SAN as sanitize-llm-input
    participant RBAC as rbac-service (per-req scope)
    participant RAG as rag-service
    participant EMB as embedding provider<br/>(resolveUsecase('embedding'))
    participant PG as Postgres (pgvector + FTS)
    participant SP as subpage-context
    participant CF as Confluence
    participant MCP as mcp-docs / searxng
    participant CACHE as llm-cache (Redis)
    participant PROV as chat provider<br/>(resolveUsecase('chat'))
    participant CONV as llm_conversations

    FE->>BE: POST /api/llm/ask<br/>{ question, model, conversationId,<br/>  includeSubPages, externalUrls, searchWeb }
    BE->>SAN: sanitize(question)
    SAN-->>BE: sanitized question (+ warnings)
    opt prompt-injection detected
        BE->>PG: INSERT audit_log (PROMPT_INJECTION_DETECTED)
        note right of BE: promptInjectionDetected / sanitized attestation<br/>flags set on the llm_audit_log row —<br/>request continues with the sanitized question
    end
    BE->>CACHE: getCachedResponse(key)
    alt cache hit
        CACHE-->>BE: answer
        BE-->>FE: SSE { content, done:true, fromCache:true }
    else miss (stampede lock)
        CACHE-->>BE: lock acquired
        BE->>EMB: POST /v1/embeddings (question)
        EMB-->>BE: q_vector[N]
        BE->>RBAC: getUserAccessibleSpacesMemoized(userId)
        RBAC-->>BE: readableSpaceKeys[] (request-scoped)
        par vector + keyword
            BE->>RAG: vectorSearch(userId, q_vector)
            RAG->>PG: WHERE cp.space_key = ANY(readableSpaceKeys) ...
            PG-->>RAG: top-K chunks
        and
            BE->>RAG: keywordSearch(userId, question)
            RAG->>PG: tsvector search WHERE same space filter
            PG-->>RAG: matches
        end
        RAG-->>BE: merged + deduped + ranked
        opt RAG_PERMISSION_ENFORCEMENT (EE)
            BE->>RBAC: userCanAccessPage(userId, pageId) for each candidate
            RBAC-->>BE: filter decision (per-page read ACE honoured)
            note right of BE: candidates were overfetched 1.5x<br/>at vector/fts stage to compensate
        end
        opt includeSubPages
            BE->>RBAC: userCanAccessPage(userId, parentPageId)
            RBAC-->>BE: allow / deny (#814 — skip tree on deny)
            BE->>SP: assembleSubPageContext(rootPageId)
            SP->>RBAC: getUserAccessibleSpacesMemoized(userId)
            SP->>CF: fetch child tree WHERE deleted_at IS NULL<br/>AND visible to user (space RBAC)
            CF-->>SP: pages
            SP-->>BE: tree context
        end
        opt externalUrls provided
            BE->>MCP: fetch urls
            MCP-->>BE: content (sanitized; detections audited — same flags)
        end
        opt searchWeb
            BE->>MCP: search(question)
            MCP-->>BE: top results (sanitized; detections audited — #835)
        end
        BE->>BE: build system prompt + context<br/>(resolveSystemPrompt, guardrails)
        BE->>BE: resolveUsecase('chat')<br/>→ { config, model }
        BE->>PROV: streamChat(config, resolvedModel, messages)
        loop chunks
            PROV-->>BE: delta
            BE-->>FE: SSE { content: delta }
        end
        PROV-->>BE: done
        BE->>CACHE: setCachedResponse(key, answer)
        BE->>CONV: upsert message + answer + sources
        BE->>PG: INSERT audit_log (tokens, latency, doc_ids)
        BE-->>FE: SSE { done:true, conversationId, sources }
    end
```

### Permission-check checkpoint

Per ADR-022, RAG retrieval post-filters vector and FTS candidate sets by the
caller's readable space keys. The resolver
(`rbac-service.getUserAccessibleSpaces`) is memoised per request via
`AsyncLocalStorage`, so a single hybrid query touches the RBAC path once
regardless of how many retrieval calls execute. The Fastify `authenticate`
hook enters the scope on every authenticated request via `enterRbacScope`,
synchronously before its first `await` (the scope's `userId` is filled in once
token verification succeeds) — `enterWith` only propagates the store to
continuations descending from the frame it is called in, so entering it after
an await would leave the route handler without the scope and the memo dead at
runtime (#899). The memoised wrapper falls back to the raw resolver outside a
scope (background workers, tests that skip the opt-in).

Per ADR-023 (EE — `RAG_PERMISSION_ENFORCEMENT`), a second post-filter runs
after the RRF merge when the feature is active. It calls
`userCanAccessPage(userId, pageId)` for each merged candidate, gating
retrieval on per-page read ACEs. The sync path (ADR-023) writes Confluence's
effective read restrictions — resolved through the ancestor chain at sync
time — into `access_control_entries` with `source='confluence'`, so the
query-time check is a single consistent `userCanAccessPage` call per
candidate. Candidates are overfetched at 1.5× `topK` at the vector and FTS
stages to give the filter headroom. When the feature is off (CE or EE
without the flag), neither the overfetch nor the second post-filter runs —
behaviour matches v0.3.

The `includeSubPages` branch (#814) is gated independently of the RAG
retrieval filters, since it injects a caller-supplied page tree rather than
retrieved chunks. Before assembly, `/llm/ask` enforces the same access check
as `GET /pages/:id` on the parent (`userCanAccessPage`) and skips the branch
on denial. `subpage-context.fetchSubPages` then resolves the caller's readable
spaces once and applies `visiblePagesPredicate` plus `deleted_at IS NULL` to
every descendant query, so cross-space or soft-deleted sub-pages never reach
the LLM prompt on any route (`ask`, `improve`, `analyze-quality`, `summarize`).

## Image input flow (#1154)

`/api/llm/ask` does not accept an image — only `/api/llm/generate` and
`/api/llm/improve` do, via an `imageHandle` staged ahead of time:

```
POST /api/llm/prepare-image        multipart; magic-byte sniff, <=4096 per
                                   edge, <=5 MB
  -> INFO memory                   headroom pre-flight (#1183)
       used + incoming <= N% of maxmemory -> continue
       over                               -> 503, nothing written
       maxmemory 0, or INFO unreadable    -> continue (fail open — the SET's
                                             own OOM reply is the backstop
                                             and maps to the same 503)
  -> Redis  llm:img:<userId>:<sha256>   TTL 900s; raw bytes behind a
                                        `<format>\n` header, not base64.
                                        Not consumed on read, but a new
                                        upload evicts the user's previous
                                        one (one staged image per user —
                                        Redis is shared and noeviction).
  -> { handle, format, width, height, fileSize }

POST /api/llm/generate | /api/llm/improve   { ..., imageHandle }
  -> resolveUsecase('chat')          -> { config, resolvedModel }
  -> getVisionCapability(providerId, resolvedModel)
       true            -> continue
       false | null    -> 422 (fail closed — a client-side gate is never trusted)
  -> loadStagedImage(userId, imageHandle)
       hit             -> continue, handle stays in Redis (regenerate-safe)
       miss/expired    -> 410
  -> buildLlmCacheKey(..., { imageHash: imageHandle })
  -> streamChat(cfg, resolvedModel, [
       { role: 'system', content: systemPrompt },              // string, unchanged
       { role: 'user',   content: [ { type: 'text', ... },
                                     { type: 'image_url', ... } ] }   // array, #1154
     ])
```

The capability gate and the staging load are both centralised in
`resolveImagePart` (`routes/llm/_helpers.ts`) so `/llm/generate` and
`/llm/improve` cannot drift on the 422/410 semantics. `getVisionCapability`
never blocks this request path on an LLM round-trip — it returns the stored
verdict and only schedules a background re-probe (see ADR-021's `#1154`
amendment and `06-data-model.md`'s `llm_model_capabilities` entry). Because
the handle is the sha256 of the validated bytes, it doubles as the
`imageHash` cache-key input without a separate hashing step — two different
images with the same prompt produce two distinct cache keys.

The `INFO memory` pre-flight (#1183) exists because the per-user cap alone is a
mitigation, not a bound: it holds the namespace to `users x 5 MB`, which still
fills the shipped `--maxmemory 256mb` if enough people upload inside one TTL
window — and that instance is `noeviction` and shared with BullMQ, so filling it
fails *writes* application-wide. Refusing the upload turns an app-wide enqueue
outage into one degraded feature. The threshold is
`IMAGE_STAGING_MAX_REDIS_PERCENT` (default 80). The check is uncached — one
O(1) command on a path that already streams and hashes megabytes, where a stale
"there is room" would admit every upload inside the cache window on a single
reading.

Note the fail-open branches above are a real gap, not just a fallback: a
deployment whose Redis does not answer `INFO` (renamed or ACL-blocked, common on
hardened and managed instances) never engages the ceiling at all and is back to
the per-user mitigation, with `OOM` on the `SET` arriving only once BullMQ is
already blocked. ADR-021's `#1183` paragraphs carry the reasoning; `.env.example`
states the condition where an operator will meet it.

## Retrieval details

- **Vector search** uses pgvector's `<=>` cosine distance against an HNSW
  index on `page_embeddings.embedding`. `ef_search` is set per request for
  a recall/latency trade-off.
- **Keyword search** uses the PostgreSQL text-search configuration from
  `FTS_LANGUAGE` (default `simple`; set `german`, `english`, etc. for
  language-aware stemming).
- **Hybrid merge** deduplicates by `page_id`, keeps the best chunk per
  page, and re-ranks using a weighted blend.
- **Scope** — results are filtered to pages the requesting user can see
  (own pages + spaces they have RBAC access to).

## Streaming contract

The SSE frames use JSON events:

```
data: { "content": "partial token" }
data: { "content": "more tokens" }
data: { "done": true, "conversationId": "…", "sources": [ … ] }
```

On abort (client disconnect) the backend aborts the upstream LLM request —
see `backend/src/routes/llm/sse-abort.test.ts` for the behaviour we rely on.

## Cache + stampede protection

- **Key** = `hash(userId, model, normalizedQuestion, contextFingerprint)`.
- Cache hit → answer returned immediately from Redis.
- Cache miss → a Redis lock is taken; concurrent identical requests wait
  for the first writer and then read the fresh entry, avoiding duplicate
  LLM calls.
- TTL: `LLM_CACHE_TTL` (default `3600`s).

## Related routes

All of these go through the same provider resolver and sanitization layer:

| Route | Purpose |
|-------|---------|
| `POST /api/llm/ask` | RAG Q&A (this diagram) |
| `POST /api/llm/improve` | Improve an existing article; optional `referenceText` carries an attached document (#1131), optional `imageHandle` carries a staged image (#1154, see below) |
| `POST /api/llm/generate` | Generate a new article; optional `documentText` carries an attached document (`pdfText` until #1132), optional `imageHandle` carries a staged image (#1154, see below) |
| `POST /api/llm/summarize` | Summarize a page |
| `POST /api/llm/generate-diagram` | Generate a Mermaid diagram from prose |
| `POST /api/llm/extract-document` | Uploaded document → text extraction, sanitized (pdf · docx · odt · rtf · md · txt — see `11-content-pipeline.md`). The only path — the `POST /api/llm/extract-pdf` alias was retired with the #1131 UI PR |
| `POST /api/llm/prepare-image` | Stages an uploaded image (png/jpeg/webp/gif; SVG refused) in Redis for `generate`/`improve` to consume (#1154, see below) |

## Key files

- `backend/src/routes/llm/llm-ask.ts`
- `backend/src/domains/llm/services/rag-service.ts`
- `backend/src/domains/llm/services/embedding-service.ts`
- `backend/src/domains/llm/services/llm-provider-resolver.ts` (per-use-case provider + model resolver)
- `backend/src/domains/llm/services/openai-compatible-client.ts` (unified client — `chat` / `streamChat` / `generateEmbedding` with queue + per-provider circuit breakers)
- `backend/src/domains/llm/services/llm-cache.ts`
- `backend/src/core/utils/sanitize-llm-input.ts`
- `backend/src/domains/confluence/services/subpage-context.ts`
