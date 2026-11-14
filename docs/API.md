# Compendiq API Reference

Compendiq provides a RESTful API built on Fastify 5 with auto-generated interactive documentation.

## Interactive API Documentation

The backend serves interactive Swagger UI documentation at:

```
http://localhost:3051/api/docs
```

This is the primary API reference. It is auto-generated from route schemas using `@fastify/swagger` and `@fastify/swagger-ui`, and is always up to date with the running server.

> **Note:** Swagger UI is only served in non-production environments. It is disabled when `NODE_ENV=production` to avoid exposing the full API schema.

## Authentication

All endpoints except `/api/health` and `/api/auth/*` require a valid JWT Bearer token.

Include the token in the `Authorization` header:

```
Authorization: Bearer <access-token>
```

Access tokens are obtained via the login endpoint and have a configurable expiry (default: 1 hour). Use the refresh endpoint to obtain new access tokens without re-authenticating.

## API Groups

| Prefix | Description |
|--------|-------------|
| `GET /api/health` | Health checks (live, ready, start probes) |
| `POST /api/auth/*` | Authentication (register, login, refresh, logout) |
| `GET/PUT /api/settings` | User settings (Confluence URL, PAT, model selection) |
| `GET/PUT/DELETE /api/notion/connection` | Notion internal integration token (`hasToken` only; secret never returned) |
| `GET /api/notion/tree` | Authenticated Notion workspace tree (pages **and** databases selectable; a database carries `recommendedMode` `table`/`pages` plus `rowContent`, `isWiki`, `rowCount`, `columns`; Board layouts and other unsupported types carry `skipReason`; Board cards remain selectable articles) |
| `POST /api/notion/import` | Start a one-shot import of selected Notion pages and databases as standalone pages (202 `{ status: 'importing' }`; `databaseModes` picks `skip`/`table`/`pages` per database). Results are not on this response. |
| `GET /api/notion/import/status` | Background import job (`idle` / `importing` / `complete` with per-item success / skip / fail / already_imported plus `importedAs` `page`/`article`/`table` / `error`) |
| `GET/POST/PUT/DELETE /api/pages/*` | Page CRUD, versions, tags, embeddings, duplicates, export/import |
| `GET /api/spaces` | Confluence space listing and selection |
| `POST /api/sync` | Manual sync trigger |
| `POST /api/llm/*` | LLM operations (improve, generate, summarize, ask, PDF extract) |
| `GET /api/embeddings/status` | Embedding pipeline status |
| `GET/POST/PUT/DELETE /api/templates/*` | Knowledge base templates (personal + admin-global) |
| `GET/POST /api/comments/*` | Page comments |
| `GET /api/analytics/*` | Content analytics and search analytics |
| `GET/POST /api/verification/*` | Page verification/review workflow |
| `GET/POST /api/notifications/*` | User notifications |
| `GET/POST /api/admin/*` | Admin operations (key rotation, audit log, LLM settings, OIDC, RBAC) |

### Standalone Trash and restore (#1742)

`GET /api/pages/trash` lists only the caller's deleted standalone articles.
Every item retains its existing fields and ISO dates and adds REQUIRED
`spaceKey: string | null` (the raw stored key) and `spaceMissing: boolean`.
Missing-space articles remain listed. NULL and historical `__local__` are
valid virtual roots, so `spaceMissing` is false for both; an existing
Confluence container is also not missing. These fields are snapshot hints,
not a restore reservation or permission to show a target picker.

`POST /api/pages/:id/restore` accepts a positive integer page PK
(1–2147483647; decimal URL padding is accepted), not a Confluence identifier.
Ordinary restore needs no body; `{}` is equivalent. Success remains
`{"id":42,"title":"Trashed note","restored":true}`; an already-live owned
standalone article returns `restored:false`, without repair or new effects.
Explicit null/scalar/array bodies and null/numeric/empty target fields are
validation400s. Unknown object fields strip; raw target keys are not trimmed
or case-folded.

If the root's real space M is absent, a bodyless request returns exactly:

```json
{"statusCode":409,"error":"Conflict","reason":"restore_space_missing","message":"The space \"M\" no longer exists. Choose a space to restore into.","missingSpaceKey":"M","canChooseTarget":true}
```

Only this current true response permits a deliberate retry with
`{"targetSpaceKey":"EXISTING_LOCAL_KEY"}` or
`{"targetSpaceKey":"__local__"}`. The latter stores NULL. Local containers
are not restricted to their creator. No target is guessed/created and no
automatic request retry occurs. Stored NULL/`__local__` and existing stored
spaces allow omitted or identical effective targets only; they cannot be
moved by restore. An existing Confluence container preserves ordinary
standalone restore but is not a valid rehome destination.

Only authorized same-trash-batch rows carrying M are rekeyed, atomically with
untrash in one statement. Every other retained nonvirtual space must exist.
If another batch key N is missing, the entire restore refuses, including
after selecting a valid root target:

```json
{"statusCode":409,"error":"Conflict","reason":"restore_space_missing","message":"The space \"N\" for another page in this trash batch no longer exists. This batch cannot be restored by choosing a target for this page.","missingSpaceKey":"N","canChooseTarget":false}
```

`canChooseTarget` is a REQUIRED boolean on every missing-space refusal,
assigned from that transaction's current refusal state. False has no root
target remedy. Clients must show the current message and not open/reopen a
picker for false, absent or malformed flags. Never infer permission from
cached list metadata, message parsing or historical key equality: another
client may restore/rehome/retrash between attempts. A new explicit bodyless
request may legitimately return true for a different current root state.
Bulk reports both missing-space states without retry loops.

The other new semantic refusals use the same existing route envelope:

```json
{"statusCode":400,"error":"ValidationError","reason":"restore_target_not_applicable","message":"A restore target can only be chosen when the stored space no longer exists."}
```

```json
{"statusCode":409,"error":"Conflict","reason":"restore_target_space_invalid","message":"The selected restore space is unavailable. Choose an existing local space."}
```

Unknown/deleted/nonlocal targets share the generic invalid-target response
without exposing target source/owner/title or access. Missing keys describe
only the authorized owner's standalone batch, not foreign/traversal pages.
Existing owner/source/ancestor/import/ambiguity/frozen/pending refusals retain
their precedence and envelopes; old PageWriteError bodies may omit message.
No new wrapper, reason beyond these three, general move/repair, purge or
Confluence-sourced-row behavior is introduced.

Actual rehome detaches only the restored root when its unique resolved LIVE
direct parent is in a different effective space; child links, paths/depths
and non-actionable/unresolved parents stay unchanged. Restore holds all
existing final spaces FOR SHARE through commit; local deletion locks its row
FOR UPDATE before counting/deleting. Deletion still refuses only live pages,
not trash; a concurrent loser refuses instead of producing a live orphan.
`PAGE_RESTORED` audit adds raw `targetSpaceKey` (including `__local__`) and
`missingSpaceKey` only for actual rehome; padded URL resource identity stays
raw. Audit restoredCount uses actual updated rows, not a new response field.

### Duplicate lookup

`GET /api/pages/:id/duplicates` accepts a standalone page's internal numeric ID
or a Confluence page's content ID. Both the source and candidates use the
caller's page visibility, including restrictions; inaccessible, deleted,
missing, or visibly ambiguous sources return an empty `duplicates` array.
Standalone rows' historical Confluence IDs are not source identifiers.
`GET /api/admin/duplicates` scans the same caller-visible corpus, but its
pair cap and average-to-average scoring differ from the per-page candidate scan.

## Example Requests

### Health Check

```bash
curl http://localhost:3051/api/health
```

Response:

```json
{
  "status": "ok",
  "services": {
    "postgres": true,
    "redis": true,
    "llm": true
  },
  "llmProvider": "OpenAI Prod",
  "version": "0.6.2",
  "uptime": 3600.123
}
```

> `/api/health` is public (unauthenticated). It reports only coarse status plus
> the provider name and build version the frontend needs. Internal operational
> telemetry (per-provider circuit-breaker state, LLM/BullMQ queue metrics) is
> not exposed here.

### Register a User

```bash
curl -X POST http://localhost:3051/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "username": "admin",
    "email": "admin@example.com",
    "password": "your-secure-password"
  }'
```

Response:

```json
{
  "user": {
    "id": "uuid",
    "username": "admin",
    "email": "admin@example.com",
    "role": "admin"
  },
  "accessToken": "eyJhbG...",
  "refreshToken": "eyJhbG..."
}
```

### Login

```bash
curl -X POST http://localhost:3051/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "username": "admin",
    "password": "your-secure-password"
  }'
```

### Refresh Token

```bash
curl -X POST http://localhost:3051/api/auth/refresh \
  -H "Content-Type: application/json" \
  -d '{
    "refreshToken": "eyJhbG..."
  }'
```

### List Pages

```bash
curl http://localhost:3051/api/pages \
  -H "Authorization: Bearer <access-token>"
```

The optional `visibility=private` or `visibility=shared` query parameter
narrows the caller-visible rows by their stored visibility, including
Confluence rows. It applies to the total and to search's substring fallback as
well as the returned items. Omitting it leaves visibility unfiltered; access
rules still apply in every case. Filter-based bulk selection uses the same
visibility condition.

### Get a Page

```bash
curl http://localhost:3051/api/pages/<page-id> \
  -H "Authorization: Bearer <access-token>"
```

### Article Connections

`GET /api/pages/:id/connections` returns the article's `linked`, `section`, and
`related` groups. IDs on this endpoint are numeric `pages.id` values, serialized
as strings. Each item contains `pageId`, `title`, and a `reasons` array:

| Persisted type | Evidence on the response |
|---|---|
| `explicit_link` | `direction`: `incoming` or `outgoing`, verified against the current link content |
| `parent_child` | `direction`: `parent` or `child`, verified against the current hierarchy |
| `embedding_similarity` | The persisted numeric `score` |
| `label_overlap` | Actual shared `labels` and the persisted numeric `score` |

Related recommendations contain at most five unique targets, ranked by their
highest persisted evidence score, then numeric page ID. Reciprocal similarity
rows contribute one target with the maximum score. Direct and hierarchy targets
are not repeated as semantic recommendations. An empty response contains three
empty arrays; unavailable source pages return 404. Source and target visibility
checks precede recommendation ranking.

Deterministic relationship materialization is independent of embeddings. Page
mutations invalidate deterministic evidence in the database; the authorized
Connections and focused-local-graph read paths settle pending materialization
through the shared engine before returning results. Unchanged reads do not
rebuild the corpus, and failures are reported rather than converted to empty
groups. Semantic scores are not rewritten by deterministic-only work.

`POST /api/pages/:id/connections/events` collects authenticated panel usage:

```json
{"event":"impression","visitId":"f72f706e-a3b4-46cb-91f0-926558a03d68"}
```

The other event bodies are `{"event":"graph_launch","visitId":"<uuid>"}` and
`{"event":"connection_click","visitId":"<uuid>","targetPageId":"42","group":"related"}`.
The group is `linked`, `section`, or `related`. Requests use the shared strict
`ConnectionEventSchema`; successful collection returns `{"recorded":true}`.
Never send titles, labels, relationship explanations, scores, or article bodies
as analytics metadata. See the administrator guide for impression semantics and
the four-week adoption review.

### Search Pages

```bash
curl "http://localhost:3051/api/search?q=deployment&mode=hybrid" \
  -H "Authorization: Bearer <access-token>"
```

In `mode=keyword`, `items` pages one deduplicated list of full-text matches and
typo-tolerant title matches. No page holds more than `limit` items, each result
appears on exactly one page, and `total` counts the whole list on every page
(`totalPages` is `ceil(total / limit)`). A `page` past the last returns no items
and the same `total`. `sort=relevance` lists full-text matches by text rank,
then title-only matches by similarity; `sort=modified` and `sort=title` order
both together. The page id breaks ties.

Every search item includes `source: "standalone" | "confluence"`, taken from
the current page record in every search mode and fallback path. A named
`spaceKey` or historical `confluenceId` does not determine provenance.

In `mode=keyword`, `spaceKey`, `author`, `dateFrom`, `dateTo`, `tags` and
`aiPolicy` apply to every returned item, including typo-tolerant title
matches.

### Readiness Probe (for Kubernetes / Docker)

```bash
curl http://localhost:3051/api/health/ready
```

Response:

```json
{
  "status": "ok",
  "services": {
    "postgres": true,
    "redis": true
  },
  "version": "0.6.2",
  "uptime": 3600.123
}
```

## Rate Limiting

The API enforces rate limiting:

- **Global:** 300 requests per minute per IP (default; configurable by admins)
- **Admin endpoints:** stricter limits
- **LLM endpoints:** stricter limits (due to resource intensity)

Exceeding the rate limit returns `429 Too Many Requests`.

## Error Responses

Errors follow a consistent format:

```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": "Description of what went wrong"
}
```

Common status codes:

| Code | Meaning |
|------|---------|
| `400` | Bad Request -- invalid input |
| `401` | Unauthorized -- missing or invalid token |
| `403` | Forbidden -- insufficient permissions |
| `404` | Not Found |
| `429` | Too Many Requests -- rate limited |
| `500` | Internal Server Error |
| `503` | Service Unavailable -- dependency down |
