# 8. Confluence Sync Flow

End-to-end flow for pulling a user's selected Confluence spaces into the
local Postgres + pgvector store. Triggered either manually
(`POST /api/confluence/sync/:spaceKey`) or automatically by the in-process
sync scheduler.

## Sequence

```mermaid
sequenceDiagram
    autonumber
    participant T as Trigger<br/>(scheduler / API)
    participant S as sync-service
    participant R as Redis (lock + status)
    participant CL as confluence-client
    participant CF as Confluence DC
    participant CC as content-converter
    participant AH as attachment-handler
    participant DB as Postgres (pages)
    participant ES as embedding-service
    participant OL as Ollama (/embed)

    T->>S: syncSpace(userId, spaceKey)
    S->>R: SETEX NX sync:worker:lock (TTL 600s)
    alt already locked
        R-->>S: nil
        S-->>T: skip (another run in progress)
    else acquired
        R-->>S: OK
        S->>DB: SELECT user_settings (decrypt PAT)
        S->>CL: getSpaces(pat)
        CL->>CF: GET /rest/api/space
        CF-->>CL: spaces
        CL-->>S: spaces (filtered to selected_spaces)

        loop for each page (recursively, parent-child)
            S->>CL: getPage(pageId)
            CL->>CF: GET /rest/api/content/{id}?expand=body.storage,version,children
            CF-->>CL: XHTML body + metadata
            CL-->>S: page
            S->>CC: confluenceToHtml(XHTML)
            CC-->>S: body_html + body_text
            S->>AH: downloadAttachments(page)
            AH->>CF: GET attachments
            AH->>AH: write to ATTACHMENTS_DIR
            S->>DB: INSERT/UPDATE pages<br/>SET embedding_dirty = true
            S->>R: HSET sync:status:{user} progress
        end

        S->>DB: INSERT/UPDATE page_versions (snapshot)
        S->>R: DEL sync:worker:lock
        S-->>T: done
    end

    Note over ES,OL: Embedding worker (separate loop)
    ES->>DB: SELECT pages WHERE embedding_dirty = true LIMIT N
    loop per page
        ES->>ES: chunk(body_text)
        ES->>OL: POST /api/embeddings (bge-m3)
        OL-->>ES: vector[1024]
        ES->>DB: INSERT page_embeddings
        ES->>DB: UPDATE pages SET embedding_dirty = false
    end
```

## Triggers

| Trigger | Source | Cadence |
|---------|--------|---------|
| Manual sync | `POST /api/confluence/sync/:spaceKey` | on demand |
| Scheduled sync | In-process sync scheduler in `backend/src/index.ts` (`startQueueWorkers`) | every `SYNC_INTERVAL_MIN` (default 15 min) |
| Webhook (future) | not yet implemented | — |

## Concurrency & safety

- **Redis lock (`sync:worker:lock`)** — single active sync per instance;
  TTL acts as a dead-man's switch.
- **Per-user PAT scope** — each sync decrypts the PAT just-in-time, uses it
  for the duration of the run, and never logs it.
- **SSRF guard** — `confluence-client` uses the shared SSRF guard from
  `core/utils/ssrf-guard.ts` to reject URLs pointing at loopback / link-local
  / metadata IPs. Each user-configured Confluence URL is added to a
  per-pod allowlist; mutations (add / remove via Settings → Confluence or
  LLM provider CRUD) are broadcast across pods over Redis pub/sub
  (`ssrf:allowlist:changed`) via `core/services/ssrf-allowlist-bus.ts` so
  multi-pod deployments stay coherent (issue #306).
- **TLS** — respects `CONFLUENCE_VERIFY_SSL` (default `true`) and
  `NODE_EXTRA_CA_CERTS` for self-signed internal CAs.
- **Idempotency** — upsert by `(user_id, confluence_id)`. `version` column
  is written from Confluence's own version counter; no double-writes.
- **Circuit breaker** — `core/services/circuit-breaker.ts` protects against
  runaway failure against a broken Confluence instance.

## Content pipeline hand-off

The `confluenceToHtml()` call produces `body_html` and `body_text`. The
same page is later converted to Markdown *at query time* when sent to the
LLM. See [`11-content-pipeline.md`](./11-content-pipeline.md).

## Key files

- `backend/src/domains/confluence/services/sync-service.ts`
- `backend/src/domains/confluence/services/confluence-client.ts`
- `backend/src/domains/confluence/services/attachment-handler.ts`
- `backend/src/domains/confluence/services/sync-overview-service.ts`
- `backend/src/domains/llm/services/embedding-service.ts`
- `backend/src/routes/confluence/sync.ts`
