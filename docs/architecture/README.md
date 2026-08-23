# Architecture Documentation

This folder contains the living architecture diagrams for Compendiq CE.
All diagrams are written in [Mermaid](https://mermaid.js.org/) so they render
natively on GitHub and diff cleanly in PRs. Do not add binary diagram exports
(PNG/SVG) — keep the source of truth in Markdown.

## Index

| # | Diagram | File | View |
|---|---------|------|------|
| 1 | System Context (C4 L1) | [`01-system-context.md`](./01-system-context.md) | Users + external systems talking to Compendiq |
| 2 | Container Diagram (C4 L2) | [`02-container.md`](./02-container.md) | Deployable units (frontend, backend, Postgres, Redis, mcp-docs, searxng) |
| 3 | Backend Domains (C4 L3) | [`03-backend-domains.md`](./03-backend-domains.md) | Components per domain + ESLint boundary rules |
| 4 | Frontend Structure | [`04-frontend-structure.md`](./04-frontend-structure.md) | Feature folders, providers, enterprise gating |
| 5 | Docker Deployment | [`05-deployment.md`](./05-deployment.md) | Compose services, networks, ports, volumes |
| 6 | Data Model (ERD) | [`06-data-model.md`](./06-data-model.md) | Key PostgreSQL tables and relationships |
| 7 | Auth & Login Flow | [`07-flow-auth.md`](./07-flow-auth.md) | Local JWT flow + OIDC (EE) |
| 8 | Confluence Sync Flow | [`08-flow-sync.md`](./08-flow-sync.md) | Scheduler → fetch → convert → persist → embed |
| 9 | RAG Chat Flow | [`09-flow-rag-chat.md`](./09-flow-rag-chat.md) | Ask pipeline: retrieve → prompt → stream |
| 10 | Enterprise License Flow | [`10-flow-enterprise-license.md`](./10-flow-enterprise-license.md) | Open-core plugin loading + license persistence |
| 11 | Content Format Pipeline | [`11-content-pipeline.md`](./11-content-pipeline.md) | Confluence XHTML ↔ HTML ↔ Markdown ↔ Editor |

## Runbooks

Operational procedures live in [`../runbooks/`](../runbooks/) and are the place
a diagram points when "what do I DO about it" is the question.

| Runbook | Covers |
|---|---|
| [`image-index.md`](../runbooks/image-index.md) | Serving, assigning and probing the `image_embedding` leg; what fills the index, how retrieval reads it, what the model is shown, and what changing the model costs (#1115) |
| [`vl-embedding-dev.md`](../runbooks/vl-embedding-dev.md) | Running the local VL embedding shim (`mlx` / `llama` backends) so the image index and the eval have an endpoint on a laptop (#1115) |
| [`retrieval-eval.md`](../runbooks/retrieval-eval.md) | The #1102 retrieval harness: corpora, fixtures, the FTS-language axis, the `--images` axis, and how to read a verdict |
| [`shadow-reembed.md`](../runbooks/shadow-reembed.md) | Zero-downtime TEXT embedding model change — lifecycle, go/no-go, revert (#1116) |

## Maintenance

**These diagrams are part of the source of truth. When you change the
architecture in code, you must update the affected diagrams in the same PR.**

Quick reference for what to update when:

| You changed… | Update |
|--------------|--------|
| `docker/docker-compose*.yml`, Dockerfiles, service ports/volumes | `02-container.md`, `05-deployment.md` |
| A new external integration (LLM provider, identity provider, etc.) | `01-system-context.md` |
| A new backend domain, service in `backend/src/domains/*`, or route group | `03-backend-domains.md` |
| `backend/eslint.config.js` `boundaries` rules | `03-backend-domains.md` |
| A new top-level `frontend/src/features/*` folder or provider | `04-frontend-structure.md` |
| A new **route** inside an existing `frontend/src/features/*` folder, or a provider's data model changing | `04-frontend-structure.md` |
| A migration that adds/drops/renames a core table or FK | `06-data-model.md` |
| Auth routes, JWT/refresh logic, or OIDC wiring | `07-flow-auth.md` |
| `sync-service.ts`, sync scheduler, attachment handler | `08-flow-sync.md` |
| `core/services/attachment-store.ts` (the shared attachment reader) or which store/ACL a caller reaches it through | `03-backend-domains.md` |
| `rag-service.ts`, `multi-query-search.ts`, `llm-ask.ts`, `routes/knowledge/search.ts`, prompt-building, caching | `09-flow-rag-chat.md` |
| `vl-embedding-client.ts`, `image-embedding-probe.ts`, `image-embedding-index.ts`, or the `image_embedding` assignment/probe routes | `03-backend-domains.md`, `06-data-model.md`, `09-flow-rag-chat.md` |
| `image-embedding-service.ts`, `image-embedding-dirty.ts`, the `image_embedding_dirty` writers, or the image-index admin routes | `03-backend-domains.md`, `06-data-model.md`, `08-flow-sync.md` |
| `image-leg-search.ts`, the third RRF leg's fusion in `rag-service.ts`, or the `kind: 'image'` source shape | `03-backend-domains.md`, `04-frontend-structure.md`, `09-flow-rag-chat.md` |
| `retrieved-images.ts`, the vision gate on the answer path, or `rag_answer_max_images` | `03-backend-domains.md`, `04-frontend-structure.md`, `09-flow-rag-chat.md` |
| The image-axis eval (`domains/llm/eval/images-*.ts`, `seed-images.ts`, `runner-images.ts`, `corpus-de-images/`) | `03-backend-domains.md` + `docs/runbooks/retrieval-eval.md` |
| `core/db/vector-column-tier.ts` (the pgvector index tiers) or `core/db/with-lock-retry.ts` | `03-backend-domains.md`, `06-data-model.md` |
| Enterprise loader, license route, license persistence | `10-flow-enterprise-license.md` |
| `content-converter.ts`, `document-extractor.ts`, `pages-import.ts`, XHTML/HTML/Markdown conversion, uploaded-file extraction, import size limits | `11-content-pipeline.md` |
| `image-references.ts` (the `<img src>` enumerator or `buildPageImageUrl`), or anything that changes how an attachment URL is spelled into `body_html` | `11-content-pipeline.md`, `03-backend-domains.md`, `06-data-model.md` |

If a change spans multiple areas, update every affected diagram. If a diagram
becomes stale and you are not sure how to update it, flag it in the PR
description rather than silently leaving it wrong.

## Rendering locally

GitHub renders Mermaid automatically. For local preview, use any Markdown
viewer with Mermaid support (VS Code: *Markdown Preview Mermaid Support*
extension).
