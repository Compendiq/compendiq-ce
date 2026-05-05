# 5. Docker Deployment

Physical layout derived from `docker/docker-compose.yml`. The compose file
defines three networks to keep internal services (`postgres`, `redis`) off
the public bridge.

## Compose topology

```mermaid
flowchart LR
    host(["Host / reverse proxy"])

    subgraph fe_net["frontend-net"]
        fe["<b>frontend</b><br/>:8081<br/>image: compendiq-ce-frontend"]
    end

    subgraph be_net["backend-net"]
        be["<b>backend</b><br/>:3051<br/>image: compendiq-ce-backend<br/>volume: attachments → /app/data"]
        mcp["<b>mcp-docs</b><br/>:3100<br/>image: compendiq-ce-mcp-docs"]
        searx["<b>searxng</b><br/>:8080<br/>image: compendiq-ce-searxng"]
    end

    subgraph data_net["data-net (internal: true)"]
        pg[("<b>postgres</b><br/>:5432<br/>image: pgvector/pgvector:pg17<br/>volume: postgres-data")]
        rd[("<b>redis</b><br/>:6379<br/>image: redis:8-alpine")]
    end

    host -- "FRONTEND_PORT → 8081" --> fe
    host -- "BACKEND_HOST_PORT → 3051" --> be
    fe -- "HTTP" --> be
    be -- "HTTP" --> mcp
    mcp -- "HTTP" --> searx
    be -- "SQL" --> pg
    be -- "RESP" --> rd
    mcp -- "RESP" --> rd

    classDef ext fill:#fff,stroke:#333
    classDef net fill:#fafafa,stroke:#bbb,stroke-dasharray: 4 4
    classDef svc fill:#eefbe8,stroke:#4caf50
    classDef data fill:#eef6ff,stroke:#4a90e2
    classDef side fill:#fff4e5,stroke:#e5a23c
    class host ext
    class fe,be svc
    class mcp,searx side
    class pg,rd data
```

## Network rules

| Network       | internal | Members                         | Purpose |
|---------------|----------|---------------------------------|---------|
| `frontend-net`| no       | frontend, backend               | Browser → frontend, SPA → backend API |
| `backend-net` | no       | backend, mcp-docs, searxng      | Backend sidecar services |
| `data-net`    | **yes**  | postgres, redis (+ backend)     | No external exposure; DB/cache only reachable from backend |

`postgres` and `redis` **must not** publish host ports in production.
Development overrides (`docker/docker-compose.*.yml`) may expose them for
debugging — never merge that into production.

## Volumes

| Volume          | Mount                                  | Contents |
|-----------------|----------------------------------------|----------|
| `postgres-data` | `/var/lib/postgresql/data` (postgres)  | Primary data + embeddings |
| `attachments`   | `/app/data` (backend)                  | Cached Confluence attachments (images, drawio, PDFs) — also configurable via `ATTACHMENTS_DIR` |

## Additional compose files

- `docker-compose.confluence.yml` — spins up a throwaway Confluence DC for
  local integration testing.
- `docker-compose.test.yml` — CI services (Postgres on `:5433`, Redis
  ephemeral) used by `backend` tests and Playwright E2E.

## Enterprise image

`docker/Dockerfile.enterprise` is a multi-stage template that overlays the
`@compendiq/enterprise` package onto the backend image. It does **not**
modify the frontend image — the frontend is identical in CE and EE
deployments and gates Enterprise UI at runtime (see
[`04-frontend-structure.md`](./04-frontend-structure.md)).

## Multi-replica `backend` (v0.4+)

From v0.4 onward the `backend` service is safe to run with N≥2 replicas
behind a load balancer. The state-sharing primitives that make this work
are documented in [ADR-024](../ARCHITECTURE-DECISIONS.md#adr-024-multi-instance-readiness-horizontally-scaled-backend);
this section is the operator view.

```mermaid
flowchart LR
    lb["<b>Load balancer</b><br/>(operator-supplied)<br/>e.g. nginx, Traefik, ALB"]

    subgraph backend_replicas["backend service (scale N)"]
        be1["<b>backend-1</b><br/>:3051"]
        be2["<b>backend-2</b><br/>:3051"]
        beN["<b>backend-N</b><br/>:3051"]
    end

    subgraph data_net["data-net (internal)"]
        pg[("<b>postgres</b><br/>:5432")]
        rd[("<b>redis</b><br/>:6379<br/>pub/sub + BullMQ")]
    end

    lb --> be1
    lb --> be2
    lb --> beN

    be1 --> pg
    be2 --> pg
    beN --> pg
    be1 --> rd
    be2 --> rd
    beN --> rd

    classDef ext fill:#fff,stroke:#333
    classDef svc fill:#eefbe8,stroke:#4caf50
    classDef data fill:#eef6ff,stroke:#4a90e2
    class lb ext
    class be1,be2,beN svc
    class pg,rd data
```

### What's shared via Redis

| Concern | Mechanism | Channel / Key |
|---|---|---|
| Provider config invalidation | Pub/sub (advisory-only payloads) | `provider:cache:bump`, `provider:deleted` |
| LLM admin settings (concurrency, queue depth) | Pub/sub + cached getters | `admin:llm:settings` |
| IP allowlist hot-reload | Pub/sub | `ip_allowlist:changed` |
| Confluence SSRF allowlist | Dedicated `ssrf-allowlist-bus` | `confluence:allowlist:changed` |
| Sync conflict / PII / license / per-page-restriction policy | Pub/sub | `sync:conflict:policy:changed`, `pii:policy:changed`, `license:changed` |
| Recurring jobs (sync tick, retention prune, embedding tick, webhook outbox poll) | BullMQ `upsertJobScheduler` with stable IDs | Redis queue keys |
| Sync worker leadership | Redis SET-NX lock | `sync:worker:lock` |
| Embedding locks | Redis SET-NX | `embedding:lock:{model}:{textHash}` |

### Operator requirements

1. **`trustProxy` MUST be set to your LB's CIDR or a hop count — never `true`.**
   `trustProxy: true` lets any client forge `X-Forwarded-For`, breaking
   IP-allowlist enforcement and audit-log accuracy. The default
   loopback-only configuration is safe for single-replica dev; adjust for
   your LB topology before scaling.

2. **`stop_grace_period: 60s` on the `backend` service** so SIGTERM has
   time to drain HTTP handlers + finish active BullMQ jobs before
   SIGKILL. Set in `docker/docker-compose.ee.yml` for EE; CE operators
   running multi-replica should set it on their compose. See ADR-024 →
   Graceful-shutdown order.

3. **Redis must be reachable from every replica** with low latency
   (single-digit ms LAN). Pub/sub is advisory at-most-once — the
   `redis-cache-bus` `onReconnect` hook cold-reloads cached settings
   after any disconnect, so a brief Redis blip costs a fan of
   uncached reads, not desync.

4. **Postgres connection sizing.** Each replica opens its own pool;
   default size × replicas should stay below `max_connections` at the
   Postgres side. Tune `PG_POOL_MAX` if scaling past 4 replicas.

5. **Health probes.** Use `GET /api/health` for the LB readiness probe
   (public, no auth). Use `GET /api/internal/health?token=<t>` for an
   external mgmt poller — token-gated, returns richer diagnostics
   (version, edition, dirty pages, last-sync timestamp, error rate).
   The token lives in `admin_settings.health_api_token`; rotate via
   `POST /api/admin/health-api/rotate` (admin-only).

### Compose example (2 replicas)

```yaml
# docker/docker-compose.ee.yml — excerpt
services:
  backend:
    image: ghcr.io/compendiq/compendiq-ee-backend:dev
    deploy:
      replicas: 2          # docker compose up --scale backend=2
    stop_grace_period: 60s # SIGTERM → drain → SIGKILL
    environment:
      TRUST_PROXY_CIDR: "10.0.0.0/8"   # your LB subnet
      # … shared envs (POSTGRES_URL, REDIS_URL, JWT_SECRET, PAT_ENCRYPTION_KEY)
```

The same compose works for CE — drop the `ee-backend` image for
`compendiq-ce-backend` and remove EE-only environment variables.

### Out of scope (v0.4)

- Dedicated worker container (deferred to v0.5; current model has every
  replica run both HTTP and BullMQ workers).
- Active-active across regions (Redis pub/sub is single-cluster).
- Auto-scaling on queue depth (BullMQ exposes the metrics; orchestration
  is operator-defined).

