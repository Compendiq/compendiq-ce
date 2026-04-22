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
