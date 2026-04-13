# Cross-Artifact Consistency and Coverage Analysis Report

**Date**: 2026-04-03
**Analyzer**: brahma-analyzer
**Scope**: Full monorepo analysis (backend, frontend, packages/contracts, docs, EE overlay)

---

## Quality Score: 74/100

**Overall Assessment**: WARN

Scoring Breakdown:
- Constitution Alignment: 16/20
- Coverage Completeness: 18/25
- Consistency Validation: 18/25
- Conflict Resolution: 14/20
- Documentation Quality: 8/10

**Critical Issues**: 2
**High Issues**: 5
**Medium Issues**: 8
**Low Issues**: 6

---

## Executive Summary

- Passed: 14 checks
- Warnings: 8 checks
- Failed: 2 checks

**Ready for Implementation**: NO

Resolve these blockers first:
1. **CRITICAL**: EE overlay feature flags use completely different identifiers than CE feature constants (inconsistent across repos)
2. **CRITICAL**: Security audit references a file (`llm-chat.ts`) that no longer exists; 7+ route files added after the audit have not been audited

---

## 1. Spec-to-Code Alignment (ADRs vs Implementation)

### 1.1 Domain Boundary Rules -- ESLint Enforcement [PASS]

The ESLint config at `backend/eslint.config.js` correctly enforces the domain boundary rules documented in CLAUDE.md and ADR-001/ADR-008:

| Rule (from CLAUDE.md) | ESLint Config | Status |
|------------------------|---------------|--------|
| core -> no domain or route imports | `from: 'core', disallow: [all domains + routes]` | PASS |
| confluence -> core + llm | `from: 'confluence', disallow: [knowledge, all routes]` | PASS |
| llm -> core only | `from: 'llm', disallow: [confluence, knowledge, all routes]` | PASS |
| knowledge -> core + llm + confluence | `from: 'knowledge', disallow: [all routes]` | PASS |
| routes -> core + own domain | Each route type restricts cross-route and off-domain imports | PASS |

**Additional finding**: The ESLint config adds `routes-llm -> confluence` access (not documented in CLAUDE.md/ADR-001). The config comment says "for subpage-context, sync-service". This is a minor documentation gap.

**Severity**: Low | **Category**: Consistency

### 1.2 Migration Count Drift [MEDIUM]

| Source | Migration Count |
|--------|----------------|
| ACTION-PLAN.md | "26 migration files (001-026)" |
| CLAUDE.md | "Sequential SQL files (001-045)" |
| Actual filesystem | 49 migration files (001-049, plus 017b) |

The ACTION-PLAN.md is significantly out of date, listing only 26 migrations when there are actually 49. CLAUDE.md says "001-045" but the actual count is 49 (up to 049).

**Severity**: Medium | **Category**: Consistency

### 1.3 ACTION-PLAN.md Backend Structure Drift [MEDIUM]

The ACTION-PLAN.md shows a backend directory tree referencing old locations (e.g., `routes/foundation/` lists only "health, auth, settings, admin" but the actual codebase has setup.ts, rbac.ts, notifications.ts). The knowledge routes section lists only a subset of the actual route files (misses templates, comments, content-analytics, verification, knowledge-requests, search, pages-import, local-spaces, pages-export).

Similarly, the "26 migration files" section is stale -- migrations 027 through 049 exist but are not documented in the plan.

**Severity**: Medium | **Category**: Coverage

### 1.4 ADR-006 Schema Stale [MEDIUM]

ADR-006 documents only migrations 001-009 in the schema section. The actual schema has grown to include templates (032), comments (033), content analytics (034), verification (035), notifications (036), knowledge requests (037), local spaces (038), RBAC (039-040), page types (043), shared LLM admin settings (044), AI safety (046), stored tsvector (047), configurable FTS language (049), and more. ADR-006 should be updated or marked as a partial reference.

**Severity**: Medium | **Category**: Consistency

---

## 2. API Contract Consistency (Frontend <-> Backend <-> Contracts)

### 2.1 Zod Schema Coverage [PASS with warnings]

The `@compendiq/contracts` package covers the primary API boundaries:

| Schema Module | Coverage |
|---------------|----------|
| `auth.ts` | Register, Login, AuthResponse | PASS |
| `pages.ts` | PageSummary, PageDetail, CreatePage, UpdatePage, SearchHybrid, PageList, PageTree, Draft, Duplicates, Export | PASS |
| `llm.ts` | Improve, Generate, Summarize, Ask, Diagram, Quality, ForceEmbedTree, ApplyImprovement, Conversations, Improvements, Models, EmbeddingStatus, ExtractPdf | PASS |
| `settings.ts` | UserSettings, UpdateSettings, SettingsResponse, SyncProgress, SyncOverview, TestConfluence | PASS |
| `spaces.ts` | Space | PASS |
| `admin.ts` | AdminSettings, UpdateAdminSettings, ReEmbed | PASS |
| `templates.ts` | Template, TemplateSummary, CreateTemplate, UpdateTemplate, UseTemplate, TemplateListQuery | PASS |

**Warning**: The following API boundaries lack shared Zod schemas in `@compendiq/contracts`:

| Missing Schema | Used In |
|----------------|---------|
| Setup wizard schemas | `setup.ts` uses inline `z.object()` (SetupAdminSchema, LlmTestSchema) |
| RBAC schemas | `rbac.ts` -- no contract schemas for roles/groups/ACEs |
| Comments schemas | `comments.ts` -- no contract schemas for comment CRUD |
| Notifications schemas | `notifications.ts` -- no contract schemas |
| Verification schemas | `verification.ts` -- no contract schemas |
| Knowledge request schemas | `knowledge-requests.ts` -- uses inline schemas |
| Analytics schemas | `analytics.ts`, `content-analytics.ts` -- inline schemas |
| Local spaces schemas | `local-spaces.ts` -- inline schemas |
| Pinned pages schemas | `pinned-pages.ts` -- inline schemas |

This means the frontend and backend can drift for these endpoints since there is no shared type contract.

**Severity**: Medium | **Category**: Coverage

### 2.2 Frontend API Call Alignment [PASS]

The frontend `apiFetch` calls in `use-standalone.ts` and feature components match the backend route registrations in `app.ts`. The prefix `/api` is correctly applied in the backend, and the frontend `apiFetch` helper prepends `/api` to all paths. No mismatched endpoint paths were detected.

### 2.3 LicenseInfo Type Mismatch (CE Backend vs Frontend) [HIGH]

The CE backend `LicenseInfo` type (`backend/src/core/enterprise/types.ts`) and the frontend `LicenseInfo` type (`frontend/src/shared/enterprise/types.ts`) have structural differences:

| Field | Backend | Frontend |
|-------|---------|----------|
| `edition` | Not present | Present (`string`) |
| `tier` | Present | Present |
| `seats` | Required (`number`) | Optional (`number?`) |
| `expiresAt` | Required (`Date`) | Optional (`string?`) |
| `isValid` | Required (`boolean`) | Optional (`boolean?`) |
| `displayKey` | Required (`string`) | Optional (`string?`) |
| `licenseId` | Optional (`string \| null`) | Not present |
| `features` | Optional (`string[]`) | Required (`string[]`) |

The community-mode fallback route in `app.ts` returns `{ edition: 'community', tier: 'community', features: [] }` which includes `edition` but NOT `seats`, `expiresAt`, `isValid`, or `displayKey`. The frontend type expects `edition` but the backend type does not define it -- it is only present in the route response literal.

**Severity**: High | **Category**: Consistency

---

## 3. Test Coverage Gaps

### 3.1 Backend Services Without Test Files [MEDIUM]

| Service File | Has Test? |
|-------------|-----------|
| `core/services/ai-safety-service.ts` | NO |
| `core/services/image-references.ts` | NO |
| `core/services/notification-service.ts` | NO |
| `core/services/rate-limit-service.ts` | NO |
| `core/services/version-snapshot.ts` | NO |
| `core/services/mcp-docs-client.ts` | NO |
| `core/services/admin-settings-service.ts` | NO |
| `core/services/fts-language.ts` | NO |
| `core/plugins/redis.ts` | NO |
| `core/utils/logger.ts` | NO |
| `core/utils/version.ts` | NO |
| `domains/llm/services/ollama-provider.ts` | NO (tested indirectly via ollama-service.test.ts) |

**12 service/utility files lack direct test coverage.** While some are thin wrappers, `ai-safety-service.ts`, `rate-limit-service.ts`, and `admin-settings-service.ts` contain non-trivial logic.

**Severity**: Medium | **Category**: Coverage

### 3.2 Backend Route Test Patterns [PASS]

All route implementation files (38 files with `fastify.get/post/put/delete`) have corresponding `.test.ts` files. Some routes have multiple test files covering different aspects (e.g., `pages-crud` has separate test files for create, delete-rbac, update, filters, list-shape, draft, graph, tree, children, image-upload). This is thorough.

### 3.3 Frontend Test Coverage [PASS with warnings]

Most frontend feature components have corresponding test files. Notable exceptions:

| Component | Has Test? |
|-----------|-----------|
| `features/settings/RateLimitsTab.tsx` | NO |
| `features/settings/SearxngTab.tsx` | NO |
| `features/settings/ThemeTab.tsx` | NO |
| `features/settings/WorkersTab.tsx` | NO |
| `features/setup/steps/ConfluenceStep.tsx` | NO |
| `shared/enterprise/loader.ts` | NO |
| `shared/enterprise/use-enterprise.ts` | NO |

**Severity**: Low | **Category**: Coverage

### 3.4 E2E Test Coverage [LOW]

E2E tests exist in the `e2e/` directory (Playwright). Based on the test-results directory, tests cover auth flow and AI chat. No E2E tests were found for:
- Setup wizard flow
- Confluence sync flow
- Template CRUD
- Knowledge requests
- RBAC management
- Local space management

**Severity**: Low | **Category**: Coverage

---

## 4. Security Audit Gaps

### 4.1 Stale Audit -- Route File Refactoring [CRITICAL]

The security audit (2026-03-22) references `routes/llm/llm-chat.ts` which **no longer exists**. The LLM routes were split into separate files:
- `llm-improve.ts`
- `llm-generate.ts`
- `llm-summarize.ts`
- `llm-diagram.ts`
- `llm-quality.ts`
- `llm-ask.ts`

These 6 split-out files were NOT audited individually. While they likely inherit the same patterns as the original `llm-chat.ts`, the audit should be re-run to verify.

**Severity**: Critical | **Category**: Security

### 4.2 Route Files Not in Security Audit [HIGH]

The following route files are registered in `app.ts` but NOT listed in the security audit's "Files audited" or "Route authentication matrix" sections:

| Route File | Auth Check (verified manually) | In Audit? |
|------------|-------------------------------|-----------|
| `setup.ts` | Mixed: `/health/setup-status` is public; `/setup/admin` is rate-limited but unauthenticated; `/setup/llm-test` requires auth | NO |
| `llm-improve.ts` | `fastify.addHook('onRequest', fastify.authenticate)` | NO |
| `llm-generate.ts` | `fastify.addHook('onRequest', fastify.authenticate)` | NO |
| `llm-summarize.ts` | `fastify.addHook('onRequest', fastify.authenticate)` | NO |
| `llm-diagram.ts` | `fastify.addHook('onRequest', fastify.authenticate)` | NO |
| `llm-quality.ts` | `fastify.addHook('onRequest', fastify.authenticate)` | NO |
| `llm-ask.ts` | `fastify.addHook('onRequest', fastify.authenticate)` | NO |

Manual inspection shows all these files DO have proper auth hooks. However, they need formal audit coverage.

**Note on `setup.ts`**: The `/setup/admin` endpoint intentionally lacks authentication (it creates the first admin user). It is protected by:
1. An atomic INSERT that only succeeds when no admin exists (TOCTOU-safe)
2. Rate limiting (uses auth rate limit category)

This is a correct design. However, the security audit should explicitly document this as an exempt endpoint.

**Severity**: High | **Category**: Security

### 4.3 SQL Injection Coverage for New Routes [HIGH]

The security audit's SQL injection spot-audit does not cover the setup.ts routes (which do have SQL queries). Manual inspection shows they use parameterized queries ($1, $2), but this should be formally documented.

**Severity**: High | **Category**: Security

---

## 5. Enterprise Plugin Alignment

### 5.1 Feature Flag Identifier Mismatch [CRITICAL]

The CE repo (`backend/src/core/enterprise/features.ts`) defines 24 feature flags using specific string identifiers (e.g., `oidc_sso`, `advanced_rbac`, `audit_log_export`).

The EE overlay has **two** conflicting feature definitions:

**EE overlay `plugin.ts`** uses the CE `ENTERPRISE_FEATURES` constants correctly:
```
TIER_FEATURES.team = { OIDC_SSO, SEAT_ENFORCEMENT }
TIER_FEATURES.business = { ...team, OIDC_GROUP_MAPPINGS, ADVANCED_RBAC, ... }
```

**EE overlay `types.ts`** defines a COMPLETELY DIFFERENT set of feature identifiers:
```
ENTERPRISE_FEATURES = {
  team: ['oidc'],
  business: ['oidc', 'audit-export', 'custom-branding'],
  enterprise: ['oidc', 'audit-export', 'custom-branding', 'multi-instance', 'priority-support']
}
```

And the **EE frontend `LicenseStatusCard.tsx`** checks against yet ANOTHER set of feature keys:
```
['oidc', 'audit-export', 'custom-branding', 'multi-instance', 'priority-support']
```

These do NOT match the CE feature constants:
- CE uses `oidc_sso`, EE types.ts/frontend uses `oidc`
- CE uses `audit_log_export`, EE types.ts/frontend uses `audit-export`
- CE defines `advanced_rbac`, EE types.ts/frontend uses `custom-branding` (not in CE at all)
- CE defines `multi_instance`, EE types.ts/frontend uses `multi-instance` (kebab vs snake case)

The `plugin.ts` adapter correctly converts to CE features, but the EE `types.ts` and frontend components use their own incompatible naming scheme. If `LicenseStatusCard.tsx` checks `features.includes('oidc')` but the backend returns features as `['oidc_sso']`, no features will show as enabled.

**Severity**: Critical | **Category**: Consistency

### 5.2 LicenseInfo Shape Mismatch Between EE Repos [HIGH]

| Field | CE Backend `LicenseInfo` | EE `types.ts` `LicenseInfo` | EE `LicenseStatusCard` `LicenseStatus` |
|-------|--------------------------|-----------------------------|-----------------------------------------|
| `tier` | Yes | Yes | Yes |
| `seats` | Yes (required) | Yes (required) | Yes (required) |
| `expiresAt` | Yes (Date) | No (`expiry: Date`) | `expiry: string \| null` |
| `isValid` | Yes | Yes | Yes |
| `isExpired` | No | Yes | No |
| `displayKey` | Yes | No | No |
| `licenseId` | Yes (optional) | Yes | No |
| `features` | Yes (optional) | No | Yes |
| `raw` | No | Yes | No |

The `plugin.ts` adapter function `toCELicenseInfo()` correctly bridges EE->CE types, but the frontend `LicenseStatusCard.tsx` expects `expiry` (string) while the backend route returns `expiresAt` (ISO string). This naming mismatch means the expiry date may not display correctly.

**Severity**: High | **Category**: Consistency

### 5.3 EE Plugin Import Paths [PASS]

The EE overlay `plugin.ts` imports from `../core/enterprise/types.js` and `../core/enterprise/features.js`. After the overlay merge (rsync), these paths resolve to the CE files at `backend/src/core/enterprise/types.ts` and `backend/src/core/enterprise/features.ts`. This is correct by design.

---

## 6. Configuration Consistency

### 6.1 .env.example vs docker-compose.yml [PASS with warnings]

| Variable | .env.example | docker-compose.yml | Match? |
|----------|--------------|--------------------|--------|
| JWT_SECRET | Yes | Yes (required) | PASS |
| PAT_ENCRYPTION_KEY | Yes | Yes (required) | PASS |
| POSTGRES_URL | Yes | Yes (constructed) | PASS |
| REDIS_URL | Yes | Yes (constructed) | PASS |
| OLLAMA_BASE_URL | Yes | Yes | PASS |
| LLM_PROVIDER | Yes | Yes | PASS |
| OPENAI_BASE_URL | Yes | Yes | PASS |
| OPENAI_API_KEY | Yes | Yes | PASS |
| EMBEDDING_MODEL | Yes | Yes | PASS |
| FRONTEND_URL | Yes (commented) | Yes | PASS |
| LOG_LEVEL | Yes (commented) | Yes | PASS |
| OTEL_ENABLED | Yes | Yes | PASS |
| CONFLUENCE_VERIFY_SSL | Yes | Yes | PASS |
| ATTACHMENTS_DIR | Yes | Yes (hardcoded `/app/data/attachments`) | PASS |
| MCP_DOCS_URL | Yes | Yes | PASS |

**Warning**: The following env vars are in .env.example but NOT in docker-compose.yml:
- `EMBEDDING_DIMENSIONS` -- code reads it but docker-compose does not pass it
- `FTS_LANGUAGE` -- code reads it but docker-compose does not pass it
- `ACCESS_TOKEN_EXPIRY` -- code reads it but docker-compose does not pass it
- `TOKEN_CLEANUP_INTERVAL_HOURS` -- code reads it but docker-compose does not pass it
- `PG_POOL_MAX` -- code reads it but docker-compose does not pass it
- `PG_STATEMENT_TIMEOUT` -- code reads it but docker-compose does not pass it
- `RAG_EF_SEARCH` -- code reads it but docker-compose does not pass it
- `COMPENDIQ_LICENSE_KEY` -- code reads it but docker-compose does not pass it

All of these have sensible defaults in code, so they will work without being set. However, for enterprise deployments, `COMPENDIQ_LICENSE_KEY` should be passable via docker-compose.

**Severity**: Low | **Category**: Configuration

### 6.2 ATLASMIND_LICENSE_KEY Legacy Reference [LOW]

Both `app.ts` and `overlay/backend/src/enterprise/license-service.ts` check for `process.env.ATLASMIND_LICENSE_KEY` as a fallback for `COMPENDIQ_LICENSE_KEY`. This legacy name is NOT documented in .env.example or CLAUDE.md.

**Severity**: Low | **Category**: Consistency

### 6.3 FRONTEND_PORT Mismatch [LOW]

- `.env.example` comments suggest `FRONTEND_PORT=5273` (Vite dev server default)
- `docker-compose.yml` maps `${FRONTEND_PORT:-8081}:8081` (nginx production port)
- `FRONTEND_URL` default in `app.ts` is `http://localhost:5273` (dev mode)
- `FRONTEND_URL` in docker-compose is `http://localhost:8081` (production)

This is actually correct behavior (dev vs production), but the .env.example does not explain this distinction clearly.

**Severity**: Low | **Category**: Configuration

### 6.4 SEARXNG_URL / CONFLUENCE_DOCKER_HOST [LOW]

`docker-compose.yml` passes `CONFLUENCE_DOCKER_HOST: ${CONFLUENCE_DOCKER_HOST:-confluence}` and references `SEARXNG_URL` in the mcp-docs service. Neither `CONFLUENCE_DOCKER_HOST` nor `SEARXNG_URL` is documented in `.env.example`.

**Severity**: Low | **Category**: Configuration

---

## 7. Import/Export Consistency

### 7.1 Circular Dependencies [PASS]

No circular dependencies were detected in the domain boundary analysis. The ESLint `boundaries` plugin enforces a strict DAG:
```
core (base) <- llm <- confluence <- knowledge
routes -> core + own domain only
```

### 7.2 Missing Contracts Export [LOW]

The `@compendiq/contracts` package index exports 7 schema modules but does NOT export an `enterprise.ts` schema as mentioned in the ENTERPRISE-ARCHITECTURE.md design document (Section 2.1 references `packages/contracts/src/schemas/enterprise.ts`). This file does not exist.

**Severity**: Low | **Category**: Coverage

---

## 8. Performance Document Alignment [PASS]

The `docs/PERFORMANCE.md` targets are reasonable and the measurement methodology is well-defined. The document references correct endpoint paths and tooling. Minor note: the performance doc references `GET /api/pages` but the actual implementation uses query parameters for filtering that may affect latency measurements.

---

## Findings Summary

### Critical (Must Fix) -- 2 issues

| # | Finding | Category |
|---|---------|----------|
| C-1 | EE overlay `types.ts` and frontend `LicenseStatusCard.tsx` use different feature flag identifiers than CE `ENTERPRISE_FEATURES` constants. Features will not display correctly in the EE frontend. | Consistency |
| C-2 | Security audit references deleted file `llm-chat.ts`. 7 route files added post-audit lack formal security coverage. | Security |

### High -- 5 issues

| # | Finding | Category |
|---|---------|----------|
| H-1 | CE backend and frontend `LicenseInfo` types have structural differences (missing fields, different optionality). | Consistency |
| H-2 | EE `LicenseStatusCard` uses `expiry` field name but backend returns `expiresAt`. | Consistency |
| H-3 | `setup.ts` routes not included in security audit (public `/setup/admin` endpoint creates admin accounts). | Security |
| H-4 | SQL injection audit does not cover `setup.ts` queries. | Security |
| H-5 | 9+ API boundaries lack shared Zod schemas in `@compendiq/contracts` (inline schemas in route files). | Coverage |

### Medium -- 8 issues

| # | Finding | Category |
|---|---------|----------|
| M-1 | ACTION-PLAN.md lists 26 migrations; actual count is 49. | Consistency |
| M-2 | ACTION-PLAN.md backend directory tree is stale (missing many route files). | Consistency |
| M-3 | ADR-006 schema section only covers migrations 001-009. | Consistency |
| M-4 | 12 backend service/utility files lack direct test coverage. | Coverage |
| M-5 | CLAUDE.md says migrations "001-045" but actual range is 001-049. | Consistency |
| M-6 | ESLint config allows `routes-llm -> confluence` access not documented in CLAUDE.md boundary rules. | Consistency |
| M-7 | `@compendiq/contracts` missing schemas for comments, notifications, verification, knowledge-requests, analytics, local-spaces, pinned-pages, RBAC. | Coverage |
| M-8 | Frontend settings tabs (RateLimitsTab, SearxngTab, ThemeTab, WorkersTab) lack test files. | Coverage |

### Low -- 6 issues

| # | Finding | Category |
|---|---------|----------|
| L-1 | Several docker-compose env vars undocumented in .env.example (EMBEDDING_DIMENSIONS, FTS_LANGUAGE, etc.). | Configuration |
| L-2 | `ATLASMIND_LICENSE_KEY` legacy env var not documented. | Consistency |
| L-3 | FRONTEND_PORT dev/production distinction not clearly documented. | Configuration |
| L-4 | `CONFLUENCE_DOCKER_HOST` and `SEARXNG_URL` not in .env.example. | Configuration |
| L-5 | Enterprise architecture doc references `packages/contracts/src/schemas/enterprise.ts` which does not exist. | Coverage |
| L-6 | E2E tests cover only auth and AI chat flows; many feature flows untested. | Coverage |

---

## Recommendations

### Immediate Actions (Before Next Release)

1. **Re-run security audit** covering all 7 split LLM route files and `setup.ts`. Update SECURITY-AUDIT.md with current file names and add the new route files to the auth matrix.

2. **Fix EE feature flag identifiers** in `overlay/backend/src/enterprise/types.ts` and `overlay/frontend/src/features/admin/LicenseStatusCard.tsx` to use the CE `ENTERPRISE_FEATURES` constant values (snake_case: `oidc_sso`, `audit_log_export`, etc.).

3. **Align LicenseInfo types** between CE backend, CE frontend, and EE overlay. The `expiry` vs `expiresAt` field name mismatch will cause the EE frontend to display "N/A" for license expiry.

4. **Add `COMPENDIQ_LICENSE_KEY` to docker-compose.yml** as an optional env var passthrough for enterprise deployments.

### Short-Term (Next Sprint)

5. **Update ACTION-PLAN.md** migration count and backend directory structure, or mark it as a historical document and point to CLAUDE.md as the current source of truth.

6. **Add shared Zod schemas** to `@compendiq/contracts` for the remaining 9 API boundaries (comments, notifications, verification, etc.).

7. **Add tests** for `ai-safety-service.ts`, `rate-limit-service.ts`, and `admin-settings-service.ts` -- these contain non-trivial business logic.

### Medium-Term

8. **Update ADR-006** to reference the full migration range (001-049) or create a separate schema evolution document.

9. **Document the `routes-llm -> confluence`** import allowance in CLAUDE.md's domain boundary rules section.

10. **Add missing env vars** (`EMBEDDING_DIMENSIONS`, `FTS_LANGUAGE`, `RAG_EF_SEARCH`, `CONFLUENCE_DOCKER_HOST`, `SEARXNG_URL`) to `.env.example` with explanatory comments.

---

## Traceability Matrix

| ADR | Description | Plan Section | Implementation | Status |
|-----|-------------|--------------|----------------|--------|
| ADR-001 | Project Structure | Phase 1 | Implemented (flat + contracts) | PASS |
| ADR-002 | TipTap Editor | Phase 5.5 | Implemented (TipTap v3 + extensions) | PASS |
| ADR-003 | Content Pipeline | Phase 0, 3 | Implemented (content-converter.ts) | PASS |
| ADR-004 | Caching & Sync | Phase 3 | Implemented (Redis + PG + background sync) | PASS |
| ADR-005 | SSE Streaming | Phase 4 | Implemented (fetch + ReadableStream) | PASS |
| ADR-006 | Database Schema | Phase 1-3 | Implemented (49 migrations) | WARN (docs stale) |
| ADR-007 | Security | Phase 2, 6 | Implemented (AES-256-GCM, JWT, bcrypt) | PASS |
| ADR-008 | Backend Structure | Phase 1 | Implemented (domains/ + routes/ + core/) | PASS |
| ADR-009 | State Management | Phase 5 | Implemented (Zustand stores) | PASS |
| ADR-010 | UI Components | Phase 5 | Implemented (glassmorphic + Radix + Framer) | PASS |
| ADR-011 | Docker | Phase 6 | Implemented (6-service compose) | PASS |
| ADR-012 | RAG Pipeline | Phase 4 | Implemented (pgvector + hybrid search) | PASS |
| ADR-013 | Draw.io | Phase 3.3 | Implemented (attachment handler + viewer) | PASS |
| Enterprise | Open-Core Plugin | ENTERPRISE-ARCHITECTURE.md | Implemented (loader + noop + types) | WARN (type mismatches) |
