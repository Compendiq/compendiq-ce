# Security Hardening Audit

**Date:** 2026-03-22
**Auditor:** Claude Opus 4.6 (automated) + human review
**Scope:** Full backend route audit, dependency audit, CORS, auth coverage, startup validation, debug route review
**Issue:** #539

---

## 1. Dependency Audit

### npm audit results

| Package | Severity | Status |
|---------|----------|--------|
| `flatted` (<=3.4.1) | **High** — unbounded recursion DoS + prototype pollution | **Fixed** via `npm audit fix` |
| `tmp` (<=0.2.3) | Low — symlink dir parameter | Accepted risk (see below) |
| `external-editor` | Low — depends on vulnerable `tmp` | Accepted risk (see below) |
| `inquirer` (3.0.0-9.3.7) | Low — depends on vulnerable `external-editor` | Accepted risk (see below) |
| `@lhci/cli` | Low — depends on vulnerable `inquirer` + `tmp` | Accepted risk (see below) |

### Accepted risks

All 4 remaining low-severity vulnerabilities are in `@lhci/cli` (Lighthouse CI), which is a **root-level devDependency** used only for local performance testing. It is:
- Not included in production Docker images (multi-stage build excludes devDependencies)
- Not imported by any backend or frontend production code
- Only invoked via `npm run lighthouse` CLI command

**Risk:** None in production. Acceptable for development use.

---

## 2. SQL Injection Spot-Audit

### Methodology

Audited all `query()` calls across every route file in `backend/src/routes/`. Checked 100+ SQL queries total.

### Files audited

| File | Queries | Status |
|------|---------|--------|
| `routes/foundation/auth.ts` | 6 | PASS -- all parameterized ($1, $2) |
| `routes/foundation/settings.ts` | 10 | PASS -- dynamic SET clauses use `$${paramIdx++}` counters |
| `routes/foundation/admin.ts` | 12 | PASS -- all parameterized |
| `routes/foundation/rbac.ts` | 20+ | PASS -- all parameterized |
| `routes/foundation/oidc.ts` | 0 (delegates to service) | PASS |
| `routes/foundation/notifications.ts` | 0 (delegates to service) | PASS |
| `routes/confluence/spaces.ts` | 2 | PASS -- uses `ANY($1::text[])` |
| `routes/confluence/sync.ts` | 0 (delegates to service) | PASS |
| `routes/confluence/attachments.ts` | 2 | PASS -- parameterized |
| `routes/llm/llm-chat.ts` | 6 | PASS -- all parameterized |
| `routes/llm/llm-conversations.ts` | 8 | PASS -- all parameterized |
| `routes/llm/llm-embeddings.ts` | 4 | PASS -- all parameterized |
| `routes/llm/llm-models.ts` | 0 | PASS |
| `routes/llm/llm-admin.ts` | 0 | PASS |
| `routes/llm/llm-pdf.ts` | 0 | PASS |
| `routes/knowledge/pages-crud.ts` | 15+ | PASS -- all parameterized; ILIKE uses `escapeIlikeTerm()` |
| `routes/knowledge/search.ts` | 8 | PASS -- parameterized; LIKE metacharacters escaped |
| `routes/knowledge/pages-versions.ts` | 6 | PASS -- all parameterized |
| `routes/knowledge/pages-tags.ts` | 6 | PASS -- all parameterized |
| `routes/knowledge/pages-embeddings.ts` | 10 | PASS -- all parameterized |
| `routes/knowledge/pages-duplicates.ts` | 0 (delegates to service) | PASS |
| `routes/knowledge/pinned-pages.ts` | 6 | PASS -- all parameterized |
| `routes/knowledge/analytics.ts` | 4 | PASS -- parameterized with `String(daysNum)` |
| `routes/knowledge/knowledge-admin.ts` | 2 | PASS -- parameterized |
| `routes/knowledge/templates.ts` | 8 | PASS -- dynamic SET uses `$${paramIdx++}` |
| `routes/knowledge/pages-export.ts` | 2 | PASS -- uses positional placeholders array |
| `routes/knowledge/comments.ts` | 14 | PASS -- all parameterized |
| `routes/knowledge/pages-import.ts` | 1 | PASS -- parameterized |
| `routes/knowledge/content-analytics.ts` | 8 | PASS -- all parameterized |
| `routes/knowledge/verification.ts` | 6 | PASS -- all parameterized |
| `routes/knowledge/knowledge-requests.ts` | 8 | PASS -- dynamic SET uses `$${paramIdx++}` |
| `routes/knowledge/local-spaces.ts` | 12 | PASS -- all parameterized |

### Dynamic SQL patterns found (all safe)

1. **Dynamic SET clauses** (`settings.ts`, `rbac.ts`, `templates.ts`, `knowledge-requests.ts`, `local-spaces.ts`): Build `SET col = $N` arrays from Zod-validated fields. Column names are hardcoded strings; only parameter indices are interpolated.

2. **Freshness filter** (`pages-crud.ts`): Maps Zod-validated enum values to hardcoded SQL interval expressions. The enum value is used as a map key, never interpolated into SQL.

3. **ILIKE search** (`pages-crud.ts`, `search.ts`): User input is escaped via `escapeIlikeTerm()` which handles `%`, `_`, and `\` metacharacters. Uses `ESCAPE '\\'` clause.

4. **Dynamic WHERE conditions** (`search.ts`): Built from parameterized conditions array. User values always go through `$N` placeholders.

**Result: PASS -- No SQL injection vulnerabilities found.**

---

## 3. Auth Coverage Check

### Methodology

Verified every route file for authentication hooks (`onRequest`, `preHandler`) or explicit exemption.

### Route authentication matrix

| Route File | Auth Method | Status |
|------------|------------|--------|
| `health.ts` | None (exempt) | PASS -- health probes must be unauthenticated |
| `auth.ts` /register, /login | None (exempt) | PASS -- auth endpoints |
| `auth.ts` /refresh | None (cookie-based) | PASS -- uses refresh token cookie |
| `auth.ts` /logout | None (best-effort) | PASS -- graceful logout |
| `auth.ts` /cleanup-tokens | `preHandler: fastify.requireAdmin` | PASS |
| `settings.ts` | `fastify.addHook('onRequest', fastify.authenticate)` | PASS |
| `admin.ts` | `fastify.addHook('onRequest', fastify.requireAdmin)` | PASS |
| `rbac.ts` /permissions/* | `onRequest: fastify.authenticate` per route | PASS |
| `rbac.ts` admin routes | `admin.addHook('onRequest', admin.requireAdmin)` | PASS |
| `oidc.ts` /auth/oidc/config | None (exempt) | PASS -- login page needs this |
| `oidc.ts` /auth/oidc/authorize | None (exempt) | PASS -- IdP redirect |
| `oidc.ts` /auth/oidc/callback | None (exempt) | PASS -- IdP callback |
| `oidc.ts` /auth/oidc/exchange | None (exempt) | PASS -- one-time code exchange |
| `oidc.ts` /auth/oidc/logout | `onRequest: [fastify.authenticate]` | PASS |
| `oidcAdminRoutes` | `fastify.addHook('onRequest', fastify.requireAdmin)` | PASS |
| `notifications.ts` | `fastify.addHook('onRequest', fastify.authenticate)` | PASS |
| `spaces.ts` | `fastify.addHook('onRequest', fastify.authenticate)` | PASS |
| `sync.ts` | `fastify.addHook('onRequest', fastify.authenticate)` | PASS |
| `attachments.ts` | `fastify.addHook('onRequest', fastify.authenticate)` | PASS |
| `llm-chat.ts` | `fastify.addHook('onRequest', fastify.authenticate)` | PASS |
| `llm-conversations.ts` | `fastify.addHook('onRequest', fastify.authenticate)` | PASS |
| `llm-embeddings.ts` | `fastify.addHook('onRequest', fastify.authenticate)` | PASS |
| `llm-models.ts` | `fastify.addHook('onRequest', fastify.authenticate)` | PASS |
| `llm-admin.ts` | `fastify.addHook('onRequest', fastify.authenticate)` + `preHandler: fastify.requireAdmin` per route | PASS |
| `llm-pdf.ts` | `fastify.addHook('onRequest', fastify.authenticate)` | PASS |
| `pages-crud.ts` | `fastify.addHook('onRequest', fastify.authenticate)` | PASS |
| `pages-versions.ts` | `fastify.addHook('onRequest', fastify.authenticate)` | PASS |
| `pages-tags.ts` | `fastify.addHook('onRequest', fastify.authenticate)` | PASS |
| `pages-embeddings.ts` | `fastify.addHook('onRequest', fastify.authenticate)` | PASS |
| `pages-duplicates.ts` | `fastify.addHook('onRequest', fastify.authenticate)` | PASS |
| `pinned-pages.ts` | `fastify.addHook('onRequest', fastify.authenticate)` | PASS |
| `analytics.ts` | `fastify.addHook('onRequest', fastify.requireAdmin)` | PASS |
| `knowledge-admin.ts` | `fastify.addHook('onRequest', fastify.authenticate)` + admin per route | PASS |
| `templates.ts` | `fastify.addHook('onRequest', fastify.authenticate)` | PASS |
| `pages-export.ts` | `fastify.addHook('onRequest', fastify.authenticate)` | PASS |
| `comments.ts` | `fastify.addHook('onRequest', fastify.authenticate)` | PASS |
| `pages-import.ts` | `fastify.addHook('onRequest', fastify.authenticate)` | PASS |
| `content-analytics.ts` | `fastify.addHook('onRequest', fastify.authenticate)` | PASS |
| `verification.ts` | `fastify.addHook('onRequest', fastify.authenticate)` | PASS |
| `knowledge-requests.ts` | `fastify.addHook('onRequest', fastify.authenticate)` | PASS |
| `search.ts` | `fastify.addHook('onRequest', fastify.authenticate)` | PASS |
| `local-spaces.ts` | `fastify.addHook('onRequest', fastify.authenticate)` | PASS |

### Exempt routes (by design)

- `/api/health/*` -- Kubernetes probes (liveness, readiness, startup)
- `/api/auth/login` -- Login endpoint
- `/api/auth/register` -- Registration endpoint
- `/api/auth/refresh` -- Token refresh (uses httpOnly cookie)
- `/api/auth/logout` -- Logout (best-effort, no auth required)
- `/api/auth/oidc/config` -- Public OIDC configuration for login page
- `/api/auth/oidc/authorize` -- IdP redirect initiation
- `/api/auth/oidc/callback` -- IdP callback handler
- `/api/auth/oidc/exchange` -- One-time login code exchange

**Result: PASS -- All routes have appropriate authentication.**

---

## 4. CORS Verification

### Configuration (app.ts)

```typescript
await app.register(cors, {
  origin: process.env.FRONTEND_URL ?? 'http://localhost:5273',
  credentials: true,
});
```

### Findings

- **PASS:** `FRONTEND_URL` env var is used for CORS origin in production.
- **PASS:** No `origin: '*'` found anywhere in the codebase.
- **PASS:** `credentials: true` is set, which browsers enforce strictly (wildcard origin is rejected when credentials are enabled).
- **PASS:** Default fallback `http://localhost:5273` is only used in development (production must set `FRONTEND_URL`).

**Result: PASS**

---

## 5. Startup Secret Validation

### Configuration (index.ts)

```typescript
if (process.env.NODE_ENV === 'production') {
  const jwtSecret = process.env.JWT_SECRET ?? '';
  const patKey = process.env.PAT_ENCRYPTION_KEY ?? '';
  if (jwtSecret.length < 32 || jwtSecret.startsWith('change-me')) {
    throw new Error('JWT_SECRET must be at least 32 chars and not default in production');
  }
  if (patKey.length < 32 || patKey.startsWith('change-me')) {
    throw new Error('PAT_ENCRYPTION_KEY must be at least 32 chars and not default in production');
  }
}
```

### Additional validation (auth.ts plugin)

```typescript
function getJwtSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters');
  }
  return new TextEncoder().encode(secret);
}
```

### Findings

- **PASS:** Production startup throws if `JWT_SECRET` < 32 chars or starts with `change-me`.
- **PASS:** Production startup throws if `PAT_ENCRYPTION_KEY` < 32 chars or starts with `change-me`.
- **PASS:** Auth plugin independently validates JWT_SECRET length at runtime.
- **PASS:** Server binds to `127.0.0.1` in development, `0.0.0.0` in production (correct for Docker).

**Result: PASS**

---

## 6. Debug/Dev Route Review

### Swagger UI exposure

- **FINDING:** Swagger UI (`/api/docs`) was registered unconditionally, exposing the full API schema in production without authentication. This is an information disclosure risk.
- **FIX APPLIED:** Swagger and Swagger UI are now only registered when `NODE_ENV !== 'production'` (see `app.ts`).

### Console.log statements

- **PASS:** No `console.log`, `console.warn`, `console.error`, or `console.debug` calls found in any route handler or production code. All logging uses the structured `pino` logger.

### Test/debug endpoints

- **PASS:** No test endpoints, debug routes, or development-only routes found in production code.
- **PASS:** All admin-only endpoints properly gated behind `requireAdmin`.

**Result: PASS (after fix)**

---

## 7. Pre-existing Security Controls (Verified)

### Rate limiting

| Endpoint group | Rate limit | Status |
|---------------|-----------|--------|
| Auth routes (/login, /register) | 5 req/min | PASS |
| Admin routes | 20 req/min | PASS |
| OIDC routes | 10 req/min | PASS |
| RBAC admin routes | 30 req/min | PASS |
| LLM streaming routes | 10 req/min | PASS |
| Embedding routes | 5 req/min | PASS |
| PDF extraction | 5 req/min | PASS |
| Global default | 100 req/min | PASS |

### SSRF guard (ssrf-guard.ts)

- **PASS:** Blocks all RFC 1918 private IPv4 ranges (10.x, 172.16-31.x, 192.168.x)
- **PASS:** Blocks IPv6 loopback (::1), unspecified (::), unique local (fc00::/7, fd00::/8), link-local (fe80::/10)
- **PASS:** Blocks IPv4-mapped IPv6 addresses (::ffff:127.0.0.1, ::ffff:7f00:1)
- **PASS:** Blocks internal hostnames (localhost, metadata.google.internal, instance-data)
- **PASS:** Blocks internal TLD suffixes (.local, .internal, .localhost, .corp, .home, .lan)
- **PASS:** Blocks CGNAT range (100.64.0.0/10)
- **PASS:** Only allows HTTP and HTTPS protocols
- **PASS:** Allowlist for user-configured Confluence URLs (authenticated source)
- **PASS:** DNS rebinding limitation documented in code comments

### LLM prompt injection sanitizer (sanitize-llm-input.ts)

- **PASS:** Detects and filters system prompt manipulation patterns
- **PASS:** Detects role hijacking attempts
- **PASS:** Strips ChatML-like tags
- **PASS:** Detects prompt leaking attempts
- **PASS:** Detects delimiter injection
- **PASS:** Logs all injection attempts with audit trail
- **PASS:** Used on all LLM input paths (improve, generate, summarize, ask, diagram, quality, PDF extract)

### PAT encryption (crypto.ts)

- **PASS:** AES-256-GCM encryption for Confluence PATs
- **PASS:** PATs never sent to frontend (only `hasConfluencePat` boolean)
- **PASS:** Key rotation endpoint available (`/admin/rotate-encryption-key`)
- **PASS:** Re-encryption function supports key versioning

### JWT auth with refresh token rotation

- **PASS:** HS256 signing with configurable expiry
- **PASS:** Refresh tokens stored in database with JTI tracking
- **PASS:** Token family tracking for reuse detection
- **PASS:** Automatic family revocation on reuse (security breach response)
- **PASS:** Refresh token cookie: httpOnly, secure (in production), sameSite=strict, path-scoped
- **PASS:** OIDC callback uses sameSite=lax (required for cross-origin IdP redirect)

### Input validation

- **PASS:** Zod schemas from `@atlasmind/contracts` on all API boundaries
- **PASS:** File upload validation (magic bytes, MIME type, size limits) for PDF and image uploads
- **PASS:** DOMPurify sanitization on imported Markdown HTML output
- **PASS:** SVG attachments served with `Content-Security-Policy: sandbox` and `Content-Disposition: attachment`
- **PASS:** ILIKE metacharacters escaped in search queries

### Open redirect prevention (oidc.ts)

- **PASS:** `buildFrontendRedirect()` uses only server-controlled `FRONTEND_URL` + hardcoded paths
- **PASS:** Login codes stored in Redis with 60s TTL and atomic get-and-delete
- **PASS:** No user-controlled redirect URLs

---

## 8. Issues Found and Fixed

| # | Severity | Issue | Status |
|---|----------|-------|--------|
| 1 | Medium | Swagger UI (`/api/docs`) exposed in production without authentication | **FIXED** -- gated behind `NODE_ENV !== 'production'` |
| 2 | High | `flatted` package vulnerable to DoS + prototype pollution | **FIXED** -- updated via `npm audit fix` |

---

## 9. Summary

| Category | Result |
|----------|--------|
| 2.1 Dependency audit | PASS (1 high fixed, 4 low accepted) |
| 2.2 SQL injection spot-audit | PASS (100+ queries, all parameterized) |
| 2.3 Auth coverage check | PASS (all routes authenticated or exempt) |
| 2.4 CORS verification | PASS (origin from env var, no wildcard) |
| 2.5 Startup secret validation | PASS (rejects weak/default secrets in production) |
| 2.6 Debug/dev route review | PASS (after Swagger fix) |
| Rate limiting | PASS (all sensitive endpoints rate-limited) |
| SSRF protection | PASS (comprehensive IP/hostname/protocol blocking) |
| LLM prompt injection | PASS (sanitization on all input paths) |
| PAT encryption | PASS (AES-256-GCM with rotation support) |
| JWT/auth security | PASS (rotation, reuse detection, family revocation) |
| Input validation | PASS (Zod schemas, file validation, DOMPurify) |
| Open redirect | PASS (hardcoded paths, no user-controlled redirects) |

**Overall assessment: The codebase demonstrates strong security practices. Two issues were found and fixed during this audit.**
