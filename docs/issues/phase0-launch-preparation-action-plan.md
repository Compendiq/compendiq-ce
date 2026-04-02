# Phase 0 — Launch Preparation Action Plan

**Target:** 2026-04-26 (5 weeks from today)
**Goal:** Everything needed before flipping the repo to public
**Source:** Compendiq-Release-Roadmap.md (Phase 0, sections 3.1–3.7)

---

## Current State Summary

| Area | Readiness | Notes |
|------|-----------|-------|
| Enterprise Gating | 0% | No license code, no feature flags, OIDC/SSO ungated |
| Security | 90% | Rate limiting, SSRF guard, auth, LLM sanitizer all done; needs audit pass |
| Setup Wizard | 0% | No onboarding flow exists |
| Installer | 60% | Docker Compose + Dockerfiles done; no install.sh |
| Documentation | 50% | README + ADRs exist; missing CONTRIBUTING, SECURITY, CHANGELOG, guides |
| GitHub Config | 40% | CI workflows + LICENSE exist; no templates, PR template, CODEOWNERS |
| Test Coverage | 75% | 224 test files; only 1 E2E test |

---

## Work Breakdown: 7 Streams, 5 Weeks

### Week 1–2: Foundation (Streams 1–3 in parallel)

---

### Stream 1: Enterprise Gating Infrastructure
**Effort:** ~3 days | **Priority:** Critical | **Week:** 1

#### 1.1 Create enterprise directory structure

```
backend/src/enterprise/
├── license-service.ts        # Key validation, tier detection
├── license-service.test.ts   # Unit tests
├── license-middleware.ts      # Fastify hook to check license
├── license-middleware.test.ts
└── types.ts                  # LicenseTier, LicenseInfo types
```

#### 1.2 Implement license-service.ts

- Parse `COMPENDIQ_LICENSE_KEY` env var (or absent = Community)
- License key format: `ATM-{tier}-{seatCount}-{expiryYYYYMMDD}-{signature}`
  - Example: `ATM-ENT-50-20270101-a1b2c3d4e5f6`
  - Tier: `ENT` (enterprise), `PRO` (future)
  - Signature: HMAC-SHA256 of `tier-seats-expiry` with a server-side secret
- Export `getLicenseInfo(): LicenseInfo` — returns tier, seats, expiry, isValid
- Export `isEnterprise(): boolean` — shorthand
- Community mode when: no key, invalid key, or expired key
- Log warning (not error) on invalid key — never block startup

#### 1.3 Implement license-middleware.ts

- Fastify `preHandler` hook: `checkEnterpriseLicense()`
- Returns 403 `{ error: 'EnterpriseRequired', message: 'This feature requires an Enterprise license' }` when Community
- Apply to:
  - `backend/src/routes/foundation/oidc.ts` — all OIDC routes
  - Future: audit logs, SCIM, custom RBAC

#### 1.4 Gate existing enterprise features

| Route file | What to gate | How |
|------------|-------------|-----|
| `routes/foundation/oidc.ts` | All OIDC/SSO endpoints | Add `preHandler: [checkEnterpriseLicense]` to route options |
| `core/services/oidc-service.ts` | OIDC config endpoints | Already behind admin auth; add license check |

Do NOT gate: RBAC (basic roles are Community), notifications, analytics (basic).

#### 1.5 License status endpoint + frontend indicator

- `GET /api/admin/license` — returns `{ tier, seats, expiry, features: string[] }`
- Admin panel: show license status card (Community / Enterprise / Expired)
- Frontend: when OIDC settings page is opened in Community mode, show "Enterprise license required" banner instead of the config form

#### 1.6 Tests

- license-service: valid key, expired key, no key, invalid format, wrong signature
- license-middleware: blocks without license, allows with valid license, 403 shape
- Integration: OIDC routes return 403 in Community mode

---

### Stream 2: Security Hardening Audit
**Effort:** ~2 days | **Priority:** Critical | **Week:** 1

Most security infrastructure is already solid. This stream is a verification pass, not a build.

#### 2.1 Dependency audit

```bash
npm audit --workspace=backend --workspace=frontend --workspace=@compendiq/contracts
```

- Patch all critical and high CVEs
- Document any accepted risks in `docs/SECURITY-AUDIT.md`

#### 2.2 Spot-audit 20 SQL queries

Pick 20 random `query()` calls across route files. Verify each uses `$1`, `$2` parameterized syntax. No string interpolation or template literals in SQL. Document findings.

Files to sample from:
- `routes/knowledge/pages-crud.ts` (largest, most queries)
- `routes/knowledge/search.ts`
- `routes/confluence/sync.ts`
- `routes/foundation/auth.ts`
- `routes/llm/llm-chat.ts`

#### 2.3 Auth coverage check

- Grep all `fastify.get|post|put|patch|delete` calls across `routes/`
- Verify each has either `fastify.authenticate` preHandler or is in the exempt list:
  - `/api/health/*` (public)
  - `/api/auth/login`, `/api/auth/register`, `/api/auth/refresh` (public)
  - `/api/auth/oidc/*` (public for SSO flow)

#### 2.4 CORS verification

- Confirm `FRONTEND_URL` env var is used in production
- Verify no `origin: '*'` or `origin: true` in production mode
- Test: cross-origin request from a different domain should be rejected

#### 2.5 Startup secret validation

- Confirm `NODE_ENV=production` refuses to start with default/weak JWT_SECRET or PAT_ENCRYPTION_KEY
- Read `backend/src/index.ts` to verify startup checks exist

#### 2.6 Debug/dev route review

- Check for any routes that should be disabled in production
- Look for test/debug endpoints, console.log statements in route handlers

#### Deliverable

`docs/SECURITY-AUDIT.md` — checklist with pass/fail for each item, date, auditor.

---

### Stream 3: Documentation — Core Files
**Effort:** ~2 days | **Priority:** Critical | **Week:** 1–2

#### 3.1 CONTRIBUTING.md (new)

Contents:
- Prerequisites (Node 24, Docker, PostgreSQL 17)
- Local dev setup (`npm install`, `docker compose -f docker/docker-compose.yml up -d`, `npm run dev`)
- Branch workflow (`feature/* → dev → main`)
- Testing expectations (every change needs tests)
- PR checklist (tests pass, typecheck clean, docs updated)
- Code style (ESLint, TypeScript strict, readability first)
- Link to `CLAUDE.md` for AI-assisted development

#### 3.2 SECURITY.md (new)

Contents:
- Supported versions table (v1.0.x = supported)
- Reporting a vulnerability (email, PGP key optional, 72h SLA for critical)
- Security measures overview (PAT encryption, SSRF guard, rate limiting)
- Responsible disclosure policy

#### 3.3 CHANGELOG.md (new)

Start with v1.0.0-rc.1 entry. Format: [Keep a Changelog](https://keepachangelog.com/).

```markdown
# Changelog

## [1.0.0] — 2026-04-26

### Added
- Full knowledge management (pages, versions, templates, comments, PDF export)
- Confluence Data Center bi-directional sync
- AI suite: RAG Q&A, article generation, improvement, summarization
- Ollama + OpenAI-compatible LLM support
- Hybrid search (semantic + keyword)
- Auto-tagging, quality scoring, duplicate detection
- Email/password auth + OIDC/SSO (Enterprise)
- RBAC (Admin / Editor / Viewer)
- Local spaces (standalone pages)
- First-run setup wizard
- One-command Docker installer
- Knowledge graph visualization
- Keyboard shortcuts with WCAG 2.1.4 compliance
```

#### 3.4 Update .env.example

- Verify all env vars from CLAUDE.md are present
- Add inline comments explaining each var
- Group by category (Required, Database, LLM, Auth, Optional)
- Add `COMPENDIQ_LICENSE_KEY` (after Stream 1)

---

### Week 2–3: User Experience (Streams 4–5)

---

### Stream 4: First-Run Setup Wizard
**Effort:** ~5 days | **Priority:** Critical | **Week:** 2–3

This is the highest-effort stream. The wizard replaces "read the README" with a guided UI.

#### 4.1 Backend: First-run detection

- `GET /api/health/setup-status` (public, no auth required)
  - Returns `{ setupComplete: boolean, steps: { admin: boolean, llm: boolean, confluence: boolean } }`
  - `admin = true` when at least one admin user exists in the `users` table
  - `llm = true` when LLM health check passes (or LLM provider is configured)
  - `confluence = true` when at least one space exists in `spaces` table (optional — can be skipped)
  - `setupComplete = admin && llm` (confluence is optional)

- `POST /api/setup/admin` (public, only works when no admin exists)
  - Body: `{ email, password, name }`
  - Creates admin user, returns JWT tokens
  - Returns 409 if admin already exists

- `POST /api/setup/llm-test` (requires auth)
  - Body: `{ provider, baseUrl, apiKey?, model? }`
  - Tests LLM connection, returns success/failure
  - Does NOT persist — just validates

#### 4.2 Frontend: Wizard feature

Create `frontend/src/features/setup/`:

```
frontend/src/features/setup/
├── SetupWizard.tsx           # Main wizard container with stepper
├── steps/
│   ├── WelcomeStep.tsx       # Compendiq logo, "Let's get started"
│   ├── AdminStep.tsx         # Create admin account form
│   ├── LlmStep.tsx           # Configure LLM (detect Ollama, or API key)
│   ├── ConfluenceStep.tsx    # Connect Confluence (optional, "Skip for now")
│   └── CompleteStep.tsx      # "You're all set!" with next steps
└── SetupWizard.test.tsx
```

**Wizard flow:**
1. **Welcome** — Product name, version, brief description, "Start Setup" button
2. **Admin Account** — Email, password, confirm password, display name. On submit: `POST /api/setup/admin`
3. **LLM Configuration** — Auto-detect Ollama at localhost:11434. If found: "Ollama detected!" + model selection. If not: form for provider (Ollama/OpenAI), base URL, API key. Test connection button. Saves to admin settings.
4. **Confluence** (optional) — "Connect later" prominent. URL + PAT fields. Connection test. Space selection if connected.
5. **Complete** — Summary of what's configured. Links to: "Browse Pages", "Open Admin Panel", "Read User Guide"

**Route:** `/setup` — only accessible when `setupComplete === false`. Redirect to `/` if setup is done.

#### 4.3 Frontend: Setup route guard

In the router config (`providers/RouterProvider.tsx` or equivalent):
- Before rendering the main app, check `/api/health/setup-status`
- If `setupComplete === false`, redirect all routes to `/setup`
- If `setupComplete === true`, `/setup` redirects to `/`

#### 4.4 Re-run from admin panel

- Add "Re-run Setup Wizard" button in Admin > Settings
- Opens the wizard at Step 3 (LLM) — admin account step is skipped since user is already logged in

#### 4.5 Tests

- Backend: setup-status returns correct booleans, admin creation works once, 409 on duplicate
- Frontend: wizard renders all steps, navigation works, skip buttons work

---

### Stream 5: One-Command Installer
**Effort:** ~2 days | **Priority:** Critical | **Week:** 3

#### 5.1 Create install.sh

Location: `scripts/install.sh`

```bash
#!/usr/bin/env bash
# Compendiq One-Command Installer
# Usage: curl -fsSL https://get.compendiq.app/install.sh | bash

set -euo pipefail

INSTALL_DIR="${COMPENDIQ_DIR:-$HOME/compendiq}"
COMPOSE_VERSION="latest"
```

Steps:
1. Check Docker is installed and running (exit with helpful message if not)
2. Check Docker Compose v2 (`docker compose version`)
3. Create `$INSTALL_DIR` (default: `~/compendiq/`)
4. Generate cryptographically secure random secrets:
   - `JWT_SECRET` (64 chars, `openssl rand -base64 48`)
   - `PAT_ENCRYPTION_KEY` (64 chars)
   - `POSTGRES_PASSWORD` (32 chars)
   - `REDIS_PASSWORD` (32 chars)
5. Write `.env` from template with generated secrets
6. Write `docker-compose.yml` (production config, pinned image versions)
7. Pull images (`docker compose pull`)
8. Start services (`docker compose up -d`)
9. Wait for health check (`curl --retry 30 --retry-delay 2 http://localhost:8081/api/health/ready`)
10. Print success message with URL (http://localhost:8081)
11. Open browser if possible (`open` on macOS, `xdg-open` on Linux)

#### 5.2 Docker Hub image publishing

Update `.github/workflows/docker-build.yml`:
- Trigger on git tags (`v*`)
- Build multi-arch images (amd64 + arm64) using `docker buildx`
- Push to Docker Hub (`diinlu/compendiq-backend`, `diinlu/compendiq-frontend`)
- Push to GHCR as mirror (`ghcr.io/laboef1900/compendiq-backend`, etc.)
- Tag with: `latest`, semver (`1.0.0`), major (`1`)

#### 5.3 Test the installer

- Test on: Ubuntu 22.04 (VM/container), macOS (local), WSL2
- Measure time from `curl | bash` to setup wizard appearing (target: < 3 min)

---

### Week 3–4: Polish (Streams 6–7)

---

### Stream 6: GitHub Repository Preparation
**Effort:** ~1 day | **Priority:** High | **Week:** 3

#### 6.1 Issue templates

Create `.github/ISSUE_TEMPLATE/`:

**bug-report.yml** (YAML form):
- Title prefix: `[Bug]`
- Fields: description, steps to reproduce, expected vs actual, version, platform, logs

**feature-request.yml**:
- Title prefix: `[Feature]`
- Fields: description, use case, proposed solution

**config.yml**:
- Blank issue option enabled
- Security vulnerability → link to SECURITY.md

#### 6.2 PR template

Create `.github/pull_request_template.md`:
- Summary section
- Checklist: tests pass, typecheck clean, docs updated, screenshots (if UI)
- Related issues field

#### 6.3 CODEOWNERS

```
# Default
* @laboef1900

# Backend
backend/ @laboef1900
packages/ @laboef1900

# Frontend
frontend/ @laboef1900
```

#### 6.4 Branch protection (manual in GitHub UI)

Document in `CONTRIBUTING.md`:
- `main`: require PR, require CI pass, require 1 review
- `dev`: require PR, require CI pass

#### 6.5 Update CI workflows

- `pr-check.yml`: add `npm test` (currently only typecheck + lint)
- Add badge to README: CI status, license, Docker pulls

---

### Stream 7: Quality & Test Coverage
**Effort:** ~3 days | **Priority:** High | **Week:** 3–4

#### 7.1 Backend coverage audit

Run coverage report:
```bash
cd backend && npx vitest run --coverage
```

Identify routes with < 70% coverage. Priority targets:
- `routes/knowledge/pages-crud.ts` (largest, most critical)
- `routes/llm/llm-chat.ts` (SSE streaming)
- `routes/confluence/sync.ts` (sync pipeline)

#### 7.2 E2E test expansion

Current: 1 E2E test (`e2e/sse.spec.ts`). Target: 5 critical path tests.

Create in `e2e/`:

| Test | What it covers |
|------|---------------|
| `auth.spec.ts` | Register → login → access protected route → logout |
| `pages-crud.spec.ts` | Create page → edit → add tag → search → delete |
| `ai-chat.spec.ts` | Open AI mode → ask question → verify streaming response |
| `settings.spec.ts` | Navigate to settings → verify LLM config panel loads |
| `keyboard-shortcuts.spec.ts` | Press ? → modal opens → press Escape → modal closes |

Each test should:
- Use Playwright's `test.describe` for grouping
- Clean up test data after each run
- Skip if required services are unavailable (e.g., LLM)

#### 7.3 Frontend component test gaps

Priority untested components:
- Setup wizard (new, from Stream 4)
- Admin panel pages
- AI chat interface

#### 7.4 Performance baseline

Run with 1,000 test pages:
```bash
# Seed test data
cd backend && npx tsx scripts/seed-test-data.ts --pages=1000

# Measure hybrid search latency
curl -w "@curl-format.txt" "http://localhost:3051/api/search?q=test&mode=hybrid"
```

Target: p99 < 500ms for hybrid search with 1,000 pages.

---

## User-Facing Documentation (Stream 3 continued, Week 4)

### 3.5 Admin Guide (`docs/ADMIN-GUIDE.md`)

Sections:
1. System requirements (Docker, 4GB RAM min, 20GB disk)
2. Installation (link to install.sh)
3. Configuration reference (all env vars, grouped)
4. Upgrade procedure (`docker compose pull && docker compose up -d`)
5. Backup strategy (PostgreSQL dump, attachments volume)
6. Monitoring (health endpoints, log levels)
7. Troubleshooting (common issues + solutions)

### 3.6 User Guide (`docs/USER-GUIDE.md`)

Sections:
1. Getting started (login, first page)
2. Connecting Confluence
3. Working with pages (create, edit, organize)
4. Using AI features (Q&A, improve, summarize)
5. Keyboard shortcuts
6. Search (keyword, semantic, hybrid)
7. Knowledge graph

### 3.7 API Reference

Options (choose one):
- **Auto-generate from Fastify schemas**: Use `@fastify/swagger` + `@fastify/swagger-ui` to generate OpenAPI spec at `/api/docs`
- **Manual**: `docs/API.md` with curl examples for top 20 endpoints

Recommended: `@fastify/swagger` — auto-generates from existing Zod schemas, stays in sync.

---

## Week 5: Integration & Launch Prep

- [ ] Full end-to-end test: fresh install → setup wizard → create page → AI chat → export
- [ ] Run security audit checklist one final time
- [ ] Tag `v1.0.0-rc.1`, build images, test installer from published images
- [ ] Final README polish with screenshots/GIF
- [ ] Create GitHub Release draft with CHANGELOG content
- [ ] Resolve all Open Decisions from roadmap §8

---

## Implementation Schedule

```
Week 1 (Mar 23–29):
  ├── Stream 1: Enterprise gating (3d)
  ├── Stream 2: Security audit (2d)
  └── Stream 3: CONTRIBUTING, SECURITY, CHANGELOG (2d)

Week 2 (Mar 30 – Apr 5):
  ├── Stream 4: Setup wizard — backend API (2d)
  └── Stream 4: Setup wizard — frontend (3d)

Week 3 (Apr 6–12):
  ├── Stream 4: Setup wizard — polish + tests (1d)
  ├── Stream 5: Installer script + Docker Hub CI (2d)
  └── Stream 6: GitHub templates + CI update (1d)

Week 4 (Apr 13–19):
  ├── Stream 7: Test coverage expansion (3d)
  ├── Stream 3: Admin Guide + User Guide (2d)
  └── Stream 3: API docs (1d)

Week 5 (Apr 20–26):
  ├── Integration testing (2d)
  ├── Final polish + README (1d)
  └── v1.0.0-rc.1 tag + launch prep (2d)
```

---

## Dependencies

```
Stream 1 (Enterprise Gating)
  └── blocks: Stream 3.4 (.env.example update)

Stream 2 (Security Audit)
  └── independent, can run anytime in Week 1

Stream 3 (Documentation)
  └── Stream 3.5-3.7 (guides) depend on Stream 4 (wizard) being done

Stream 4 (Setup Wizard)
  └── blocks: Stream 5 (installer needs wizard endpoint)
  └── blocks: Stream 3.5-3.7 (guides reference wizard)

Stream 5 (Installer)
  └── depends on: Stream 4 (wizard endpoint exists)
  └── depends on: Docker Hub CI (Stream 6.5)

Stream 6 (GitHub Config)
  └── independent

Stream 7 (Test Coverage)
  └── depends on: Stream 4 (wizard tests)
```

---

## Definition of Done

All five market-readiness gates from the roadmap must pass:

1. **Functional** — Community features work end-to-end, no critical bugs
2. **Security** — Audit pass, no critical/high CVEs, auth hardened
3. **Operational** — New user: zero to running in < 15 minutes via installer; wizard completes without support
4. **Documentation** — Admin guide, user guide, API reference, .env.example complete
5. **Distribution** — Docker Hub images published, GitHub releases tagged, installer works on macOS, Linux, WSL2

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Setup wizard takes longer than 5 days | Cut scope: skip Confluence step (defer to settings), simplify to 3 steps (admin, LLM, done) |
| Security audit reveals critical issue | Reserve 2 days buffer in Week 5 for remediation |
| Docker Hub CI multi-arch build fails on arm64 | Fall back to amd64-only for v1.0; add arm64 in v1.0.1 |
| Test coverage target not met | Focus on critical path coverage; defer non-critical routes to post-launch |
| Installer fails on WSL2 | Document WSL2 workarounds; prioritize native Linux + macOS |
