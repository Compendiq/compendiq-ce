# Multi-LLM-Provider Configuration — Design

**Date:** 2026-04-20
**Status:** Draft — pending implementation plan
**Scope:** `compendiq-ce` (backend + frontend + contracts)
**Supersedes:** Parts of issue #214 (per-use-case assignments); the two-slot `llm_provider` model in `admin_settings_service`.

---

## 1. Motivation

Today Compendiq stores exactly two LLM "slots" in `admin_settings`:

- **Ollama** — `OLLAMA_BASE_URL` env var + `ollama_model` setting.
- **OpenAI-compatible** — `openai_base_url` + `openai_api_key` + `openai_model` settings.

Per-use-case assignments (chat / summary / quality / auto_tag — issue #214) can
only pick between those two slots. Embedding is a single global `embedding_model`
piggy-backing on whichever slot is active.

Operators need to wire different LLM servers to different workloads — e.g. a
local GPU box for chat, a cloud OpenAI endpoint for batch summary work, a
different model entirely for embeddings — without contorting the two-slot model.
This spec defines the admin-managed multi-provider replacement.

## 2. Scope decisions (locked with the user)

| # | Question | Decision |
|---|----------|----------|
| Q1 | Provider cardinality & types | **N named providers, single type `openai-compatible`.** No separate `ollama` type — Ollama exposes `/v1/chat/completions`, `/v1/embeddings`, `/v1/models` and every other backend already speaks this protocol. |
| Q2 | Embedding as a use case | **Fifth use case with re-embed guardrail.** Changing provider/model shows a confirmation and surfaces a "Re-embed all pages" action afterwards. |
| Q3 | Admin-only vs per-user | **Admin-only.** Matches the current model; background workers have no user context; user-level overrides are an explicit future scope item. |
| Q4 | Shared-default / inheritance | **`is_default` provider + `default_model` per provider.** Use cases can inherit (both `NULL` in the DB) or override provider-only or provider+model. |
| Q5 | Delete semantics | **Block deletion when referenced or when `is_default`.** Admin must reassign use cases first. `ON DELETE RESTRICT` FK enforces this at the DB level. |

## 3. Data model

Two new tables replace the flat `admin_settings` keys for LLM configuration.

### 3.1 `llm_providers`

```sql
CREATE TABLE llm_providers (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT         NOT NULL UNIQUE,
  base_url       TEXT         NOT NULL,                    -- normalized to end with /v1
  api_key        TEXT         NULL,                        -- AES-256-GCM via encryptPat()
  auth_type      TEXT         NOT NULL DEFAULT 'bearer',   -- 'bearer' | 'none'
  verify_ssl     BOOLEAN      NOT NULL DEFAULT TRUE,
  default_model  TEXT         NULL,
  is_default     BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Exactly one default row, at most.
CREATE UNIQUE INDEX llm_providers_one_default
  ON llm_providers (is_default) WHERE is_default;
```

### 3.2 `llm_usecase_assignments`

```sql
CREATE TABLE llm_usecase_assignments (
  usecase      TEXT         PRIMARY KEY,                   -- 'chat' | 'summary' | 'quality' | 'auto_tag' | 'embedding'
  provider_id  UUID         NULL REFERENCES llm_providers(id) ON DELETE RESTRICT,
  model        TEXT         NULL,
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CHECK (usecase IN ('chat', 'summary', 'quality', 'auto_tag', 'embedding'))
);
```

**Resolution rules** (pure function, no cache):

| `provider_id` | `model` | Resolved provider | Resolved model |
|---------------|---------|-------------------|----------------|
| `NULL` | `NULL` | the `is_default` row | that row's `default_model` |
| set   | `NULL` | the referenced row    | that row's `default_model` |
| set   | set    | the referenced row    | the override string |
| `NULL` | set   | the `is_default` row | the override string (rare; legal) |

If no default exists (fresh install, nothing configured), the resolver returns
an error surfaced as a 503 by the API boundary so workers can back off.

### 3.3 Removed `admin_settings` keys

Deleted by migration `054` after seeding the new tables:

- `llm_provider`
- `ollama_model`
- `openai_base_url`
- `openai_api_key`
- `openai_model`
- `embedding_model`
- `llm_usecase_chat_provider`, `llm_usecase_chat_model`
- `llm_usecase_summary_provider`, `llm_usecase_summary_model`
- `llm_usecase_quality_provider`, `llm_usecase_quality_model`
- `llm_usecase_auto_tag_provider`, `llm_usecase_auto_tag_model`

Retained (non-LLM-provider): `embedding_dimensions`, `fts_language`, SMTP,
OIDC, license, AI safety flags, all others.

## 4. Backend API

New routes under `backend/src/routes/llm/`, split into two files:

### 4.1 `llm-providers.ts`

```
GET    /api/admin/llm-providers                  list  (api_key masked)
POST   /api/admin/llm-providers                  create
PATCH  /api/admin/llm-providers/:id              partial update (omit apiKey = keep)
DELETE /api/admin/llm-providers/:id              409 if referenced or is_default
POST   /api/admin/llm-providers/:id/set-default  atomic flip of is_default
POST   /api/admin/llm-providers/:id/test         { connected, error?, sampleModelsCount }
GET    /api/admin/llm-providers/:id/models       passthrough /v1/models -> [{ name }]
```

List/GET responses use shape:

```ts
interface LlmProviderDTO {
  id: string;
  name: string;
  baseUrl: string;
  authType: 'bearer' | 'none';
  verifySsl: boolean;
  defaultModel: string | null;
  isDefault: boolean;
  hasApiKey: boolean;
  keyPreview: string | null;   // e.g. "…ab12", never full key
  createdAt: string;
  updatedAt: string;
}
```

### 4.2 `llm-usecases.ts`

```
GET /api/admin/llm-usecases  -> {
  [usecase]: {
    providerId: string | null,   // raw override
    model: string | null,        // raw override
    resolved: {                  // what the resolver would return right now
      providerId: string,
      providerName: string,
      model: string,
    }
  }
}

PUT /api/admin/llm-usecases  -> batch upsert using same {undefined = leave,
                                null = clear, value = set} tri-state semantics
                                as today's upsertUsecaseLlmAssignments.
```

### 4.3 Embedding guardrail

```
POST /api/admin/embedding/reembed  -> { jobId: string, pageCount: number }
```

Enqueues a full re-embed through the existing BullMQ embedding worker. Called
by the frontend after the user confirms the re-embed dialog. Idempotent:
re-invoking while a job is pending returns the existing `jobId`.

### 4.4 Contracts

`packages/contracts/src/llm.ts` adds:

- `LlmProviderSchema`, `LlmProviderInputSchema`, `LlmProviderUpdateSchema`
- `UsecaseAssignmentSchema`, `UsecaseAssignmentsSchema`, `UpdateUsecaseAssignmentsSchema`
  (rewritten to key off `providerId` instead of the old `'ollama' | 'openai'` union)
- `LlmUsecase = 'chat' | 'summary' | 'quality' | 'auto_tag' | 'embedding'`

### 4.5 Auth, validation, rate limiting

- Every `/api/admin/llm-*` route: `fastify.authenticate` + admin-role gate.
- Zod validation on path + body + query using `@compendiq/contracts` schemas.
- `/test` and `/models` routes rate-limited via the existing Fastify rate-limit
  plugin (same bucket as other admin discovery endpoints).
- `baseUrl` validated through `core/utils/ssrf-guard.ts`; rejects loopback +
  RFC1918 unless `LLM_ALLOW_PRIVATE_URLS=true` (already-in-use escape hatch).

## 5. Service layer & resolver

### 5.1 Collapse the provider-specific services

Remove:

- `backend/src/domains/llm/services/ollama-service.ts`
- `backend/src/domains/llm/services/ollama-provider.ts`
- `backend/src/domains/llm/services/openai-service.ts`

Replace with `backend/src/domains/llm/services/openai-compatible-client.ts`
exporting pure functions that take a config arg — no module-level caches of
URL / key:

```ts
export interface ProviderConfig {
  providerId: string;
  baseUrl: string;
  apiKey: string | null;
  authType: 'bearer' | 'none';
  verifySsl: boolean;
}

export async function* streamChat(cfg: ProviderConfig, model: string,
                                  messages: ChatMessage[], signal?: AbortSignal)
                                  : AsyncGenerator<StreamChunk>;
export async function chat(cfg: ProviderConfig, model: string,
                           messages: ChatMessage[]): Promise<string>;
export async function generateEmbedding(cfg: ProviderConfig, model: string,
                                        text: string | string[]): Promise<number[][]>;
export async function listModels(cfg: ProviderConfig): Promise<LlmModel[]>;
export async function checkHealth(cfg: ProviderConfig): Promise<HealthResult>;
```

A per-`providerId` `undici.Agent` is memoized in-module so TLS / keep-alive
isn't rebuilt per request. The cache is invalidated when a provider row is
updated or deleted (see §5.3).

### 5.2 Resolver

`backend/src/domains/llm/services/llm-provider-resolver.ts` exposes:

```ts
export async function getProvider(providerId: string): Promise<ProviderConfig>;
export async function resolveUsecase(usecase: LlmUsecase)
    : Promise<{ config: ProviderConfig; model: string }>;
export async function listProviders(): Promise<ProviderConfig[]>;
```

`resolveUsecase` runs a single `LEFT JOIN` against `llm_usecase_assignments` +
`llm_providers` + the default row, applies the §3.2 resolution rules in
memory, and returns the resolved config + model.

**No caching on the assignment row.** Every `resolveUsecase` call hits PG
(one indexed query). This preserves the "changes take effect without restart"
acceptance criterion that was explicit for issue #214 and carries forward.

**Provider config *is* cached** by `providerId` in memory. Any `PATCH`,
`DELETE`, or `set-default` write bumps a module-scoped `version` counter
and invalidates the cache.

### 5.3 Call-site migration

| Today | Replaced by |
|-------|-------------|
| `resolveUserProvider(userId)` | removed |
| `providerStreamChat(userId, ...)` | `resolveUsecase('chat')` + `streamChat(cfg, model, …)` |
| `providerStreamChatForUsecase('summary', ...)` | `resolveUsecase('summary')` + `streamChat(…)` |
| `providerChatForUsecase('auto_tag', ...)` | `resolveUsecase('auto_tag')` + `chat(…)` |
| `ollamaGenerateEmbedding(text)` / `openai.generateEmbedding(text)` | `resolveUsecase('embedding')` + `generateEmbedding(…)` |

Consumers to update: `llm-chat`, `llm-ask`, `llm-summarize`, `llm-quality`,
`llm-generate`, `llm-improve`, `llm-diagram`, `generate-with-pdf`,
`analyze-quality`, `apply-improvement`, `improve-instruction`,
`improve-page-id`, `summary-worker`, `quality-worker`, `auto-tagger`,
`embedding-service`, `rag-service`.

### 5.4 Env-var behavior

| Env var | Fate |
|---------|------|
| `OLLAMA_BASE_URL`, `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `LLM_BEARER_TOKEN` | Consulted **once** by the TS bootstrap in §6 to seed initial rows on a fresh install. Runtime reads are removed. A warning is logged if they are set on a later boot while `llm_providers` is already non-empty. |
| `LLM_VERIFY_SSL` | Default for the `verify_ssl` column on newly-created rows; the row value always wins at runtime. |
| `LLM_STREAM_TIMEOUT_MS`, `LLM_CONCURRENCY`, `LLM_MAX_QUEUE_DEPTH`, `LLM_CACHE_TTL`, `LLM_AUTH_TYPE` | Retained as operational knobs (not per-provider). `LLM_AUTH_TYPE` becomes a default for new rows only. |
| `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS` | Deprecated. `EMBEDDING_MODEL` is consulted once during migration seed. `EMBEDDING_DIMENSIONS` is inferred from the embedding use case's model at re-embed time (carried by the existing `admin_settings['embedding_dimensions']` row, which is retained). |
| `SUMMARY_MODEL`, `QUALITY_MODEL`, `DEFAULT_LLM_MODEL` | Consulted once during migration seed; warning logged if set afterwards. |

## 6. Frontend UI

Settings → LLM tab (`frontend/src/features/settings/panels/LlmTab.tsx`)
is reorganized into two stacked sections.

### 6.1 Providers section

```
┌────────────────────────────────────────────────────────────────┐
│ Providers                                           [+ Add]    │
├────────────────────────────────────────────────────────────────┤
│ ● GPU Box (Ollama)      http://gpu:11434/v1    [default]  ⋯   │
│ ● OpenAI Prod           https://api.openai.com/v1          ⋯   │
│ ● LM Studio (dev)       http://192.168.1.5:1234/v1         ⋯   │
└────────────────────────────────────────────────────────────────┘
```

- Status dot: green / red from the last `/test` call, grey when never tested.
- `[default]` badge on the `is_default` row.
- `⋯` menu: Edit · Set as default · Test · Delete. Delete is disabled with a
  tooltip showing the blocking use cases ("Referenced by: chat, summary").
- `[+ Add]` opens a modal with fields `name`, `baseUrl`, `apiKey` (masked),
  `authType` radio (Bearer / None), `verifySsl` toggle, `defaultModel`
  (dropdown; populated after a successful in-modal `Test`).
- Edit modal shows `keyPreview` + a "Replace key" action; the stored key is
  left alone unless explicitly replaced. Base URL changes are allowed; the
  resolver picks them up on the next call.

### 6.2 Use-case assignments section

```
Use case       │ Provider                     │ Model                   │ → Resolves to
───────────────┼──────────────────────────────┼─────────────────────────┼───────────────────────────
Chat           │ [Inherit default       ▼]    │ [Inherit provider's ▼]  │ GPU Box / qwen3:4b
Summary worker │ [OpenAI Prod           ▼]    │ [gpt-4o-mini        ▼]  │ OpenAI Prod / gpt-4o-mini
Quality worker │ [Inherit default       ▼]    │ —                       │ GPU Box / qwen3:4b
Auto-tag       │ [GPU Box (Ollama)      ▼]    │ [Inherit provider's ▼]  │ GPU Box / qwen3:4b
Embedding  ⚠   │ [GPU Box (Ollama)      ▼]    │ [bge-m3             ▼]  │ GPU Box / bge-m3
```

- Provider column lists all providers + "Inherit default".
- Model column lazily fetches that provider's `/v1/models` via `useQuery`
  keyed by `providerId`; no fetch for "Inherit" rows.
- The **Embedding row**:
  - Warning icon with tooltip: "Changing embedding model requires re-embedding
    all pages."
  - Changing provider or model disables Save until a confirmation modal is
    acknowledged: *"This will make all existing vectors (N pages) incompatible.
    You will need to re-embed. Continue?"*
  - After save, a banner at the section top offers "Re-embed all pages" and
    shows job progress from the existing embedding job status endpoint.

### 6.3 Files touched / added

| Path | Action |
|------|--------|
| `frontend/src/features/settings/panels/LlmTab.tsx` | Rewrite top half, keep the use-case grid shape, reshape data sources. |
| `frontend/src/features/settings/panels/ProviderListSection.tsx` | New. |
| `frontend/src/features/settings/panels/ProviderEditModal.tsx` | New. |
| `frontend/src/features/settings/panels/UsecaseAssignmentsSection.tsx` | Extract existing inner component; generalize to N providers. |
| `frontend/src/features/settings/panels/EmbeddingReembedBanner.tsx` | New. |
| `packages/contracts/src/llm.ts` | Add new schemas, rewrite `UsecaseAssignments` against `providerId`. |

Status colors honor ADR-010 (green / red / yellow / blue / purple / gray).
Framer Motion entrance animations reuse the staggered pattern from neighboring
panels. Backdrop-blur cards via the `glass-card` utility.

## 7. Migration and rollout

### 7.1 Migration `054_llm_providers.sql`

Single file, idempotent, runs inside a transaction:

1. `CREATE TABLE llm_providers (…)` and `llm_usecase_assignments (…)` as §3.
2. `CREATE UNIQUE INDEX llm_providers_one_default …`.
3. **Seed provider rows** from existing `admin_settings` via an anonymous
   `DO $$ … $$` block:
   - If `openai_base_url` OR `openai_api_key` is present → insert a row named
     `"OpenAI"` with those values. `api_key` is copied as-is (already AES-encrypted).
     `default_model` ← `openai_model`.
   - Always insert a row named `"Ollama"` with `base_url =
     'http://localhost:11434/v1'` (sentinel). The TS bootstrap in §7.2 replaces
     the sentinel with `OLLAMA_BASE_URL` env if set, on first boot. `default_model`
     ← `ollama_model`.
   - Set `is_default = true` on whichever row matches the old `llm_provider`
     value (`'ollama'` → Ollama row, `'openai'` → OpenAI row). If neither exists
     (totally fresh install), `is_default` is deferred to the TS bootstrap.
4. **Seed `llm_usecase_assignments`** from the eight old `llm_usecase_*_*`
   keys. Look up the new `provider_id` by name (`"Ollama"` / `"OpenAI"`).
   Missing keys → row omitted (inherits at runtime).
5. **Seed embedding row**: `{usecase: 'embedding', provider_id: <is_default id>,
   model: admin_settings['embedding_model']}`.
6. **Delete the migrated `admin_settings` keys** listed in §3.3 in the same
   transaction so there is no dual source of truth post-migration.

### 7.2 TS bootstrap

Runs once on startup, after migrations, guarded by a `seededFromEnv`-style Set
so it is safe to rerun:

- If `llm_providers` is empty (fresh install) and `OLLAMA_BASE_URL` or
  `OPENAI_BASE_URL` is set → insert the corresponding row(s) and mark the
  first as default.
- If an `"Ollama"` row has the sentinel `http://localhost:11434/v1` AND
  `OLLAMA_BASE_URL` differs → replace its `base_url`.
- If no `is_default` row exists after the above → promote the oldest row
  to default.
- Log a WARN if any of `DEFAULT_LLM_MODEL`, `SUMMARY_MODEL`, `QUALITY_MODEL`,
  `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `LLM_BEARER_TOKEN`, `EMBEDDING_MODEL`
  are set after migration — they no longer have effect.

### 7.3 Rollback plan

Additive schema with destructive key removal. No down-migration provided.
Rollback = restore from the PG backup taken immediately before the `054`
migration. The release runbook paragraph is added to
`docs/ARCHITECTURE-DECISIONS.md`.

### 7.4 Doc & ADR updates in the same PR

- New ADR recording Q1–Q5 decisions (`docs/ARCHITECTURE-DECISIONS.md`
  appendix; next available number).
- `docs/architecture/03-backend-domains.md` — update the LLM domain box to
  reference `llm-provider-resolver` instead of the two service files.
- `docs/architecture/06-data-model.md` — add `llm_providers` +
  `llm_usecase_assignments` tables + the FK to `llm_providers.id`.
- `CLAUDE.md` + `AGENTS.md` — rewrite the "External Services" row for LLM
  (delete per-slot env vars) and trim the "Environment" section accordingly.

## 8. Testing

### 8.1 Backend

- **Unit — resolver** (`llm-provider-resolver.test.ts`). Real PG via
  `test-db-helper.ts`. Covers every branch in §3.2 plus: missing-default,
  provider-deleted-mid-call (expect `RESTRICT` to have blocked it earlier),
  cache invalidation after PATCH.
- **Route — providers** (`llm-providers.test.ts`). CRUD happy paths, 409 on
  delete-while-referenced, 409 on delete-while-default, atomic `set-default`
  under two concurrent callers, `/test` with a fake `/v1/models` backend
  (mock at the undici boundary, not the service function).
- **Route — use-cases** (`llm-usecases.test.ts`). Batch upsert tri-state,
  resolved block accuracy across all five use cases.
- **Service — client** (`openai-compatible-client.test.ts`). Single suite for
  chat / stream / embed / models / health against a minimal fake `/v1` server.
  Existing `ollama-service.test.ts` + `openai-service.test.ts` are removed.
- **Migration** (`__tests__/054_llm_providers.test.ts`). Seeds pre-054
  `admin_settings` state, runs the migration, asserts new rows + absence of
  old keys.

### 8.2 Frontend

- `LlmTab.test.tsx` — rewritten.
- `ProviderListSection.test.tsx`, `ProviderEditModal.test.tsx`,
  `EmbeddingReembedBanner.test.tsx` — new. MSW-style `fetch` mocks
  (`vi.spyOn(globalThis, 'fetch')`); no component mocking.

### 8.3 E2E

One new Playwright spec (`e2e/llm-providers.spec.ts`): admin adds a provider,
sets it as default, assigns it to chat, issues a chat request, asserts the
response.

### 8.4 Coverage

80 %+ line coverage per workspace policy. 100 % on the §3.2 resolution rules.

## 9. Security

- API keys encrypted at rest via existing `encryptPat` / `decryptPat`
  (AES-256-GCM with `PAT_ENCRYPTION_KEY`). Same primitive that already
  protects Confluence PATs — no new crypto surface.
- GET responses never include plaintext; only `hasApiKey` + `keyPreview`
  (last 4 chars). `PATCH` accepts `apiKey` to replace; omitting it keeps the
  stored value untouched.
- `baseUrl` validated via existing `ssrf-guard` utility. Rejects loopback +
  RFC1918 unless `LLM_ALLOW_PRIVATE_URLS=true` (existing escape hatch for the
  localhost Ollama case). Applies to create + update.
- Zod validation on every route boundary using `@compendiq/contracts`
  schemas. Parameterized SQL only via `pg` driver.
- `fastify.authenticate` + admin-role check on every `/api/admin/llm-*`
  route.
- Rate limits on `/test` and `/models` (reuse existing Fastify plugin
  config) so the routes can't be used as an egress probe.
- Audit log: every provider create / update / delete / set-default emits an
  `LlmAuditEntry` via `emitLlmAudit()` so EE audit pipelines pick it up.

## 10. Out of scope (YAGNI)

- Per-user provider overrides.
- Non-OpenAI-compatible protocols (native Anthropic, Vertex).
- Automated re-embed triggered by dimension mismatch detection.
- Model aliasing / cost tracking / routing.
- Frontend model auto-discovery on startup.

## 11. Acceptance criteria

1. Admin can create ≥ 2 providers of type openai-compatible in the UI and
   assign any of them to any of the five use cases (chat, summary, quality,
   auto_tag, embedding).
2. Changing an assignment takes effect on the next request without a restart.
3. Deleting a provider that is in use returns HTTP 409 with the list of
   blocking use cases.
4. Upgrade from a pre-054 install preserves the currently-active provider and
   model in the default + chat slots; no user action required for chat to keep
   working.
5. Changing the embedding provider or model shows a confirmation dialog and
   surfaces a re-embed action that successfully re-embeds all pages.
6. `npm test`, `npm run lint`, `npm run typecheck` pass in both workspaces.

---

**Next step:** transition to the `writing-plans` skill to produce a
step-by-step implementation plan with surgical edits, test ordering, and
rollback.
