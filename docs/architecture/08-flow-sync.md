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

        Note over S,DB: Deletion reconciliation (#706) — every sync, incremental too
        S->>CL: getAllPageIds(spaceKey)
        CL->>CF: GET /rest/api/content?spaceKey=… (ids only, no expand)
        CF-->>CL: authoritative live id set
        CL-->>S: liveIds
        S->>DB: SELECT confluence_id FROM pages WHERE space_key=… AND deleted_at IS NULL
        loop per candidate (local row absent from liveIds)
            S->>CL: getPage(confluenceId) — confirm gone
            CL->>CF: GET /rest/api/content/{id}
            alt 404 (genuinely deleted)
                CF-->>S: 404
                S->>DB: UPDATE pages SET deleted_at = NOW()
            else 200 / 403 (still there / not visible to this principal)
                CF-->>S: 200 / 403
                Note over S: leave row in place (shared-space safe)
            end
        end

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

## Deletion reconciliation (#706)

Pages removed in Confluence are reflected locally by `detectDeletedPages`, which
runs on **every** sync — incremental as well as the ≥24h full sync — so deletions
surface within a normal sync cycle rather than lingering until a rare full run.

- **Bounded cost.** The authoritative live id set comes from a dedicated cheap
  listing (`getAllPageIds`: ids only, no `expand`), so a candidate set is derived
  by set difference rather than re-fetching every page. The incremental
  modified-pages list can't be used for this — it only holds pages that changed.
- **Shared-space safety.** A page absent from one principal's listing is *not*
  assumed deleted (it may simply be restricted from that user). Each candidate is
  confirmed gone via a direct `GET /content/{id}` → **404** before its row is
  soft-deleted; a `200`/`403` leaves the row untouched, so one user's restricted
  view can no longer nuke pages others can still see. The number of confirmation
  fetches per run is capped (`MAX_DELETION_CONFIRMATIONS`); a larger candidate set
  is deferred to a later run (the whole run defers — zero soft-deletes that cycle).
- **Trash vs. purge.** Confluence DC move-to-trash does **not** make a page 404 —
  `GET /content/{id}` still returns `200` with `status: "trashed"`. So a page sitting
  in the Confluence trash is treated as *still present* and is **not** reconciled;
  reconciliation fires only once the page is hard-purged (then the id is gone from
  `getAllPageIds` *and* the confirmation fetch returns 404). This is intentional —
  it mirrors Confluence's own "deleted means purged" semantics and avoids removing a
  page a Confluence admin could still restore from the trash.
- **Per-cycle fan-out.** Reconciliation is invoked once per (user × space); a shared
  space would otherwise repeat the listing + confirmation fetches per user each cycle.
  A best-effort Redis `SET NX EX` guard (`sync:reconcile:{spaceKey}`) lets the first
  run per space claim the cycle and the rest skip. It fails open when Redis is absent
  (runs per-user, as before) and can only narrow work — a true deletion is 404 for
  every principal, so whoever reaches the space first reconciles it.
- **Soft delete + purge.** Reconciled rows are soft-deleted (`deleted_at`), then
  hard-purged after 30 days by `purgeDeletedPages`. A subsequent re-appearance in
  Confluence revives the row: `syncPage`'s upsert `ON CONFLICT … DO UPDATE` (and the
  version-mismatch update path) both set `deleted_at = NULL`.

The same 404-tolerance applies to **user-initiated delete** (`DELETE /api/pages/:id`
and the bulk path): if Confluence answers 404 the remote page is already gone, so
local cleanup proceeds and the delete succeeds instead of failing with
"Resource not found". Any non-404 error still surfaces (no silent data loss).

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
