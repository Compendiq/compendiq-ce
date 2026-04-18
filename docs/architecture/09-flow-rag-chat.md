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
    participant RAG as rag-service
    participant OL as Ollama (embed)
    participant PG as Postgres (pgvector + FTS)
    participant SP as subpage-context
    participant CF as Confluence
    participant MCP as mcp-docs / searxng
    participant CACHE as llm-cache (Redis)
    participant PROV as LLM provider<br/>(Ollama / OpenAI)
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
            BE->>OL: POST /api/embeddings (question)
            OL-->>BE: q_vector[1024]
            par vector + keyword
                BE->>RAG: vectorSearch(q_vector, userId, topK)
                RAG->>PG: SELECT ... ORDER BY embedding <=> $1<br/>WHERE user_id=$2 AND space in (...)
                PG-->>RAG: top-K chunks
            and
                BE->>RAG: hybridKeyword(question, userId)
                RAG->>PG: tsvector / BM25 search
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
- `backend/src/domains/llm/services/llm-provider.ts` (Ollama vs OpenAI resolver)
- `backend/src/domains/llm/services/llm-cache.ts`
- `backend/src/core/utils/sanitize-llm-input.ts`
- `backend/src/domains/confluence/services/subpage-context.ts`
