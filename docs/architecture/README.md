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
| A migration that adds/drops/renames a core table or FK | `06-data-model.md` |
| Auth routes, JWT/refresh logic, or OIDC wiring | `07-flow-auth.md` |
| `sync-service.ts`, sync scheduler, attachment handler | `08-flow-sync.md` |
| `rag-service.ts`, `llm-ask.ts`, prompt-building, caching | `09-flow-rag-chat.md` |
| Enterprise loader, license route, license persistence | `10-flow-enterprise-license.md` |
| `content-converter.ts`, XHTML/HTML/Markdown conversion | `11-content-pipeline.md` |

If a change spans multiple areas, update every affected diagram. If a diagram
becomes stale and you are not sure how to update it, flag it in the PR
description rather than silently leaving it wrong.

## Rendering locally

GitHub renders Mermaid automatically. For local preview, use any Markdown
viewer with Mermaid support (VS Code: *Markdown Preview Mermaid Support*
extension).
