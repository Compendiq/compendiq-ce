# Modularization Action Plan

> **Strategy**: Directory-based domain separation + ESLint boundaries + route splitting
> **Estimated scope**: ~120 import rewrites, 0 new package.json files, 1 day
> **Scaling ceiling**: Comfortable to ~50 users / ~80 services / 3-4 developers
> **Evolution path**: Upgrade to npm workspace packages when scaling triggers hit (see Section 8)

## Table of Contents

1. [Target Architecture](#1-target-architecture)
2. [Domain Inventory](#2-domain-inventory)
3. [Dependency Rules](#3-dependency-rules)
4. [Route Splitting](#4-route-splitting)
5. [Step-by-Step Execution](#5-step-by-step-execution)
6. [Frontend Restructuring](#6-frontend-restructuring)
7. [ESLint Boundary Rules](#7-eslint-boundary-rules)
8. [When to Upgrade to Full Packages](#8-when-to-upgrade-to-full-packages)
9. [Migration Checklist](#9-migration-checklist)
10. [Future: Full Package Architecture (Phase 2)](#10-future-full-package-architecture-phase-2)

---

## 1. Target Architecture

```
backend/src/
├── core/                       # Shared infrastructure (DB, auth, redis, utils)
│   ├── db/
│   │   ├── postgres.ts
│   │   └── migrations/         # 001-024.sql
│   ├── plugins/
│   │   ├── auth.ts
│   │   ├── correlation-id.ts
│   │   └── redis.ts
│   ├── services/
│   │   ├── audit-service.ts
│   │   ├── circuit-breaker.ts
│   │   ├── content-converter.ts
│   │   ├── error-tracker.ts
│   │   └── redis-cache.ts
│   ├── utils/
│   │   ├── logger.ts
│   │   ├── crypto.ts
│   │   ├── ssrf-guard.ts
│   │   ├── sanitize-llm-input.ts
│   │   ├── tls-config.ts
│   │   └── llm-config.ts
│   └── index.ts                # Barrel export
│
├── domains/
│   ├── confluence/             # Confluence integration
│   │   ├── services/
│   │   │   ├── confluence-client.ts
│   │   │   ├── confluence-client-streaming.ts
│   │   │   ├── attachment-handler.ts
│   │   │   ├── sync-service.ts
│   │   │   ├── sync-embedding.ts
│   │   │   ├── sync-overview-service.ts
│   │   │   ├── image-references.ts
│   │   │   └── subpage-context.ts
│   │   └── index.ts            # Barrel export
│   │
│   ├── llm/                    # LLM providers, embeddings, RAG
│   │   ├── services/
│   │   │   ├── llm-provider.ts
│   │   │   ├── ollama-service.ts
│   │   │   ├── ollama-provider.ts
│   │   │   ├── openai-service.ts
│   │   │   ├── llm-cache.ts
│   │   │   ├── embedding-service.ts
│   │   │   └── rag-service.ts
│   │   └── index.ts            # Barrel export
│   │
│   └── knowledge/              # Knowledge management features
│       ├── services/
│       │   ├── auto-tagger.ts
│       │   ├── quality-worker.ts
│       │   ├── summary-worker.ts
│       │   ├── version-tracker.ts
│       │   └── duplicate-detector.ts
│       └── index.ts            # Barrel export
│
├── routes/
│   ├── confluence/             # Confluence routes
│   │   ├── spaces.ts
│   │   ├── sync.ts
│   │   └── attachments.ts
│   ├── llm/                    # LLM routes (split from monolith llm.ts)
│   │   ├── llm-chat.ts        # /api/llm/ask, improve, generate, summarize
│   │   ├── llm-conversations.ts # /api/llm/conversations/*
│   │   ├── llm-embeddings.ts  # /api/llm/embeddings/*, re-embed
│   │   ├── llm-models.ts      # /api/llm/models, status
│   │   ├── llm-admin.ts       # /api/llm/admin/* (provider settings)
│   │   └── ollama-status.ts   # /api/llm/health
│   ├── knowledge/              # Knowledge routes (split from monolith pages.ts)
│   │   ├── pages-crud.ts      # /api/pages list, get, create, update, delete, bulk
│   │   ├── pages-versions.ts  # /api/pages/:id/versions, diff
│   │   ├── pages-tags.ts      # /api/pages/:id/auto-tag
│   │   ├── pages-embeddings.ts # /api/pages/:id/embed, relationships
│   │   ├── pages-duplicates.ts # /api/pages/:id/duplicates
│   │   ├── page-labels.ts
│   │   ├── pinned-pages.ts
│   │   └── analytics.ts
│   └── foundation/             # Cross-cutting routes
│       ├── auth.ts
│       ├── health.ts
│       ├── settings.ts
│       └── admin.ts
│
├── app.ts                      # Fastify app builder (registers all routes)
├── index.ts                    # Entry point (server start + worker lifecycle)
└── telemetry.ts
```

### Before vs After

| Aspect | Before | After |
|--------|--------|-------|
| Services | Flat `services/` (45 files) | `core/services/` + `domains/{name}/services/` |
| Routes | Flat `routes/` (12 files) | `routes/{domain}/` (20+ smaller files) |
| `pages.ts` | 1 file, 54KB, 9 service deps | 5 focused files |
| `llm.ts` | 1 file, 1100+ lines, 13 service deps | 6 focused files |
| Import discipline | Honor system | ESLint boundaries enforced |
| Package count | 3 (backend, frontend, contracts) | 3 (unchanged) |
| Build config | Unchanged | Unchanged |
| Docker | Unchanged | Unchanged |
| Dev workflow | Unchanged | Unchanged |

---

## 2. Domain Inventory

### `core/` — Shared Infrastructure

Everything that 3+ domains depend on. Direct imports allowed from anywhere.

| File | Used By |
|------|---------|
| `db/postgres.ts` | All domains, all routes |
| `plugins/auth.ts` | All protected routes |
| `plugins/redis.ts` | Confluence, LLM routes |
| `services/audit-service.ts` | Auth, settings, pages, sync, admin routes |
| `services/circuit-breaker.ts` | LLM providers, embedding, health route |
| `services/content-converter.ts` | Confluence sync, LLM RAG, knowledge workers, pages + llm routes |
| `services/error-tracker.ts` | Admin route |
| `services/redis-cache.ts` | Confluence, LLM, knowledge routes |
| `utils/logger.ts` | Everything |
| `utils/crypto.ts` | Settings, sync-service, admin |
| `utils/sanitize-llm-input.ts` | Auto-tagger, quality-worker, version-tracker, LLM routes |

### `domains/confluence/` — Confluence Integration

Client, sync, attachments. Depends on: `core/`.

| File | Imports From |
|------|-------------|
| `confluence-client.ts` | core (ssrf-guard, tls-config, logger) |
| `attachment-handler.ts` | core (logger), confluence-client |
| `sync-service.ts` | core (content-converter, logger, crypto, query), confluence-client, attachment-handler |
| `sync-embedding.ts` | core (query, logger), **llm** (embedding-service) |
| `sync-overview-service.ts` | attachment-handler, image-references, sync-service |
| `subpage-context.ts` | core (content-converter, query) |

**Cross-domain dependency**: `sync-embedding.ts` → `llm/embedding-service`. This is the one allowed exception (see Section 3).

### `domains/llm/` — LLM & Embeddings

Providers, embeddings, RAG. Depends on: `core/`.

| File | Imports From |
|------|-------------|
| `llm-provider.ts` | openai-service (dynamic import) |
| `ollama-provider.ts` | core (circuit-breaker) |
| `openai-service.ts` | core (circuit-breaker) |
| `ollama-service.ts` | ollama-provider, openai-service, llm-provider |
| `embedding-service.ts` | core (content-converter, redis-cache, circuit-breaker, query) |
| `rag-service.ts` | llm-provider, core (query) |
| `llm-cache.ts` | core (redis-cache) |

No cross-domain dependencies. Clean.

### `domains/knowledge/` — Knowledge Features

Auto-tagging, quality, versions, summaries, duplicates. Depends on: `core/`, `llm/`, `confluence/`.

| File | Imports From |
|------|-------------|
| `auto-tagger.ts` | core (content-converter, sanitize-llm-input, query), **llm** (providerChat), **confluence** (getClientForUser) |
| `quality-worker.ts` | core (content-converter, sanitize-llm-input, query), **llm** (ollama-service) |
| `summary-worker.ts` | **llm** (ollama-service), core (query) |
| `version-tracker.ts` | core (content-converter, query), **llm** (ollama-service) |
| `duplicate-detector.ts` | core (query) |

Knowledge is the "highest" domain — depends on both llm and confluence.

---

## 3. Dependency Rules

```
            ┌─────────────┐
            │    core/     │  ← Everyone can import from core
            └──────┬───────┘
         ┌─────────┼──────────┐
         ▼         ▼          ▼
   confluence/    llm/    (foundation routes)
         │         │
         │    ┌────┘
         ▼    ▼
      knowledge/              ← Highest domain, depends on llm + confluence
```

**Rules** (enforced by ESLint):

| From | Can Import | Cannot Import |
|------|-----------|---------------|
| `core/` | npm packages, `@atlasmind/contracts` | Any domain |
| `domains/confluence/` | `core/` | `llm/`, `knowledge/` |
| `domains/llm/` | `core/` | `confluence/`, `knowledge/` |
| `domains/knowledge/` | `core/`, `llm/`, `confluence/` | — |
| `routes/foundation/` | `core/` | — |
| `routes/confluence/` | `core/`, `domains/confluence/` | `llm/`, `knowledge/` |
| `routes/llm/` | `core/`, `domains/llm/` | `confluence/`, `knowledge/` |
| `routes/knowledge/` | `core/`, `domains/knowledge/`, `domains/llm/`, `domains/confluence/` | — |

**One exception**: `confluence/sync-embedding.ts` imports from `llm/embedding-service`. This is pragmatic — sync triggers embedding. Rather than over-engineering DI for one call, allow it and document it. If this grows to 3+ cross-references, it's a signal to extract a shared service to `core/`.

---

## 4. Route Splitting

### Split `routes/llm.ts` (currently ~1100 lines) into:

| New File | Endpoints | Deps |
|----------|-----------|------|
| `llm-chat.ts` | POST /api/llm/ask, /improve, /generate, /summarize | ollama-service, llm-provider, rag-service, llm-cache, content-converter |
| `llm-conversations.ts` | GET/POST/DELETE /api/llm/conversations/* | query, auth |
| `llm-embeddings.ts` | GET/POST /api/llm/embeddings/*, /re-embed, /reset-failed | embedding-service |
| `llm-models.ts` | GET /api/llm/models, /status | ollama-service |
| `llm-admin.ts` | GET/PUT /api/llm/admin/*, /custom-prompts | query, ollama-service |
| `ollama-status.ts` | GET /api/llm/health | ollama-service, circuit-breaker |

### Split `routes/pages.ts` (currently ~54KB) into:

| New File | Endpoints | Deps |
|----------|-----------|------|
| `pages-crud.ts` | GET/POST/PUT/DELETE /api/pages/*, bulk ops | sync-service, content-converter, redis-cache, audit-service |
| `pages-versions.ts` | GET /api/pages/:id/versions, /diff | version-tracker |
| `pages-tags.ts` | POST /api/pages/:id/auto-tag, /auto-tag-all | auto-tagger |
| `pages-embeddings.ts` | POST /api/pages/:id/embed, /compute-relationships | embedding-service |
| `pages-duplicates.ts` | GET /api/pages/:id/duplicates, /scan-duplicates | duplicate-detector |

### Route registration in `app.ts`

```typescript
// Foundation
await app.register(import('./routes/foundation/auth.js'));
await app.register(import('./routes/foundation/health.js'));
await app.register(import('./routes/foundation/settings.js'));
await app.register(import('./routes/foundation/admin.js'));

// Confluence
await app.register(import('./routes/confluence/spaces.js'));
await app.register(import('./routes/confluence/sync.js'));
await app.register(import('./routes/confluence/attachments.js'));

// LLM
await app.register(import('./routes/llm/llm-chat.js'));
await app.register(import('./routes/llm/llm-conversations.js'));
await app.register(import('./routes/llm/llm-embeddings.js'));
await app.register(import('./routes/llm/llm-models.js'));
await app.register(import('./routes/llm/llm-admin.js'));
await app.register(import('./routes/llm/ollama-status.js'));

// Knowledge
await app.register(import('./routes/knowledge/pages-crud.js'));
await app.register(import('./routes/knowledge/pages-versions.js'));
await app.register(import('./routes/knowledge/pages-tags.js'));
await app.register(import('./routes/knowledge/pages-embeddings.js'));
await app.register(import('./routes/knowledge/pages-duplicates.js'));
await app.register(import('./routes/knowledge/page-labels.js'));
await app.register(import('./routes/knowledge/pinned-pages.js'));
await app.register(import('./routes/knowledge/analytics.js'));
```

---

## 5. Step-by-Step Execution

### Pre-flight
- [ ] All tests passing on `dev`
- [ ] Clean git status
- [ ] Create branch: `feature/modularize-backend`
- [ ] Fix duplicate migration numbers (015, 017, 018) — renumber to sequential

### Phase 1: Create directory structure (commit)
```bash
mkdir -p backend/src/core/{db,plugins,services,utils}
mkdir -p backend/src/domains/{confluence,llm,knowledge}/services
mkdir -p backend/src/routes/{confluence,llm,knowledge,foundation}
```

### Phase 2: Move core files (commit)

Move files to `core/` — update relative imports within moved files only.

| From | To |
|------|-----|
| `db/` | `core/db/` |
| `plugins/auth.ts` | `core/plugins/auth.ts` |
| `plugins/correlation-id.ts` | `core/plugins/correlation-id.ts` |
| `plugins/redis.ts` | `core/plugins/redis.ts` |
| `utils/*.ts` | `core/utils/*.ts` |
| `services/audit-service.ts` | `core/services/audit-service.ts` |
| `services/circuit-breaker.ts` | `core/services/circuit-breaker.ts` |
| `services/content-converter.ts` | `core/services/content-converter.ts` |
| `services/error-tracker.ts` | `core/services/error-tracker.ts` |
| `services/redis-cache.ts` | `core/services/redis-cache.ts` |

Create `core/index.ts` barrel export. Update all consumers to import from `../core/index.js` or `../core/services/...`.

**Test**: `npm run typecheck -w backend`

### Phase 3: Move domain services (commit)

Move services into domain directories. Update internal imports.

**Confluence domain**:
- `services/confluence-client.ts` → `domains/confluence/services/`
- `services/confluence-client-streaming.ts` → `domains/confluence/services/`
- `services/attachment-handler.ts` → `domains/confluence/services/`
- `services/sync-service.ts` → `domains/confluence/services/`
- `services/sync-embedding.ts` → `domains/confluence/services/`
- `services/sync-overview-service.ts` → `domains/confluence/services/`
- `services/image-references.ts` → `domains/confluence/services/`
- `services/subpage-context.ts` → `domains/confluence/services/`

**LLM domain**:
- `services/llm-provider.ts` → `domains/llm/services/`
- `services/ollama-service.ts` → `domains/llm/services/`
- `services/ollama-provider.ts` → `domains/llm/services/`
- `services/openai-service.ts` → `domains/llm/services/`
- `services/llm-cache.ts` → `domains/llm/services/`
- `services/embedding-service.ts` → `domains/llm/services/`
- `services/rag-service.ts` → `domains/llm/services/`

**Knowledge domain**:
- `services/auto-tagger.ts` → `domains/knowledge/services/`
- `services/quality-worker.ts` → `domains/knowledge/services/`
- `services/summary-worker.ts` → `domains/knowledge/services/`
- `services/version-tracker.ts` → `domains/knowledge/services/`
- `services/duplicate-detector.ts` → `domains/knowledge/services/`

Create barrel exports (`domains/{name}/index.ts`) for each domain.

**Test**: `npm run typecheck -w backend`

### Phase 4: Move and split routes (commit)

**Move simple routes** (no splitting needed):
- `routes/auth.ts` → `routes/foundation/auth.ts`
- `routes/health.ts` → `routes/foundation/health.ts`
- `routes/settings.ts` → `routes/foundation/settings.ts`
- `routes/admin.ts` → `routes/foundation/admin.ts`
- `routes/spaces.ts` → `routes/confluence/spaces.ts`
- `routes/sync.ts` → `routes/confluence/sync.ts`
- `routes/attachments.ts` → `routes/confluence/attachments.ts`
- `routes/page-labels.ts` → `routes/knowledge/page-labels.ts`
- `routes/pinned-pages.ts` → `routes/knowledge/pinned-pages.ts`
- `routes/page-filters.ts` → `routes/knowledge/page-filters.ts`
- `routes/analytics.ts` → `routes/knowledge/analytics.ts`
- `routes/ollama-status.ts` → `routes/llm/ollama-status.ts`

**Split `routes/llm.ts`** into 5 files in `routes/llm/`
**Split `routes/pages.ts`** into 5 files in `routes/knowledge/`

Update `app.ts` route registration to use new paths.

**Test**: `npm run typecheck -w backend` then `npm test -w backend`

### Phase 5: Update test imports (commit)

Update all `*.test.ts` import paths to match new locations. Move test files alongside their source if co-located, or update relative paths if in separate test directories.

Move `services/__fixtures__/` to appropriate domain.

**Test**: `npm test -w backend` (full suite)

### Phase 6: ESLint boundaries (commit)

Configure `eslint-plugin-boundaries` (already installed) to enforce the rules in Section 3.

**Test**: `npm run lint -w backend`

### Phase 7: Frontend component categories (commit)

Restructure `frontend/src/shared/components/` into subdirectories (see Section 6).

**Test**: `npm test -w frontend`

### Phase 8: Final verification (commit)

- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `npm run dev` — manual smoke test
- [ ] Docker build (if applicable)

---

## 6. Frontend Restructuring

Categorize `frontend/src/shared/components/` (35+ flat files) into:

```
shared/components/
├── layout/                     # App structure
│   ├── AppLayout.tsx
│   ├── Breadcrumb.tsx
│   ├── SidebarTreeView.tsx
│   ├── UserMenu.tsx
│   ├── PageTransition.tsx
│   └── CommandPalette.tsx
│
├── article/                    # Article display & editing
│   ├── ArticleViewer.tsx
│   ├── ArticleRightPane.tsx
│   ├── ArticleOutline.tsx
│   ├── ArticleSummary.tsx
│   ├── Editor.tsx
│   ├── article-extensions.ts
│   ├── TitledCodeBlock.ts
│   ├── MermaidBlockExtension.tsx
│   ├── TableOfContents.tsx
│   ├── DiffView.tsx
│   └── PagePreview.tsx
│
├── diagrams/                   # Diagram rendering
│   ├── MermaidDiagram.tsx
│   ├── DrawioDiagramPreview.tsx
│   ├── DrawioEditor.tsx
│   └── DiagramLightbox.tsx
│
├── badges/                     # Status indicators
│   ├── ServiceStatus.tsx
│   ├── EmbeddingStatusBadge.tsx
│   ├── FreshnessBadge.tsx
│   ├── QualityScoreBadge.tsx
│   ├── SummaryStatusBadge.tsx
│   └── ConfidenceBadge.tsx
│
├── feedback/                   # Loading, errors, empty states
│   ├── ErrorBoundary.tsx
│   ├── FeatureErrorBoundary.tsx
│   ├── EmptyState.tsx
│   ├── Skeleton.tsx
│   ├── AIThinkingBlob.tsx
│   └── StreamingCursor.tsx
│
└── effects/                    # Visual effects & animations
    ├── AuroraBackground.tsx
    ├── NoiseOverlay.tsx
    ├── MagneticButton.tsx
    ├── TiltCard.tsx
    ├── DirectionAwareHover.tsx
    ├── AnimatedCounter.tsx
    └── ActivityHeatmap.tsx
```

Tests stay co-located with their components.

---

## 7. ESLint Boundary Rules

Configure `eslint-plugin-boundaries` in `backend/eslint.config.js`:

```javascript
// Element types
{
  type: 'core',      pattern: 'src/core/**',
  type: 'confluence', pattern: 'src/domains/confluence/**',
  type: 'llm',       pattern: 'src/domains/llm/**',
  type: 'knowledge',  pattern: 'src/domains/knowledge/**',
  type: 'routes-foundation',  pattern: 'src/routes/foundation/**',
  type: 'routes-confluence',  pattern: 'src/routes/confluence/**',
  type: 'routes-llm',         pattern: 'src/routes/llm/**',
  type: 'routes-knowledge',   pattern: 'src/routes/knowledge/**',
  type: 'app',       pattern: 'src/{app,index,telemetry}.ts',
}

// Rules
core         → [contracts, npm]                         // Core imports nothing from domains
confluence   → [core, contracts, npm]                   // No llm, no knowledge
llm          → [core, contracts, npm]                   // No confluence, no knowledge
knowledge    → [core, confluence, llm, contracts, npm]  // Highest domain
routes-*     → [core, their-domain, contracts, npm]     // Routes see own domain + core
routes-knowledge → [core, confluence, llm, knowledge]   // Exception: knowledge routes see all
app          → [everything]                             // Composition root
```

**Exception**: `confluence/sync-embedding.ts` → `llm/embedding-service` (documented, pragmatic).

---

## 8. When to Upgrade to Full Packages

The directory-based approach works well within these bounds:

| Trigger | Threshold | Why It Breaks |
|---------|-----------|---------------|
| **Team size** | > 4 concurrent developers | Multiple people editing the same `backend/` package causes merge conflicts; separate packages give isolated build/test |
| **Service count** | > 80 services | TypeScript compile time for single `backend/` gets painful (>30s); project references parallelize compilation |
| **Independent deployment** | Any | If you need to deploy confluence-sync separately from the LLM service, you need real package boundaries |
| **Shared library reuse** | Any | If another project wants `@atlasmind/core` or `@atlasmind/llm`, extract to packages |
| **CI time** | > 5 minutes | Package-level caching: only rebuild/retest changed packages |
| **ESLint boundary violations** | Frequent | If the team keeps overriding boundary rules, hard package boundaries enforce by compiler error instead of lint warning |

**For your current scale (4-15 users, ~45 services, 1-2 developers)**: This directory approach is comfortable. You'll likely hit the upgrade triggers around **50+ users / 80+ services / 3-4 developers working concurrently**.

**Upgrade path**: The directory structure maps 1:1 to the package structure. When triggers hit:
1. `core/` → `packages/core/`
2. `domains/confluence/` → `packages/confluence/`
3. `domains/llm/` → `packages/llm/`
4. `domains/knowledge/` → `packages/knowledge/`
5. `routes/foundation/` → `packages/foundation/src/routes/`
6. Add `wiring.ts` for DI adapters (replace the one cross-domain direct import)

The barrel exports you create now become the package public APIs later.

---

## 9. Migration Checklist

### Pre-flight
- [ ] All tests passing on `dev`
- [ ] Clean git status
- [ ] Create branch: `feature/modularize-backend`
- [ ] Fix duplicate migration numbers (015, 017, 018)

### Phase 1: Directory structure
- [ ] Create `core/`, `domains/`, `routes/` subdirectories
- [ ] Commit: "chore: create modular directory structure"

### Phase 2: Extract core
- [ ] Move db/, plugins/, utils/ → core/
- [ ] Move 5 shared services → core/services/
- [ ] Create core/index.ts barrel export
- [ ] Update all consumer imports
- [ ] Typecheck passes
- [ ] Commit: "refactor: extract core infrastructure layer"

### Phase 3: Extract domain services
- [ ] Move 8 services → domains/confluence/services/
- [ ] Move 7 services → domains/llm/services/
- [ ] Move 5 services → domains/knowledge/services/
- [ ] Create barrel exports for each domain
- [ ] Update all consumer imports
- [ ] Typecheck passes
- [ ] Commit: "refactor: extract domain service modules"

### Phase 4: Move and split routes
- [ ] Move 12 simple routes to domain subdirectories
- [ ] Split routes/llm.ts → 5 files in routes/llm/
- [ ] Split routes/pages.ts → 5 files in routes/knowledge/
- [ ] Update app.ts route registration
- [ ] Typecheck passes
- [ ] All tests pass
- [ ] Commit: "refactor: split and reorganize routes by domain"

### Phase 5: Update tests
- [ ] Fix all test import paths
- [ ] Move __fixtures__/ to appropriate domain
- [ ] All tests pass
- [ ] Commit: "test: update imports for new module structure"

### Phase 6: ESLint boundaries
- [ ] Configure eslint-plugin-boundaries rules
- [ ] Fix any violations
- [ ] Lint passes
- [ ] Commit: "chore: enforce domain boundary rules via ESLint"

### Phase 7: Frontend components
- [ ] Create subdirectories (layout, article, diagrams, badges, feedback, effects)
- [ ] Move components + co-located tests
- [ ] Update all import paths
- [ ] Frontend tests pass
- [ ] Commit: "refactor: categorize shared components"

### Phase 8: Final verification
- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes
- [ ] `npm test` passes (all workspaces)
- [ ] `npm run build` succeeds
- [ ] `npm run dev` starts correctly
- [ ] Docker build succeeds
- [ ] Manual smoke test
- [ ] Update CLAUDE.md architecture section
- [ ] PR to `dev`

---

## 10. Future: Full Package Architecture (Phase 2)

When scaling triggers from Section 8 are hit, upgrade to npm workspace packages.
The original full-package plan is preserved here for reference.

### Target structure (future)

```
packages/
├── contracts/             # @atlasmind/contracts (+ service interfaces)
├── core/                  # @atlasmind/core
├── confluence/            # @atlasmind/confluence
├── llm/                   # @atlasmind/llm
├── knowledge/             # @atlasmind/knowledge
├── foundation/            # @atlasmind/foundation
└── server/                # @atlasmind/server (composition root)
```

### What changes from current plan

| Concern | Directory Approach (now) | Package Approach (future) |
|---------|------------------------|--------------------------|
| Import enforcement | ESLint boundaries (lint warning) | Compiler error (hard fail) |
| Build | Single `tsc` | `tsc --build` with project references |
| Cross-domain deps | Direct import (documented exception) | DI via wiring.ts + contract interfaces |
| Testing | Single vitest config | Per-package vitest |
| Docker | Unchanged from today | Multi-stage with workspace install |
| Dev workflow | Unchanged from today | Watch mode with project references |

### Migration effort (future)

Since directories map 1:1 to packages:
1. Create package.json + tsconfig.build.json per directory (~1 hour)
2. Move directories under `packages/` (~30 min)
3. Add contract interfaces for cross-domain deps (~2 hours)
4. Create `server/wiring.ts` for DI adapters (~2 hours)
5. Update root package.json workspaces + build scripts (~30 min)
6. Update Docker build (~1 hour)
7. Test everything (~2 hours)

**Estimated effort**: ~1 day (because directory structure already matches)

---

## Appendix: File Move Inventory

**Total files to move**: ~45 production files (excluding tests)
**Total import rewrites**: ~120
**New files created**: ~8 (barrel exports, route splits)
**Config changes**: 1 (ESLint boundaries)
**Build changes**: 0
**Docker changes**: 0

| Target | Files Moved | Files Created |
|--------|-------------|---------------|
| core/ | 15 | 1 (index.ts) |
| domains/confluence/ | 8 | 1 (index.ts) |
| domains/llm/ | 7 | 1 (index.ts) |
| domains/knowledge/ | 5 | 1 (index.ts) |
| routes/foundation/ | 4 | 0 |
| routes/confluence/ | 3 | 0 |
| routes/llm/ | 1 moved + 5 split | 5 (from llm.ts) |
| routes/knowledge/ | 4 moved + 5 split | 5 (from pages.ts) |
| frontend/shared/ | 35 | 0 (just move to subdirs) |
