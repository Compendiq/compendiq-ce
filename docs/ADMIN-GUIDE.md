# Compendiq Admin Guide

This guide covers installation, configuration, maintenance, and troubleshooting for Compendiq administrators.

## System Requirements

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| **Docker** | 24.0+ | Latest stable |
| **Docker Compose** | v2.20+ | Latest stable |
| **RAM** | 4 GB | 8 GB+ |
| **Disk** | 10 GB | 20 GB+ (depends on attachment cache size) |
| **CPU** | 2 cores | 4 cores |

Additionally, you need an **Ollama** server (or OpenAI-compatible API) accessible from the backend container. Ollama typically runs on the Docker host machine.

## Installation

### Docker Compose (Recommended)

1. **Clone the repository:**

   ```bash
   git clone https://github.com/Compendiq/compendiq-ce.git
   cd compendiq-ce
   ```

2. **Create your environment file:**

   ```bash
   cp .env.example .env
   ```

3. **Configure required secrets** in `.env`:

   ```bash
   # REQUIRED: Generate random 32+ character strings
   JWT_SECRET=<random-32-char-string>
   PAT_ENCRYPTION_KEY=<random-32-char-string>

   # Set strong passwords for infrastructure
   POSTGRES_PASSWORD=<strong-password>
   REDIS_PASSWORD=<strong-password>
   ```

   Generate secure random strings:

   ```bash
   openssl rand -base64 48
   ```

4. **Start all services:**

   ```bash
   docker compose -f docker/docker-compose.yml up -d
   ```

   This starts four containers:
   - **frontend** -- nginx serving the React app (port 8081)
   - **backend** -- Node.js Fastify server (port 3051, internal)
   - **postgres** -- PostgreSQL 17 with pgvector
   - **redis** -- Redis 8 Alpine with password auth and LRU eviction

5. **Pull Ollama models** on your host machine:

   ```bash
   ollama pull bge-m3              # Required for embeddings
   ollama pull qwen3.5            # Or any chat model
   ```

6. **Access Compendiq** at `http://localhost:8081`. Register the first user -- they automatically receive the admin role.

### Verifying the Installation

Check that all containers are healthy:

```bash
docker compose -f docker/docker-compose.yml ps
```

All services should show `(healthy)` status. You can also hit the health endpoint:

```bash
curl http://localhost:3051/api/health
```

## Configuration Reference

### Required Secrets

| Variable | Description |
|----------|-------------|
| `JWT_SECRET` | JWT signing secret. Must be 32+ characters. Server refuses to start in production with default value. |
| `PAT_ENCRYPTION_KEY` | AES-256-GCM key for encrypting Confluence PATs. Must be 32+ characters. Server refuses to start in production with default value. |

### Database

| Variable | Default | Description |
|----------|---------|-------------|
| `POSTGRES_URL` | `postgresql://kb_user:changeme-postgres@localhost:5432/kb_creator` | PostgreSQL connection string |
| `POSTGRES_TEST_URL` | `postgresql://kb_user:changeme-postgres@localhost:5433/kb_creator_test` | Test database connection (port 5433) |
| `POSTGRES_USER` | `kb_user` | PostgreSQL username (Docker Compose only) |
| `POSTGRES_PASSWORD` | `changeme-postgres` | PostgreSQL password (Docker Compose only) |
| `POSTGRES_DB` | `kb_creator` | PostgreSQL database name (Docker Compose only) |

### Redis

| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_URL` | `redis://:changeme-redis@localhost:6379` | Redis connection string |
| `REDIS_PASSWORD` | `changeme-redis` | Redis AUTH password (Docker Compose only) |

### Server

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | `development` | Set to `production` for production deployments |
| `BACKEND_PORT` | `3051` | Backend server port |
| `FRONTEND_URL` | `http://localhost:5273` | Used for CORS origin and OIDC redirects |
| `FRONTEND_PORT` | `5273` | Host port mapped to the frontend container (Docker Compose only) |
| `LOG_LEVEL` | `info` | Pino log level: `fatal`, `error`, `warn`, `info`, `debug`, `trace` |
| `ACCESS_TOKEN_EXPIRY` | `1h` | JWT access token lifetime (jose duration format: `30m`, `1h`, `2h`) |

### LLM Provider

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_PROVIDER` | `ollama` | LLM provider: `ollama` or `openai` (server-wide default, can be overridden per-user) |
| `DEFAULT_LLM_MODEL` | *(none)* | Fallback model for background workers when their specific model var is not set |

### Ollama

| Variable | Default | Description |
|----------|---------|-------------|
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server URL |
| `LLM_BEARER_TOKEN` | *(none)* | Bearer token for authenticated Ollama/LLM proxies |
| `LLM_AUTH_TYPE` | `bearer` | Auth type for LLM connections: `bearer` or `none` |
| `LLM_VERIFY_SSL` | `true` | Set to `false` to disable TLS verification for LLM connections |
| `LLM_STREAM_TIMEOUT_MS` | `300000` | Streaming request timeout in ms (5 min). Increase for very large articles. |
| `LLM_CACHE_TTL` | `3600` | Redis TTL in seconds for LLM response cache (1 hour) |

### OpenAI-Compatible API

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible API base URL. Works with OpenAI, Azure OpenAI, LM Studio, vLLM, llama.cpp, LocalAI. |
| `OPENAI_API_KEY` | *(none)* | API key (required when using `openai` provider) |

### Embedding

| Variable | Default | Description |
|----------|---------|-------------|
| `EMBEDDING_MODEL` | `bge-m3` | Server-wide embedding model (1024 dimensions by default) |
| `RAG_EF_SEARCH` | `100` | HNSW ef_search parameter for pgvector similarity queries |

### Background Workers

| Variable | Default | Description |
|----------|---------|-------------|
| `QUALITY_CHECK_INTERVAL_MINUTES` | `60` | How often the quality analysis worker runs |
| `QUALITY_BATCH_SIZE` | `5` | Pages analyzed per quality worker cycle |
| `QUALITY_MODEL` | `DEFAULT_LLM_MODEL` then `qwen3:4b` | LLM model for quality analysis |
| `SUMMARY_CHECK_INTERVAL_MINUTES` | `60` | How often the summary worker scans for pages |
| `SUMMARY_BATCH_SIZE` | `5` | Max pages to summarize per worker cycle |
| `SUMMARY_MODEL` | `DEFAULT_LLM_MODEL` then *(disabled)* | LLM model for summaries. Empty = disabled. |
| `SYNC_INTERVAL_MIN` | `15` | Background sync scheduler polling interval (minutes) |

### Background Job Queue (BullMQ)

Compendiq uses BullMQ (Redis-backed) for reliable background job processing. Six worker types run as BullMQ queues:

| Queue | Purpose | Default Interval |
|-------|---------|-----------------|
| `sync` | Confluence space synchronization | 15 min |
| `quality` | Page quality analysis (LLM) | 60 min |
| `summary` | Auto-summary generation (LLM) | 60 min |
| `maintenance` | Expired token cleanup | 24 hours |
| `maintenance` | Data retention cleanup | 24 hours |
| `reembed-all` | Global re-embed of every non-folder page (issue #257) | On-demand |

**Configuration:**
- `USE_BULLMQ=true` (default) -- set to `false` to fall back to legacy `setInterval` workers
- Redis `maxmemory-policy` must be `noeviction` (default in the provided Docker config)
- Job history is stored in the `job_history` PostgreSQL table for observability
- Queue metrics are exposed via `GET /api/health` under the `queues` key
- `REEMBED_WAIT_LOCKS_MS=600000` (default 10 min): how long the `reembed-all`
  worker waits for in-flight per-user embedding runs to finish before
  aborting the job. Visible in the admin UI via `GET /api/admin/embedding/locks`.
- `reembed_history_retention` (admin setting, default 150): how many
  completed/failed `reembed-all` job records BullMQ keeps in Redis before
  sweeping the oldest. Range [10, 10000]. Takes effect on the next run.

**Monitoring:** The health endpoint returns per-queue counts (waiting, active, completed, failed):
```bash
curl http://localhost:3051/api/health | jq '.queues'
```

### LLM Request Queue

LLM requests are managed through a concurrency-controlled queue with backpressure:

| Setting | Default | Description |
|---------|---------|-------------|
| `LLM_CONCURRENCY` | `4` | Max concurrent LLM requests |
| `LLM_MAX_QUEUE_DEPTH` | `50` | Max queued requests before rejecting |
| `LLM_STREAM_TIMEOUT_MS` | `300000` | Per-request timeout (5 min) |

Queue metrics are exposed via `GET /api/health` under the `llmQueue` key. When the queue is full, new requests receive a `503` error with a message to retry later.

### Per-User Concurrent SSE-Stream Cap (#268)

Streaming LLM endpoints (`/api/llm/ask`, `generate`, `improve`, `summarize`, `analyze-quality`, `generate-diagram`) intentionally bypass the queue above because streams are long-lived. Without a per-user bound, one user opening many tabs can saturate the upstream LLM.

A Redis counter (`llm:streams:<userId>`) tracks currently-open SSE streams per user. New opens beyond the cap are rejected with **HTTP 429** and body:

```json
{ "error": "too_many_concurrent_streams", "message": "…" }
```

| Setting | Default | Range | Description |
|---------|---------|-------|-------------|
| **Settings → LLM → Runtime limits** (primary) | `3` | `1`–`20` | Admin-configurable. Changes apply within 60 s in every worker; the local worker sees them immediately. |
| `LLM_MAX_CONCURRENT_STREAMS_PER_USER` | `3` | `1`–`20` | **Deprecated bootstrap fallback** — consulted only when the `admin_settings` row is absent. |

**Release semantics.** The counter decrements on all four exit paths: normal completion, error, upstream timeout, and client disconnect. A 1-hour TTL self-heals leaked counters from crashed processes.

**Lowering is graceful.** Existing in-flight streams run to completion; only new opens see the lower cap.

**No admin bypass.** Admins share the same cap as regular users. This is intentional to prevent accidental concurrent-usage incidents from power users.

**Interaction with `LLM_STREAM_RATE_LIMIT`.** The rate limit caps requests per minute; this caps concurrently-open connections. Both can 429 — they are distinguished by the response body's `error` string.

### Confluence

| Variable | Default | Description |
|----------|---------|-------------|
| `CONFLUENCE_VERIFY_SSL` | `true` | Set to `false` to disable TLS verification for Confluence connections |
| `ATTACHMENTS_DIR` | `data/attachments` | Attachment cache directory. Set to an absolute path in production. |

### Confluence API Rate Limiting

A token bucket rate limiter protects your Confluence Data Center instance from being overwhelmed during sync.

- **Default:** 60 requests/minute
- **Configurable:** via `admin_settings` table (key: `confluence_rate_limit_rpm`)
- **Behavior:** When the rate limit is hit, requests are queued (not dropped). They resume automatically as tokens refill.
- **Applied to:** All Confluence API calls including page fetches and attachment downloads

### Security and Encryption

| Variable | Default | Description |
|----------|---------|-------------|
| `PAT_ENCRYPTION_KEYS` | *(none)* | JSON array of versioned keys for rotation (see Encryption Key Rotation below) |
| `PAT_ENCRYPTION_KEY_V1`...`V10` | *(none)* | Numbered env vars for key rotation (alternative to JSON format) |
| `NODE_EXTRA_CA_CERTS` | *(none)* | PEM CA bundle file path for self-signed certificates |

### Email Notifications (SMTP)

Compendiq can send email notifications for key events. Configure SMTP in **Settings > Email / SMTP**.

**Configuration (env vars or admin UI):**

| Variable | Default | Description |
|----------|---------|-------------|
| `SMTP_HOST` | _(empty)_ | SMTP server hostname |
| `SMTP_PORT` | `587` | SMTP port (587 for STARTTLS, 465 for TLS) |
| `SMTP_SECURE` | `false` | Use TLS/SSL |
| `SMTP_USER` | _(empty)_ | SMTP username |
| `SMTP_PASS` | _(empty)_ | SMTP password |
| `SMTP_FROM` | `noreply@compendiq.local` | Sender address |
| `SMTP_ENABLED` | `false` | Enable email notifications |

**Email types:**
- Sync completed / failed
- Knowledge request assigned
- Article comment notification
- License expiry warning (Enterprise)

Settings configured via the admin UI are persisted in the `admin_settings` database table and take precedence over environment variables. Use the **Send Test** button to verify SMTP connectivity.

### Enterprise

| Variable | Default | Description |
|----------|---------|-------------|
| `COMPENDIQ_LICENSE_KEY` | *(none)* | License key for enterprise features (OIDC/SSO, advanced RBAC) |

### OIDC / SSO

OIDC is configured entirely via the Admin UI (Settings > OIDC/SSO). No environment variables are required -- all OIDC configuration is stored in the database.

### IP Allowlist (Enterprise, v0.4+)

The IP allowlist is configured entirely via the Admin UI (Settings > IP allowlist) and persisted in the `admin_settings` table. It is an Enterprise-only feature — Community Edition builds ignore the configuration and register no routes. When enabled, a Fastify `onRequest` hook short-circuits requests from client IPs outside the configured CIDR ranges with a `403 ip_blocked` response, before any auth / business logic runs.

**Config fields (admin UI)**

| Field | Description |
|-------|-------------|
| Enable toggle | Off by default. When off, all traffic is allowed; the trusted-proxy list still applies (see below). |
| Allowed CIDRs | IPv4 and IPv6 CIDRs whose client IPs may reach the API. Example: `10.0.0.0/8`, `2001:db8::/32`. |
| Trusted proxies | CIDRs of reverse-proxy hosts whose `X-Forwarded-For` header will be honoured when resolving the client IP. See the gotcha below. |
| Exempt paths | Read-only list: `/api/health`, `/api/admin/license`, `/api/auth/`. Always accessible so the health check, license-key rotation, and login flow cannot be locked out. |

**Lockout recovery**

If an admin saves an allowlist that excludes their own IP, the UI's "save button disabled until your IP tests as allowed" guard normally catches it. If you do lock yourself out — for example because the upstream proxy changed its source range after save — recover via one of:

1. **Use an exempt path.** `/api/admin/license` and `/api/auth/login` bypass the allowlist. Authenticate from the exempt path, then use `PUT /api/admin/ip-allowlist` directly with `curl` / `httpie` to restore or widen the CIDR list.
2. **Connect from an exempt network.** The defaults trust loopback (`127.0.0.1/32`, `::1/128`). Shell into a pod and `curl http://localhost:3000/api/admin/ip-allowlist` to edit locally.
3. **Last resort — edit Postgres directly.** `UPDATE admin_settings SET setting_value = '…' WHERE setting_key = 'ip_allowlist';` — set `enabled` to `false` to disable the feature entirely, then reconfigure from the UI. Changes propagate cluster-wide via the cache-bus within ~1 second; no restart required.

**Trusted proxies gotcha**

If Compendiq sits behind a reverse proxy (nginx, Traefik, cloud load balancer) that injects `X-Forwarded-For`, you **must** add that proxy's source CIDR to the trusted-proxies list. Otherwise Compendiq sees every request as coming from the proxy itself — so either every request is blocked (proxy not in allowlist) or every request is allowed (proxy happens to be in allowlist, regardless of the real client IP).

The Test panel in the admin UI surfaces the resolved client IP for an arbitrary input; use it to verify the topology matches your expectations before enabling the allowlist.

**IPv6 gotcha**

Node's dual-stack sockets surface IPv4 peers as IPv4-mapped-IPv6 addresses (`::ffff:1.2.3.4`). The allowlist handles this automatically — an IPv4 CIDR will match an IPv4-mapped-IPv6 peer — so you do **not** need to add the `::ffff:…/96` mapped range to your IPv4 CIDRs. Conversely, a pure-IPv6 client that is not IPv4-mapped requires explicit IPv6 CIDR coverage.

**Trust-proxy behaviour change (v0.4)**

Before v0.4, Fastify was started with `trustProxy: true` (trust every peer's `X-Forwarded-For`). From v0.4, the server reads trusted-proxies from `admin_settings` at boot; when the row is absent or the feature is off, the default trusted list is loopback only (`127.0.0.1/32`, `::1/128`). Deployments behind a non-loopback reverse proxy **must** populate `trusted_proxies` explicitly or `req.ip` will report the proxy's IP rather than the real client's. See the `v0.4` CHANGELOG entry for the full behaviour-change note.

### RAG Per-page ACL Enforcement (Enterprise, v0.4+)

RAG retrieval in CE already post-filters candidate chunks by the user's readable space set (ADR-022). Enterprise deployments additionally enforce per-page view restrictions: if a Confluence page has explicit read restrictions, users outside the allowed list won't see the page's chunks in any RAG response (chat, ask, search-backed AI flows). Feature flag: `rag_permission_enforcement`.

**How it works**

1. The Confluence sync calls `/rest/api/content/{pageId}/restriction` for each page (and walks ancestors — Confluence view restrictions **are** inherited) and writes the effective read list into `access_control_entries` as `source='confluence'` rows with `synced_at=<run start>`.
2. A stale-ACE sweep at the end of the sync removes any `source='confluence'` row that wasn't refreshed this run — so restrictions removed in Confluence, or users de-listed from a restriction, propagate on the next sync.
3. The RAG hybrid retrieval (`hybridSearch`) overfetches 1.5× `topK` at the vector + FTS stages. After the RRF merge, a second post-filter calls `userCanAccessPage(userId, pageId)` for each candidate and drops blocked pages. Rank order is preserved.
4. `source='local'` (admin-created) ACEs are never touched by sync. Manual overrides survive.

**Sync cadence and leak-window behaviour**

Restriction changes in Confluence take effect on Compendiq's next successful sync of the affected page — same cadence as content changes (`SYNC_INTERVAL_MIN`, default 15 min). Within that window, RAG may return stale visibility. This is the trade-off for synchronous sync mode in v0.4; an async-backfill mode (content first, ACLs after) is a future v0.5 option that shrinks the content-sync duration at the cost of a briefly larger leak window.

**Sync duration impact**

Enabling the feature adds at least one Confluence API call per synced page (restriction fetch), plus one per unique ancestor (cached across sibling pages within a sync run). At Confluence's 60 RPM default, a 1000-page space with moderate nesting typically adds 15-25 minutes to the first sync run. Subsequent runs are much faster because the ancestor cache hits and most pages' restrictions haven't changed. For deployments with large restricted spaces, expect the first post-enable sync to take notably longer than historical runs.

**Unmapped Confluence users**

If a Confluence page's read restriction names a user who has never logged into Compendiq (no matching `users` row — most often because the OIDC login flow hasn't provisioned them yet), the sync cannot persist an ACE for that user. The event is logged as an `ACE_SYNC_SKIPPED_UNMAPPED_USER` audit entry with `{ userKey, pageId }`. Safe default: **implicit deny** — the missing user will not match any ACE, so they are denied access. Counter-intuitively this means first-time RAG access for the restricted user happens after they've logged in and the next sync has run. Admin-UI visibility of the skip counter is planned for v0.5.

**Disabling the feature**

Tier-downgrade (license change to a non-enterprise tier) disables the flag. Existing `source='confluence'` ACEs remain in the DB. `userCanAccessPage()` continues to honour them — safe over-restriction. To fully "undo" the sync, manually `DELETE FROM access_control_entries WHERE source='confluence';` after disabling.

**Verification**

- Integration regression guard: `backend/src/domains/confluence/services/sync-service.integration.test.ts` (sync path) and `backend/src/domains/llm/services/rag-service.integration.test.ts` (query path).
- ADR-023 documents the full design and rationale.

### Monitoring (OpenTelemetry)

| Variable | Default | Description |
|----------|---------|-------------|
| `OTEL_ENABLED` | `false` | Set to `true` to enable OpenTelemetry tracing |
| `OTEL_SERVICE_NAME` | `compendiq-backend` | Service name reported to the OTLP collector |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | *(none)* | OTLP collector endpoint (e.g., `http://localhost:4318`) |

### Docker Compose Only

| Variable | Default | Description |
|----------|---------|-------------|
| `HOST_CA_BUNDLE_PATH` | `/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem` | Host path to CA bundle (bind-mounted into container) |
| `CONTAINER_CA_BUNDLE_PATH` | `/etc/ssl/certs/ca-certificates.crt` | Container path for the CA bundle |

## Upgrade Procedure

### Docker Compose Upgrade

1. **Pull the latest images:**

   ```bash
   docker compose -f docker/docker-compose.yml pull
   ```

2. **Restart services:**

   ```bash
   docker compose -f docker/docker-compose.yml up -d
   ```

   Database migrations run automatically on backend startup. No manual migration steps are required.

3. **Verify the upgrade:**

   ```bash
   curl http://localhost:3051/api/health
   ```

### From Source

1. Pull the latest changes:

   ```bash
   git pull origin dev
   npm install
   npm run build
   ```

2. Restart the services. Migrations run automatically.

## Backup Strategy

### PostgreSQL

Use `pg_dump` for database backups:

```bash
# Full backup
docker compose -f docker/docker-compose.yml exec -T postgres pg_dump -U kb_user kb_creator > backup_$(date +%Y%m%d_%H%M%S).sql

# Compressed backup
docker compose -f docker/docker-compose.yml exec -T postgres pg_dump -U kb_user -Fc kb_creator > backup_$(date +%Y%m%d_%H%M%S).dump
```

Restore from backup:

```bash
# From SQL dump
docker compose -f docker/docker-compose.yml exec -T postgres psql -U kb_user kb_creator < backup.sql

# From compressed dump
docker compose -f docker/docker-compose.yml exec -T postgres pg_restore -U kb_user -d kb_creator backup.dump
```

### Redis

Redis is used as a cache layer. Data in Redis (page list caches, search result caches, LLM response caches) is transient and will be rebuilt automatically. Backing up Redis is optional.

If desired, Redis RDB snapshots can be triggered:

```bash
docker compose -f docker/docker-compose.yml exec redis redis-cli -a <redis-password> BGSAVE
```

### Attachments

If you have synced Confluence attachments, back up the attachments volume:

```bash
docker run --rm -v compendiq_attachments:/data -v $(pwd):/backup alpine tar czf /backup/attachments_backup.tar.gz -C /data .
```

### Backup Schedule Recommendation

| Component | Frequency | Retention |
|-----------|-----------|-----------|
| PostgreSQL | Daily | 30 days |
| Attachments | Weekly | 4 weeks |
| `.env` file | After every change | Keep current + previous |

## Monitoring

### Health Endpoints

Compendiq provides Kubernetes-compatible health probes:

| Endpoint | Purpose | Checks |
|----------|---------|--------|
| `GET /api/health` | Full health status | PostgreSQL + Redis + LLM connectivity, circuit breaker status |
| `GET /api/health/ready` | Readiness probe | PostgreSQL + Redis |
| `GET /api/health/live` | Liveness probe | Always returns 200 (process is alive) |
| `GET /api/health/start` | Startup probe | Startup complete + PostgreSQL + LLM availability |
| `GET /api/llm/circuit-breaker-status` | Per-provider circuit-breaker state | Returns a provider-keyed flat map: `{ [providerId]: { state, failureCount, nextRetryTime } }`. Requires auth. |

Example response from `GET /api/health`:

```json
{
  "status": "ok",
  "services": {
    "postgres": true,
    "redis": true,
    "llm": true
  },
  "circuitBreakers": {
    "providers": [
      { "providerId": "<uuid>", "name": "OpenAI Prod", "state": "closed", "failures": 0 }
    ]
  },
  "version": "1.0.0",
  "uptime": 3600.123
}
```

Status values: `ok` (all healthy), `degraded` (partial), `error` (all down).

### Docker Health Checks

The Docker Compose configuration includes built-in health checks for all services. Monitor container health with:

```bash
docker compose -f docker/docker-compose.yml ps
docker compose -f docker/docker-compose.yml logs -f backend
```

### OpenTelemetry

Enable distributed tracing by setting:

```bash
OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=http://your-collector:4318
```

This exports traces to any OTLP-compatible collector (Jaeger, Grafana Tempo, Datadog, etc.).

### Audit Logging

Compendiq logs user actions and system events. View audit logs in the Admin panel under **Admin > Audit Log**. Logs are stored in PostgreSQL and include:

- User authentication events (login, logout, failed attempts)
- Page operations (create, update, delete)
- Admin actions (role changes, settings updates)
- Sync operations

## Managing Users

Admins manage the full user lifecycle from **Settings → Users**. All mutations are audit-logged under `ADMIN_ACTION` events and rate-limited the same as other admin endpoints. Under the hood each action maps to one of the per-user admin endpoints (`POST|PUT|DELETE /api/admin/users/...`) so EE bulk tooling (#116) can compose the same primitives.

### Creating a user

1. Go to **Settings → Users** and click **Add user**.
2. Fill in username (required), optional email, optional display name, and pick the role (`user` or `admin`).
3. Choose one of two credential modes:
   - **Explicit password** — type it into the form. The user signs in with that password on first login.
   - **Send invitation** — leave the password blank and tick *Send invitation email*. The backend generates a random temporary password and tries to email it to the new user via the configured SMTP server (see `SMTP_*` env vars and the Settings → Email admin tab). When SMTP is not configured the API returns the temporary password in the response so the admin can hand it over out-of-band.
4. The new user is created immediately — there is no email-verification step in CE.

### Editing a user

From the user's row in the table:

- **Display name, email, role** can be patched via `PUT /api/admin/users/:id`. Changing an email to one that is already in use returns HTTP 409 (`EMAIL_TAKEN`).
- **Demoting the last active admin** is rejected with HTTP 409 (`LAST_ADMIN`). Promote another admin first.
- Username and password cannot be changed through this form. Password changes go through the self-service flow from the user's own profile; username is immutable once set.

### Deactivating (soft) vs deleting (hard)

**Deactivate** is the recommended off-boarding path:

- Sets `deactivated_at`, `deactivated_by`, and `deactivated_reason` on the user.
- Revokes every refresh-token in the same transaction so any open sessions cannot mint new access tokens.
- Blocks future logins at the auth layer with a generic "Account is deactivated — contact an administrator" message.
- Preserves all history (audit_log, page authorship, comments, templates) untouched.
- Is reversible via the **Reactivate** action, which clears the deactivation markers.
- Rejected with `LAST_ADMIN` if the target is the only remaining active admin, and with `SELF_FORBIDDEN` if an admin tries to deactivate themselves (promote another admin first).

**Delete** is a hard delete — use it only when you need the row gone (accidental imports, GDPR erasure, fresh-install cleanup):

- Removes the `users` row outright.
- Cascades pages/comments/embeddings/settings that are tied to the user via `ON DELETE CASCADE`.
- Nulls out historical pointers on rows that are worth keeping: `audit_log.user_id`, `error_log.user_id`, `comments.resolved_by`, `pages.created_by_user_id`, `pages.owner_id`, `pages.verified_by`, `notifications.source_user_id`, and so on. The records survive with `NULL` where the user used to be.
- Reassigns any templates the user authored to the internal `__system__` sentinel so the NOT NULL FK on `templates.created_by` stays valid.
- Is refused if the target is the only active admin (`LAST_ADMIN`) or if the admin tries to delete themselves (`SELF_FORBIDDEN`).
- Cannot be undone. There is no trash / recycle bin — back up PostgreSQL before running hard deletes in bulk.

### Resetting a password

CE does not ship a self-serve "send password reset email" button. To reset a user's password as an admin:

1. From **Settings → Users**, open the user row and click **Edit → Reset password**.
2. Pick either *Set temporary password* (displayed once, hand over out of band) or *Send invitation email* (requires SMTP configured). Behind the scenes this is the same flow as **Add user** in invitation mode — the user is expected to log in with the temporary password and then change it from their profile page.
3. All refresh-tokens for the user are revoked as part of the reset, so existing sessions are terminated.

If you need to reset a password without admin UI access (for example the last admin lost their password), set it directly in PostgreSQL with a known bcrypt hash — see **Troubleshooting → Recovering the last admin password** below.

### Self-service limits and the `__system__` user

- An admin cannot deactivate, delete, or demote themselves via the admin API — deliberate, to avoid accidentally locking the install out of admin access.
- The `__system__` user (UUID `00000000-0000-0000-0000-000000000000`) owns built-in templates. It does not count toward the "last active admin" check and cannot log in — it is an internal sentinel and must not be edited or deleted.

## Encryption Key Rotation

Compendiq supports zero-downtime rotation of the PAT encryption key:

1. **Generate a new key:**

   ```bash
   openssl rand -base64 48
   ```

2. **Add versioned keys** to `.env`:

   ```bash
   # Keep the old key as V1, add the new key as V2
   PAT_ENCRYPTION_KEY_V1=old-key-at-least-32-characters!!!!!
   PAT_ENCRYPTION_KEY_V2=new-key-at-least-32-characters!!!!!
   ```

   Alternatively, use JSON format:

   ```bash
   PAT_ENCRYPTION_KEYS='[{"version":2,"key":"new-key-..."},{"version":1,"key":"old-key-..."}]'
   ```

3. **Restart the backend.** New encryptions use the highest-version key. Decryption tries all keys, so existing PATs remain readable.

4. **Re-encrypt existing PATs** via the Admin UI (Admin > Key Rotation).

5. **Remove the old key** once all PATs have been re-encrypted.

## Troubleshooting

### Backend fails to start with "JWT_SECRET must be at least 32 characters"

In production mode (`NODE_ENV=production`), the server enforces that `JWT_SECRET` and `PAT_ENCRYPTION_KEY` are not default values and are at least 32 characters long. Generate proper secrets with `openssl rand -base64 48`.

### "Connection refused" to PostgreSQL or Redis

Ensure the infrastructure containers are running and healthy:

```bash
docker compose -f docker/docker-compose.yml ps
```

Check that the `POSTGRES_URL` and `REDIS_URL` in your `.env` match the container configuration. Inside Docker Compose, use service names (`postgres`, `redis`) instead of `localhost`.

### LLM requests fail or time out

1. Verify Ollama is running: `curl http://localhost:11434/api/tags`
2. Check the `OLLAMA_BASE_URL` in `.env`. Inside Docker, use `http://host.docker.internal:11434`.
3. If using a proxy, set `LLM_BEARER_TOKEN` and `LLM_AUTH_TYPE=bearer`.
4. For timeout issues with large articles, increase `LLM_STREAM_TIMEOUT_MS`.
5. Check circuit breaker status via `GET /api/health` (aggregated) or `GET /api/llm/circuit-breaker-status` (per-provider detail) -- if a provider shows `open`, the circuit breaker has tripped due to repeated failures. It will reset automatically.

### TLS certificate errors

For self-signed certificates on Confluence or LLM servers:

- Set `CONFLUENCE_VERIFY_SSL=false` or `LLM_VERIFY_SSL=false` to disable verification (not recommended for production).
- Or provide a CA bundle via `NODE_EXTRA_CA_CERTS=/path/to/ca-bundle.pem`.
- In Docker, mount the host CA bundle using `HOST_CA_BUNDLE_PATH` and `CONTAINER_CA_BUNDLE_PATH`.

### Embeddings are not being generated

1. Ensure the embedding model is pulled: `ollama pull bge-m3`
2. Check that `EMBEDDING_MODEL` is set correctly in `.env`.
3. The embedding model can be changed via admin settings, which triggers automatic re-embedding of all content.

### Database migrations fail

Migrations run automatically on startup. If a migration fails:

1. Check the backend logs: `docker compose -f docker/docker-compose.yml logs backend`
2. Ensure the PostgreSQL user has sufficient privileges.
3. The pgvector extension must be available (the `pgvector/pgvector:pg17` Docker image includes it).

### High memory usage

- Redis is configured with `maxmemory 256mb` and `allkeys-lru` eviction by default.
- Reduce `QUALITY_BATCH_SIZE` and `SUMMARY_BATCH_SIZE` to lower worker memory usage.
- Consider increasing Docker container memory limits for the backend if processing large articles.
