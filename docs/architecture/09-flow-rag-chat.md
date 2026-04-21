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
    alt prompt-injection detected
        SAN-->>BE: flagged
        BE->>PG: INSERT audit_log (llm_prompt_injection)
        BE-->>FE: SSE error (blocked)
    else clean
        SAN-->>BE: ok
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
            opt includeSubPages
                BE->>SP: assembleSubPageContext(rootPageId)
                SP->>CF: fetch parent/child tree
                CF-->>SP: pages
                SP-->>BE: tree context
            end
            opt externalUrls provided
                BE->>MCP: fetch urls
                MCP-->>BE: content
            end
            opt searchWeb
                BE->>MCP: search(question)
                MCP-->>BE: top results
            end
            BE->>BE: build system prompt + context<br/>(resolveSystemPrompt, guardrails)
            BE->>BE: resolveChatAssignment(model)<br/>(getUsecaseLlmAssignment('chat') — #217)
            alt admin set chat override (source.provider='usecase' or source.model='usecase')
                BE->>PROV: providerStreamChatForUsecase(provider, model, prompt)
            else no override
                BE->>PROV: providerStreamChat(userId, model, prompt)
            end
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
    end
```

### Permission-check checkpoint

Per ADR-022, RAG retrieval post-filters vector and FTS candidate sets by the
caller's readable space keys. The resolver
(`rbac-service.getUserAccessibleSpaces`) is memoised per request via
`AsyncLocalStorage`, so a single hybrid query touches the RBAC path once
regardless of how many retrieval calls execute. The Fastify `authenticate`
hook enters the scope on every authenticated request via `enterRbacScope`; the
memoised wrapper falls back to the raw resolver outside a scope (background
workers, tests that skip the opt-in).

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
| `POST /api/llm/improve` | Improve an existing article |
| `POST /api/llm/generate` | Generate a new article |
| `POST /api/llm/summarize` | Summarize a page |
| `POST /api/llm/diagram` | Generate a Mermaid diagram from prose |
| `POST /api/llm/pdf/extract` | PDF → text → summary |

## Key files

- `backend/src/routes/llm/llm-ask.ts`
- `backend/src/domains/llm/services/rag-service.ts`
- `backend/src/domains/llm/services/embedding-service.ts`
- `backend/src/domains/llm/services/llm-provider-resolver.ts` (per-use-case provider + model resolver)
- `backend/src/domains/llm/services/openai-compatible-client.ts` (unified client — `chat` / `streamChat` / `generateEmbedding` with queue + per-provider circuit breakers)
- `backend/src/domains/llm/services/llm-cache.ts`
- `backend/src/core/utils/sanitize-llm-input.ts`
- `backend/src/domains/confluence/services/subpage-context.ts`
