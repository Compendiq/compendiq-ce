# 2. Container Diagram (C4 Level 2)

Zooms into Compendiq and shows each deployable unit (a "container" in C4
terms — not strictly a Docker container, though in this project they map
1-to-1). For the infra view with networks and ports see
[`05-deployment.md`](./05-deployment.md).

```mermaid
flowchart TB
    user(["Browser<br/>(user / admin)"])
    confluence[("Confluence DC 9.2")]
    ollama[("Ollama")]
    openai[("OpenAI-compatible<br/>LLM API")]

    subgraph compendiq["Compendiq"]
        direction TB
        fe["<b>frontend</b><br/>React 19 + Vite SPA<br/>TailwindCSS 4, Radix, Zustand,<br/>TanStack Query, TipTap v3"]
        be["<b>backend</b><br/>Fastify 5 + TypeScript<br/>JWT auth, REST + SSE"]

        subgraph workers["Background workers (in-process)"]
            direction LR
            wsync["Sync scheduler"]
            wemb["Embedding worker"]
            wqual["Quality worker"]
            wsum["Summary worker"]
        end

        pg[("<b>postgres</b><br/>PostgreSQL 17 + pgvector<br/>(HNSW, 1024-dim embeddings)")]
        redis[("<b>redis</b><br/>Redis 8<br/>cache, queue, locks, rate limit")]

        mcp["<b>mcp-docs</b><br/>Documentation sidecar<br/>(MCP server)"]
        searx["<b>searxng</b><br/>Meta web-search engine"]
    end

    user -- "HTTPS" --> fe
    fe  -- "REST + SSE<br/>/api/*" --> be

    be --> workers
    be -- "SQL (pg pool)" --> pg
    be -- "RESP" --> redis
    be -- "HTTP" --> mcp
    mcp -- "HTTP" --> searx

    be -. "XHTML pages,<br/>attachments" .-> confluence
    be -. "chat, embeddings" .-> ollama
    be -. "chat (optional)" .-> openai

    classDef ext fill:#f5f5f5,stroke:#999,stroke-dasharray: 4 4,color:#333
    classDef data fill:#eef6ff,stroke:#4a90e2,color:#123
    classDef app fill:#eefbe8,stroke:#4caf50,color:#123
    classDef side fill:#fff4e5,stroke:#e5a23c,color:#222
    class confluence,ollama,openai ext
    class pg,redis data
    class fe,be app
    class mcp,searx,workers side
```

## Containers at a glance

| Container | Tech | Port (internal) | Image |
|-----------|------|-----------------|-------|
| frontend  | React 19 SPA, Vite, Nginx-served | 8081 | `ghcr.io/compendiq/compendiq-ce-frontend` |
| backend   | Node.js 22, Fastify 5 | 3051 | `ghcr.io/compendiq/compendiq-ce-backend` |
| postgres  | `pgvector/pgvector:pg17` | 5432 | upstream |
| redis     | `redis:8-alpine` | 6379 | upstream |
| mcp-docs  | MCP server (Node) | 3100 | `ghcr.io/compendiq/compendiq-ce-mcp-docs` |
| searxng   | Python meta search | 8080 | `ghcr.io/compendiq/compendiq-ce-searxng` |

## Background workers

Workers run **inside the backend process** — there is no separate worker
container. They are started from `backend/src/index.ts` via
`startQueueWorkers()` (BullMQ) and fall back to interval-based polling when
`USE_BULLMQ=false`.

- **Sync scheduler** — polls `user_settings`, respects `SYNC_INTERVAL_MIN`,
  guarded by a Redis lock (`sync:worker:lock`).
- **Embedding worker** — consumes dirty pages (`pages.embedding_dirty=true`).
- **Quality worker** — rates page clarity/completeness.
- **Summary worker** — auto-summarizes pages.

## Shared contracts

`packages/contracts` (published as `@compendiq/contracts`) is imported by
both frontend and backend and defines Zod schemas / TypeScript types for API
boundaries. It is a build-time dependency, not a runtime container.

## Enterprise plugin

When `@compendiq/enterprise` is installed, the backend loads it dynamically
at boot (`core/enterprise/loader.ts`). The frontend image is **identical**
in CE and EE deployments; enterprise UI is gated at runtime by the
`/api/admin/license` response. See
[`10-flow-enterprise-license.md`](./10-flow-enterprise-license.md).
