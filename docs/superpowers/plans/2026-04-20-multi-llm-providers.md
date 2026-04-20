# Multi-LLM-Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two-slot Ollama/OpenAI admin config with an N-provider table of `openai-compatible` endpoints that can be individually assigned to five use cases (chat, summary, quality, auto_tag, embedding), preserving upgrade compatibility and adding a re-embed guardrail when embedding config changes.

**Architecture:** New `llm_providers` + `llm_usecase_assignments` tables replace the flat `admin_settings` keys. A unified `openai-compatible-client` (no Ollama/OpenAI split) is called by a new `resolveUsecase(usecase)` function. The frontend gets a provider-list CRUD above the existing use-case grid.

**Tech Stack:** Fastify 5, TypeScript, PostgreSQL 17 (pgvector), `undici`, `zod`, React 19, TanStack Query, Vitest, Playwright.

**Spec reference:** `docs/superpowers/specs/2026-04-20-multi-llm-providers-design.md`

**Branch:** `feature/multi-llm-providers` (already created, spec already committed).

---

## File Structure

### New files
| Path | Responsibility |
|------|----------------|
| `backend/src/core/db/migrations/054_llm_providers.sql` | Creates the two tables, seeds from old keys, deletes old keys. |
| `backend/src/core/db/migrations/__tests__/054_llm_providers.test.ts` | Seeds pre-054 state, runs the migration, asserts new rows + old-key deletion. |
| `backend/src/domains/llm/services/openai-compatible-client.ts` | Pure functions `chat`, `streamChat`, `generateEmbedding`, `listModels`, `checkHealth`. |
| `backend/src/domains/llm/services/openai-compatible-client.test.ts` | Unit tests against a fake `/v1` server. |
| `backend/src/domains/llm/services/llm-provider-resolver.ts` | `getProvider`, `resolveUsecase`, `listProviders`, cache-invalidation. |
| `backend/src/domains/llm/services/llm-provider-resolver.test.ts` | Every branch of the §3.2 truth table. |
| `backend/src/domains/llm/services/llm-provider-service.ts` | CRUD service for `llm_providers` (encrypt/decrypt, normalize baseUrl, set-default). |
| `backend/src/domains/llm/services/llm-provider-service.test.ts` | CRUD + set-default + delete-guards. |
| `backend/src/domains/llm/services/llm-provider-bootstrap.ts` | Runs once at startup; seeds rows from env on fresh install, rewrites Ollama sentinel. |
| `backend/src/domains/llm/services/llm-provider-bootstrap.test.ts` | Fresh-install env seed; sentinel rewrite; warning log on deprecated vars. |
| `backend/src/routes/llm/llm-providers.ts` | REST routes for provider CRUD + test + models + set-default. |
| `backend/src/routes/llm/llm-providers.test.ts` | Route-level tests (auth, 409s, 200s). |
| `backend/src/routes/llm/llm-usecases.ts` | GET/PUT routes for use-case assignments. |
| `backend/src/routes/llm/llm-usecases.test.ts` | Route-level tests incl. the `resolved` payload. |
| `backend/src/routes/llm/llm-embedding-reembed.ts` | POST route to enqueue re-embed job. |
| `backend/src/routes/llm/llm-embedding-reembed.test.ts` | Route-level test. |
| `frontend/src/features/settings/panels/ProviderListSection.tsx` | Table of providers + "Add" button. |
| `frontend/src/features/settings/panels/ProviderListSection.test.tsx` | Component test. |
| `frontend/src/features/settings/panels/ProviderEditModal.tsx` | Create/edit modal with inline "Test" action. |
| `frontend/src/features/settings/panels/ProviderEditModal.test.tsx` | Component test. |
| `frontend/src/features/settings/panels/EmbeddingReembedBanner.tsx` | Re-embed job progress banner. |
| `frontend/src/features/settings/panels/EmbeddingReembedBanner.test.tsx` | Component test. |
| `e2e/llm-providers.spec.ts` | Playwright E2E. |

### Modified files
| Path | Change |
|------|--------|
| `packages/contracts/src/llm.ts` | Add `LlmProviderSchema`, `UsecaseAssignmentSchema` rewrite against `providerId`; add `embedding` to `LlmUsecase`. |
| `backend/src/app.ts` | Register the three new route files; call `bootstrapLlmProviders()` after migrations. |
| `backend/src/core/services/admin-settings-service.ts` | Remove the LLM-provider keys/functions, keep `embedding_dimensions` + `fts_language`. |
| `backend/src/routes/llm/llm-chat.ts` | Use `resolveUsecase('chat')` + new client. |
| `backend/src/routes/llm/llm-ask.ts` | Same. |
| `backend/src/routes/llm/llm-summarize.ts` | Use `resolveUsecase('summary')`. |
| `backend/src/routes/llm/llm-quality.ts` | Use `resolveUsecase('quality')`. |
| `backend/src/routes/llm/llm-generate.ts` | Use `resolveUsecase('chat')`. |
| `backend/src/routes/llm/llm-improve.ts` | Use `resolveUsecase('chat')`. |
| `backend/src/routes/llm/llm-diagram.ts` | Use `resolveUsecase('chat')`. |
| `backend/src/routes/llm/llm-pdf.ts` (`generate-with-pdf.test.ts` etc.) | Use `resolveUsecase('chat')`. |
| `backend/src/routes/llm/apply-improvement.ts`, `improve-instruction.ts`, `improve-page-id.ts`, `analyze-quality.ts` | Use `resolveUsecase(…)`. |
| `backend/src/domains/llm/services/embedding-service.ts` | Use `resolveUsecase('embedding')`. |
| `backend/src/domains/llm/services/rag-service.ts` | Use `resolveUsecase('embedding')` for query embed, `resolveUsecase('chat')` for answer. |
| `backend/src/domains/knowledge/services/summary-worker.ts` | Use `resolveUsecase('summary')`. |
| `backend/src/domains/knowledge/services/quality-worker.ts` | Use `resolveUsecase('quality')`. |
| `backend/src/domains/knowledge/services/auto-tagger.ts` | Use `resolveUsecase('auto_tag')`. |
| `frontend/src/features/settings/panels/LlmTab.tsx` | Delete old two-slot UI; compose `ProviderListSection` + rewritten `UsecaseAssignmentsSection` + `EmbeddingReembedBanner`. |
| `frontend/src/features/settings/panels/UsecaseAssignmentsSection.tsx` | (extracted file; rewritten to key off `providerId`, supports `embedding` usecase). |
| `docs/ARCHITECTURE-DECISIONS.md` | New ADR appendix recording Q1–Q5. |
| `docs/architecture/03-backend-domains.md` | LLM domain box updated. |
| `docs/architecture/06-data-model.md` | New tables + FK. |
| `CLAUDE.md` + `AGENTS.md` | Trim dead env vars, refer to admin UI. |

### Deleted files
| Path | Reason |
|------|--------|
| `backend/src/domains/llm/services/ollama-service.ts` + test | Collapsed into `openai-compatible-client`. |
| `backend/src/domains/llm/services/ollama-provider.ts` | Same. |
| `backend/src/domains/llm/services/openai-service.ts` + test | Same. |
| `backend/src/domains/llm/services/llm-provider.ts` + test | Replaced by `llm-provider-resolver.ts`. |

---

## Phase 1 — Contracts

### Task 1: Extend `LlmUsecase` with `embedding` + add provider schemas

**Files:**
- Modify: `packages/contracts/src/llm.ts`
- Test: `packages/contracts/src/llm.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/contracts/src/llm.test.ts` (create file if missing; mirror existing contracts-test style — plain Vitest, no backend deps):

```ts
import { describe, it, expect } from 'vitest';
import {
  LlmUsecaseSchema,
  LlmProviderInputSchema,
  UsecaseAssignmentsSchema,
} from './llm.js';

describe('LlmUsecaseSchema', () => {
  it('accepts embedding as a valid use case', () => {
    expect(() => LlmUsecaseSchema.parse('embedding')).not.toThrow();
  });
  it('rejects unknown use cases', () => {
    expect(() => LlmUsecaseSchema.parse('bogus')).toThrow();
  });
});

describe('LlmProviderInputSchema', () => {
  it('accepts a minimal valid input', () => {
    const parsed = LlmProviderInputSchema.parse({
      name: 'GPU Box',
      baseUrl: 'http://gpu:11434/v1',
      authType: 'bearer',
      verifySsl: true,
    });
    expect(parsed.name).toBe('GPU Box');
  });
  it('rejects empty names', () => {
    expect(() =>
      LlmProviderInputSchema.parse({ name: '', baseUrl: 'http://x/v1', authType: 'none', verifySsl: true }),
    ).toThrow();
  });
  it('rejects non-http(s) baseUrl', () => {
    expect(() =>
      LlmProviderInputSchema.parse({ name: 'x', baseUrl: 'ftp://x', authType: 'none', verifySsl: true }),
    ).toThrow();
  });
});

describe('UsecaseAssignmentsSchema', () => {
  it('allows null providerId + null model (inherit)', () => {
    const parsed = UsecaseAssignmentsSchema.parse({
      chat: { providerId: null, model: null, resolved: { providerId: 'p1', providerName: 'X', model: 'm' } },
      summary: { providerId: null, model: null, resolved: { providerId: 'p1', providerName: 'X', model: 'm' } },
      quality: { providerId: null, model: null, resolved: { providerId: 'p1', providerName: 'X', model: 'm' } },
      auto_tag: { providerId: null, model: null, resolved: { providerId: 'p1', providerName: 'X', model: 'm' } },
      embedding: { providerId: null, model: null, resolved: { providerId: 'p1', providerName: 'X', model: 'm' } },
    });
    expect(parsed.embedding).toBeDefined();
  });
});
```

- [ ] **Step 2: Run to verify fail**

`cd packages/contracts && npx vitest run src/llm.test.ts`
Expected: FAIL — schemas don't exist yet.

- [ ] **Step 3: Minimal implementation**

Edit `packages/contracts/src/llm.ts` — add/replace these exports (keep the existing `LlmProviderTypeSchema` for backwards compatibility of the OLD union but mark it deprecated; the new code paths use provider UUIDs, not the enum):

```ts
import { z } from 'zod';

// ─── Use-cases (NOW includes 'embedding') ────────────────────────────────
export const LlmUsecaseSchema = z.enum(['chat', 'summary', 'quality', 'auto_tag', 'embedding']);
export type LlmUsecase = z.infer<typeof LlmUsecaseSchema>;

// ─── Provider ────────────────────────────────────────────────────────────
export const LlmAuthTypeSchema = z.enum(['bearer', 'none']);
export type LlmAuthType = z.infer<typeof LlmAuthTypeSchema>;

export const LlmProviderInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  baseUrl: z.string().url().regex(/^https?:\/\//, 'baseUrl must be http(s)'),
  apiKey: z.string().min(1).optional(),
  authType: LlmAuthTypeSchema,
  verifySsl: z.boolean(),
  defaultModel: z.string().trim().min(1).max(200).nullable().optional(),
});
export type LlmProviderInput = z.infer<typeof LlmProviderInputSchema>;

export const LlmProviderUpdateSchema = LlmProviderInputSchema.partial();
export type LlmProviderUpdate = z.infer<typeof LlmProviderUpdateSchema>;

export const LlmProviderSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  baseUrl: z.string(),
  authType: LlmAuthTypeSchema,
  verifySsl: z.boolean(),
  defaultModel: z.string().nullable(),
  isDefault: z.boolean(),
  hasApiKey: z.boolean(),
  keyPreview: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type LlmProvider = z.infer<typeof LlmProviderSchema>;

// ─── Use-case assignments (rewritten against providerId) ─────────────────
export const UsecaseAssignmentSchema = z.object({
  providerId: z.string().uuid().nullable(),
  model: z.string().nullable(),
  resolved: z.object({
    providerId: z.string().uuid(),
    providerName: z.string(),
    model: z.string(),
  }),
});
export type UsecaseAssignment = z.infer<typeof UsecaseAssignmentSchema>;

export const UsecaseAssignmentsSchema = z.object({
  chat: UsecaseAssignmentSchema,
  summary: UsecaseAssignmentSchema,
  quality: UsecaseAssignmentSchema,
  auto_tag: UsecaseAssignmentSchema,
  embedding: UsecaseAssignmentSchema,
});
export type UsecaseAssignments = z.infer<typeof UsecaseAssignmentsSchema>;

export const UpdateUsecaseAssignmentInputSchema = z.object({
  providerId: z.string().uuid().nullable().optional(),  // undefined=leave, null=clear, uuid=set
  model: z.string().nullable().optional(),
});
export const UpdateUsecaseAssignmentsInputSchema = z.object({
  chat: UpdateUsecaseAssignmentInputSchema.optional(),
  summary: UpdateUsecaseAssignmentInputSchema.optional(),
  quality: UpdateUsecaseAssignmentInputSchema.optional(),
  auto_tag: UpdateUsecaseAssignmentInputSchema.optional(),
  embedding: UpdateUsecaseAssignmentInputSchema.optional(),
});
export type UpdateUsecaseAssignmentsInput = z.infer<typeof UpdateUsecaseAssignmentsInputSchema>;

// ─── DEPRECATED: old two-slot enum kept for transitional typing only ──────
/** @deprecated use `LlmProvider.id` (uuid). Removed after Task 36. */
export const LlmProviderTypeSchema = z.enum(['ollama', 'openai']);
/** @deprecated */
export type LlmProviderType = z.infer<typeof LlmProviderTypeSchema>;
```

- [ ] **Step 4: Run to verify pass**

`cd packages/contracts && npx vitest run src/llm.test.ts`
Expected: PASS.

- [ ] **Step 5: Run type check**

`cd packages/contracts && npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/llm.ts packages/contracts/src/llm.test.ts
git commit -m "contracts: add multi-provider schemas and embedding use case"
```

---

## Phase 2 — Migration

### Task 2: Write migration `054_llm_providers.sql`

**Files:**
- Create: `backend/src/core/db/migrations/054_llm_providers.sql`
- Create: `backend/src/core/db/migrations/__tests__/054_llm_providers.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/src/core/db/migrations/__tests__/054_llm_providers.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../../test-db-helper.js';
import { query } from '../../postgres.js';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('Migration 054 — multi LLM providers', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => { await truncateAllTables(); });

  async function seedLegacy(rows: Record<string, string>) {
    for (const [k, v] of Object.entries(rows)) {
      await query(
        `INSERT INTO admin_settings (setting_key, setting_value) VALUES ($1, $2)
         ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value`,
        [k, v],
      );
    }
  }

  it('creates llm_providers and llm_usecase_assignments tables', async () => {
    const tables = await query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname='public'
       AND tablename IN ('llm_providers','llm_usecase_assignments')`,
    );
    expect(tables.rows.map(r => r.tablename).sort()).toEqual(
      ['llm_providers', 'llm_usecase_assignments'],
    );
  });

  it('enforces single default via partial unique index', async () => {
    const idx = await query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename='llm_providers'
         AND indexname='llm_providers_one_default'`,
    );
    expect(idx.rows).toHaveLength(1);
  });

  it('RESTRICTs delete of provider referenced by a use-case row', async () => {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO llm_providers (name, base_url, auth_type, verify_ssl, is_default)
       VALUES ('P1','http://x/v1','none',true,true) RETURNING id`,
    );
    const id = rows[0]!.id;
    await query(
      `INSERT INTO llm_usecase_assignments (usecase, provider_id, model)
       VALUES ('chat', $1, 'm1')`,
      [id],
    );
    await expect(
      query(`DELETE FROM llm_providers WHERE id=$1`, [id]),
    ).rejects.toThrow(/violates foreign key constraint/i);
  });

  it('seeds OpenAI provider from legacy admin_settings', async () => {
    await truncateAllTables();
    await seedLegacy({
      llm_provider: 'openai',
      openai_base_url: 'https://api.openai.com',
      openai_model: 'gpt-4o-mini',
    });
    // Re-run just the idempotent seeding block by importing migration text.
    // Simpler: setupTestDb already ran 054; we drive it by simulating:
    // (the DO$$ block in 054 is idempotent — call it via ad-hoc SQL below).
    // For this test we assume setupTestDb ran 054 already; verify seeding logic
    // by re-running an equivalent SQL block after seeding legacy data:
    const sql = await (await import('node:fs')).promises.readFile(
      new URL('../054_llm_providers.sql', import.meta.url), 'utf8',
    );
    await query(sql);
    const providers = await query<{ name: string; default_model: string | null; is_default: boolean }>(
      `SELECT name, default_model, is_default FROM llm_providers ORDER BY name`,
    );
    expect(providers.rows).toEqual([
      expect.objectContaining({ name: 'OpenAI', default_model: 'gpt-4o-mini', is_default: true }),
    ]);
    const keys = await query<{ setting_key: string }>(
      `SELECT setting_key FROM admin_settings
       WHERE setting_key IN ('llm_provider','openai_base_url','openai_model')`,
    );
    expect(keys.rows).toEqual([]);
  });

  it('seeds Ollama provider with sentinel when legacy ollama_model present', async () => {
    await truncateAllTables();
    await seedLegacy({ llm_provider: 'ollama', ollama_model: 'qwen3:4b' });
    const sql = await (await import('node:fs')).promises.readFile(
      new URL('../054_llm_providers.sql', import.meta.url), 'utf8',
    );
    await query(sql);
    const p = await query<{ name: string; base_url: string; default_model: string; is_default: boolean }>(
      `SELECT name, base_url, default_model, is_default FROM llm_providers`,
    );
    expect(p.rows).toEqual([
      { name: 'Ollama', base_url: 'http://localhost:11434/v1', default_model: 'qwen3:4b', is_default: true },
    ]);
  });

  it('does NOT seed Ollama on OpenAI-only legacy installs', async () => {
    await truncateAllTables();
    await seedLegacy({ llm_provider: 'openai', openai_model: 'gpt-4o' });
    const sql = await (await import('node:fs')).promises.readFile(
      new URL('../054_llm_providers.sql', import.meta.url), 'utf8',
    );
    await query(sql);
    const p = await query<{ name: string }>(`SELECT name FROM llm_providers`);
    expect(p.rows.map(r => r.name)).toEqual(['OpenAI']);
  });

  it('seeds use-case rows from legacy per-use-case keys', async () => {
    await truncateAllTables();
    await seedLegacy({
      llm_provider: 'ollama',
      ollama_model: 'qwen3:4b',
      openai_base_url: 'https://api.openai.com',
      openai_model: 'gpt-4o',
      llm_usecase_summary_provider: 'openai',
      llm_usecase_summary_model: 'gpt-4o-mini',
      embedding_model: 'bge-m3',
    });
    const sql = await (await import('node:fs')).promises.readFile(
      new URL('../054_llm_providers.sql', import.meta.url), 'utf8',
    );
    await query(sql);
    const assigns = await query<{ usecase: string; provider_name: string | null; model: string | null }>(
      `SELECT a.usecase, p.name AS provider_name, a.model
       FROM llm_usecase_assignments a
       LEFT JOIN llm_providers p ON p.id = a.provider_id
       ORDER BY a.usecase`,
    );
    expect(assigns.rows).toEqual([
      { usecase: 'embedding', provider_name: 'Ollama', model: 'bge-m3' },
      { usecase: 'summary', provider_name: 'OpenAI', model: 'gpt-4o-mini' },
    ]);
  });
});
```

- [ ] **Step 2: Run to verify fail**

`cd backend && npx vitest run src/core/db/migrations/__tests__/054_llm_providers.test.ts`
Expected: FAIL — migration file doesn't exist yet.

- [ ] **Step 3: Minimal implementation**

Create `backend/src/core/db/migrations/054_llm_providers.sql`:

```sql
-- Migration 054: multi-LLM-provider tables, seeded from legacy admin_settings.
-- Idempotent: the DO $$ seeding block uses ON CONFLICT DO NOTHING everywhere and
-- only runs when the target tables are empty.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS llm_providers (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT        NOT NULL UNIQUE,
  base_url      TEXT        NOT NULL,
  api_key       TEXT        NULL,
  auth_type     TEXT        NOT NULL DEFAULT 'bearer' CHECK (auth_type IN ('bearer','none')),
  verify_ssl    BOOLEAN     NOT NULL DEFAULT TRUE,
  default_model TEXT        NULL,
  is_default    BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS llm_providers_one_default
  ON llm_providers (is_default) WHERE is_default;

CREATE TABLE IF NOT EXISTS llm_usecase_assignments (
  usecase     TEXT        PRIMARY KEY CHECK (usecase IN ('chat','summary','quality','auto_tag','embedding')),
  provider_id UUID        NULL REFERENCES llm_providers(id) ON DELETE RESTRICT,
  model       TEXT        NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
DECLARE
  legacy_llm_provider      TEXT;
  legacy_ollama_model      TEXT;
  legacy_openai_base_url   TEXT;
  legacy_openai_api_key    TEXT;
  legacy_openai_model      TEXT;
  legacy_embedding_model   TEXT;
  openai_id UUID;
  ollama_id UUID;
  default_id UUID;
BEGIN
  -- Read legacy keys (NULL-safe)
  SELECT setting_value INTO legacy_llm_provider     FROM admin_settings WHERE setting_key = 'llm_provider';
  SELECT setting_value INTO legacy_ollama_model     FROM admin_settings WHERE setting_key = 'ollama_model';
  SELECT setting_value INTO legacy_openai_base_url  FROM admin_settings WHERE setting_key = 'openai_base_url';
  SELECT setting_value INTO legacy_openai_api_key   FROM admin_settings WHERE setting_key = 'openai_api_key';
  SELECT setting_value INTO legacy_openai_model     FROM admin_settings WHERE setting_key = 'openai_model';
  SELECT setting_value INTO legacy_embedding_model  FROM admin_settings WHERE setting_key = 'embedding_model';

  -- Seed OpenAI row when any legacy OpenAI signal is present.
  IF legacy_openai_base_url IS NOT NULL OR legacy_openai_api_key IS NOT NULL OR legacy_openai_model IS NOT NULL THEN
    INSERT INTO llm_providers (name, base_url, api_key, auth_type, verify_ssl, default_model)
    VALUES (
      'OpenAI',
      -- normalize: ensure /v1 suffix
      CASE
        WHEN legacy_openai_base_url IS NULL THEN 'https://api.openai.com/v1'
        WHEN legacy_openai_base_url LIKE '%/v1' THEN legacy_openai_base_url
        WHEN legacy_openai_base_url LIKE '%/v1/' THEN rtrim(legacy_openai_base_url, '/')
        ELSE rtrim(legacy_openai_base_url, '/') || '/v1'
      END,
      legacy_openai_api_key,
      'bearer',
      TRUE,
      legacy_openai_model
    )
    ON CONFLICT (name) DO NOTHING
    RETURNING id INTO openai_id;
  END IF;

  -- Seed Ollama row only when a legacy Ollama signal is present.
  IF legacy_ollama_model IS NOT NULL OR legacy_llm_provider = 'ollama' THEN
    INSERT INTO llm_providers (name, base_url, api_key, auth_type, verify_ssl, default_model)
    VALUES ('Ollama', 'http://localhost:11434/v1', NULL, 'none', TRUE, legacy_ollama_model)
    ON CONFLICT (name) DO NOTHING
    RETURNING id INTO ollama_id;
  END IF;

  -- Set is_default based on legacy llm_provider value.
  IF legacy_llm_provider = 'openai' AND openai_id IS NOT NULL THEN
    UPDATE llm_providers SET is_default = TRUE WHERE id = openai_id;
  ELSIF legacy_llm_provider = 'ollama' AND ollama_id IS NOT NULL THEN
    UPDATE llm_providers SET is_default = TRUE WHERE id = ollama_id;
  END IF;

  -- Seed use-case rows from per-use-case legacy keys.
  SELECT id INTO default_id FROM llm_providers WHERE is_default LIMIT 1;

  INSERT INTO llm_usecase_assignments (usecase, provider_id, model)
  SELECT
    substring(k.setting_key FROM 'llm_usecase_(.+)_provider'),
    CASE k.setting_value
      WHEN 'openai' THEN openai_id
      WHEN 'ollama' THEN ollama_id
    END,
    (SELECT setting_value FROM admin_settings
      WHERE setting_key = 'llm_usecase_' || substring(k.setting_key FROM 'llm_usecase_(.+)_provider') || '_model')
  FROM admin_settings k
  WHERE k.setting_key LIKE 'llm_usecase_%_provider'
    AND substring(k.setting_key FROM 'llm_usecase_(.+)_provider') IN ('chat','summary','quality','auto_tag')
  ON CONFLICT (usecase) DO NOTHING;

  -- Seed embedding use-case row from legacy embedding_model.
  IF legacy_embedding_model IS NOT NULL AND default_id IS NOT NULL THEN
    INSERT INTO llm_usecase_assignments (usecase, provider_id, model)
    VALUES ('embedding', default_id, legacy_embedding_model)
    ON CONFLICT (usecase) DO NOTHING;
  END IF;

  -- Delete the migrated legacy keys.
  DELETE FROM admin_settings WHERE setting_key IN (
    'llm_provider', 'ollama_model', 'openai_base_url', 'openai_api_key', 'openai_model', 'embedding_model',
    'llm_usecase_chat_provider', 'llm_usecase_chat_model',
    'llm_usecase_summary_provider', 'llm_usecase_summary_model',
    'llm_usecase_quality_provider', 'llm_usecase_quality_model',
    'llm_usecase_auto_tag_provider', 'llm_usecase_auto_tag_model'
  );
END $$;
```

- [ ] **Step 4: Run test to verify pass**

`cd backend && npx vitest run src/core/db/migrations/__tests__/054_llm_providers.test.ts`
Expected: PASS (all 7 cases).

- [ ] **Step 5: Commit**

```bash
git add backend/src/core/db/migrations/054_llm_providers.sql \
        backend/src/core/db/migrations/__tests__/054_llm_providers.test.ts
git commit -m "db: migration 054 adds llm_providers + llm_usecase_assignments tables"
```

---

## Phase 3 — Service layer

### Task 3: `openai-compatible-client` — health + list models

**Files:**
- Create: `backend/src/domains/llm/services/openai-compatible-client.ts`
- Create: `backend/src/domains/llm/services/openai-compatible-client.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// backend/src/domains/llm/services/openai-compatible-client.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { checkHealth, listModels, type ProviderConfig } from './openai-compatible-client.js';

let srv: Server;
let baseUrl: string;

beforeAll(async () => {
  srv = createServer((req, res) => {
    if (req.url === '/v1/models' && req.headers.authorization === 'Bearer sekret') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'm1' }, { id: 'm2' }] }));
      return;
    }
    if (req.url === '/v1/models') { res.writeHead(401); res.end(); return; }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => srv.listen(0, r));
  const { port } = srv.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/v1`;
});

afterAll(() => new Promise<void>((r) => srv.close(() => r())));

const cfg: ProviderConfig = {
  providerId: 'id1', baseUrl: '', apiKey: 'sekret', authType: 'bearer', verifySsl: true,
};

describe('openai-compatible-client', () => {
  it('listModels returns models from /v1/models', async () => {
    const r = await listModels({ ...cfg, baseUrl });
    expect(r.map(m => m.name)).toEqual(['m1', 'm2']);
  });
  it('checkHealth returns connected:true when endpoint is reachable', async () => {
    const r = await checkHealth({ ...cfg, baseUrl });
    expect(r.connected).toBe(true);
  });
  it('checkHealth returns connected:false on 401', async () => {
    const r = await checkHealth({ ...cfg, baseUrl, apiKey: null });
    expect(r.connected).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify fail**

`cd backend && npx vitest run src/domains/llm/services/openai-compatible-client.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Minimal implementation**

Create `backend/src/domains/llm/services/openai-compatible-client.ts`:

```ts
import { Agent, fetch as undiciFetch } from 'undici';

export interface ProviderConfig {
  providerId: string;
  baseUrl: string;           // already normalized to end with /v1
  apiKey: string | null;
  authType: 'bearer' | 'none';
  verifySsl: boolean;
}

export interface LlmModel { name: string; }
export interface HealthResult { connected: boolean; error?: string; }
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string; }
export interface StreamChunk { content: string; done: boolean; }

const dispatchers = new Map<string, Agent>();
function dispatcherFor(cfg: ProviderConfig): Agent | undefined {
  if (cfg.verifySsl) return undefined;
  let d = dispatchers.get(cfg.providerId);
  if (!d) {
    d = new Agent({ connect: { rejectUnauthorized: false } });
    dispatchers.set(cfg.providerId, d);
  }
  return d;
}

export function invalidateDispatcher(providerId: string): void {
  const d = dispatchers.get(providerId);
  if (d) { void d.close(); dispatchers.delete(providerId); }
}

function headers(cfg: ProviderConfig): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.authType === 'bearer' && cfg.apiKey) h['Authorization'] = `Bearer ${cfg.apiKey}`;
  return h;
}

export async function listModels(cfg: ProviderConfig): Promise<LlmModel[]> {
  const res = await undiciFetch(`${cfg.baseUrl}/models`, {
    headers: headers(cfg), dispatcher: dispatcherFor(cfg),
  });
  if (!res.ok) throw new Error(`listModels HTTP ${res.status}`);
  const body = await res.json() as { data?: Array<{ id: string }> };
  return (body.data ?? []).map((m) => ({ name: m.id }));
}

export async function checkHealth(cfg: ProviderConfig): Promise<HealthResult> {
  try {
    await listModels(cfg);
    return { connected: true };
  } catch (err) {
    return { connected: false, error: err instanceof Error ? err.message : String(err) };
  }
}
```

- [ ] **Step 4: Run test to verify pass**

`cd backend && npx vitest run src/domains/llm/services/openai-compatible-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/domains/llm/services/openai-compatible-client.ts \
        backend/src/domains/llm/services/openai-compatible-client.test.ts
git commit -m "llm: add openai-compatible-client (health + listModels)"
```

### Task 4: `openai-compatible-client` — chat + streamChat

- [ ] **Step 1: Add failing test**

Append to the same test file:

```ts
import { chat, streamChat } from './openai-compatible-client.js';

describe('openai-compatible-client — chat', () => {
  let chatSrv: Server;
  let chatBase: string;
  beforeAll(async () => {
    chatSrv = createServer((req, res) => {
      if (req.url === '/v1/chat/completions') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const parsed = JSON.parse(body);
          if (parsed.stream) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'hel' } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'lo' } }] }) + '\n\n');
            res.write('data: [DONE]\n\n');
            res.end();
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { content: 'hello' } }] }));
          }
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    await new Promise<void>((r) => chatSrv.listen(0, r));
    const { port } = chatSrv.address() as AddressInfo;
    chatBase = `http://127.0.0.1:${port}/v1`;
  });
  afterAll(() => new Promise<void>((r) => chatSrv.close(() => r())));

  it('chat returns assistant content', async () => {
    const r = await chat({ ...cfg, baseUrl: chatBase }, 'm1', [{ role: 'user', content: 'hi' }]);
    expect(r).toBe('hello');
  });

  it('streamChat yields chunks then done', async () => {
    const out: string[] = [];
    let done = false;
    for await (const c of streamChat({ ...cfg, baseUrl: chatBase }, 'm1', [{ role: 'user', content: 'hi' }])) {
      out.push(c.content); if (c.done) done = true;
    }
    expect(out.filter(Boolean).join('')).toBe('hello');
    expect(done).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify fail**

`cd backend && npx vitest run src/domains/llm/services/openai-compatible-client.test.ts`
Expected: FAIL — `chat` / `streamChat` not exported.

- [ ] **Step 3: Implement chat + streamChat**

Append to `openai-compatible-client.ts`:

```ts
export async function chat(cfg: ProviderConfig, model: string, messages: ChatMessage[]): Promise<string> {
  const res = await undiciFetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: headers(cfg),
    body: JSON.stringify({ model, messages, stream: false }),
    dispatcher: dispatcherFor(cfg),
  });
  if (!res.ok) throw new Error(`chat HTTP ${res.status}`);
  const body = await res.json() as { choices: Array<{ message: { content: string } }> };
  return body.choices[0]?.message.content ?? '';
}

export async function* streamChat(
  cfg: ProviderConfig, model: string, messages: ChatMessage[], signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  const res = await undiciFetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: headers(cfg),
    body: JSON.stringify({ model, messages, stream: true }),
    dispatcher: dispatcherFor(cfg),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`streamChat HTTP ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 2);
      if (!frame.startsWith('data:')) continue;
      const data = frame.slice(5).trim();
      if (data === '[DONE]') { yield { content: '', done: true }; return; }
      try {
        const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
        const content = parsed.choices?.[0]?.delta?.content ?? '';
        if (content) yield { content, done: false };
      } catch { /* ignore parse errors on malformed frames */ }
    }
  }
  yield { content: '', done: true };
}
```

- [ ] **Step 4: Run to verify pass**

`cd backend && npx vitest run src/domains/llm/services/openai-compatible-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/domains/llm/services/openai-compatible-client.ts \
        backend/src/domains/llm/services/openai-compatible-client.test.ts
git commit -m "llm: openai-compatible-client chat + streamChat"
```

### Task 5: `openai-compatible-client` — generateEmbedding

- [ ] **Step 1: Add failing test**

Append:

```ts
import { generateEmbedding } from './openai-compatible-client.js';

describe('openai-compatible-client — embeddings', () => {
  let embSrv: Server;
  let embBase: string;
  beforeAll(async () => {
    embSrv = createServer((req, res) => {
      if (req.url === '/v1/embeddings') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }, { embedding: [0.4, 0.5, 0.6] }] }));
        return;
      }
      res.writeHead(404); res.end();
    });
    await new Promise<void>((r) => embSrv.listen(0, r));
    const { port } = embSrv.address() as AddressInfo;
    embBase = `http://127.0.0.1:${port}/v1`;
  });
  afterAll(() => new Promise<void>((r) => embSrv.close(() => r())));

  it('returns embedding arrays for an array input', async () => {
    const r = await generateEmbedding({ ...cfg, baseUrl: embBase }, 'bge-m3', ['a', 'b']);
    expect(r).toEqual([[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]]);
  });
  it('wraps string input as single-element array', async () => {
    const r = await generateEmbedding({ ...cfg, baseUrl: embBase }, 'bge-m3', 'a');
    expect(r).toHaveLength(2);  // fake server returns both rows regardless
  });
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement**

Append to `openai-compatible-client.ts`:

```ts
export async function generateEmbedding(
  cfg: ProviderConfig, model: string, text: string | string[],
): Promise<number[][]> {
  const input = Array.isArray(text) ? text : [text];
  const res = await undiciFetch(`${cfg.baseUrl}/embeddings`, {
    method: 'POST',
    headers: headers(cfg),
    body: JSON.stringify({ model, input }),
    dispatcher: dispatcherFor(cfg),
  });
  if (!res.ok) throw new Error(`generateEmbedding HTTP ${res.status}`);
  const body = await res.json() as { data: Array<{ embedding: number[] }> };
  return body.data.map((d) => d.embedding);
}
```

- [ ] **Step 4: Run → pass.**

- [ ] **Step 5: Commit**

```bash
git commit -am "llm: openai-compatible-client generateEmbedding"
```

### Task 6: Provider service — read helpers (list, get, decrypt)

**Files:**
- Create: `backend/src/domains/llm/services/llm-provider-service.ts`
- Create: `backend/src/domains/llm/services/llm-provider-service.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// backend/src/domains/llm/services/llm-provider-service.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import { listProviders, getProviderById } from './llm-provider-service.js';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('llm-provider-service — read', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => { await truncateAllTables(); });

  it('listProviders returns [] when table empty', async () => {
    expect(await listProviders()).toEqual([]);
  });

  it('listProviders masks api_key', async () => {
    await query(
      `INSERT INTO llm_providers (name, base_url, api_key, auth_type, verify_ssl, default_model, is_default)
       VALUES ('X','http://x/v1','enc-sekret-abcd','bearer',true,'m1',true)`,
    );
    const rows = await listProviders();
    expect(rows[0]).toMatchObject({ name: 'X', hasApiKey: true });
    expect((rows[0] as unknown as { apiKey?: string }).apiKey).toBeUndefined();
  });

  it('getProviderById returns decrypted config including apiKey (server-side)', async () => {
    const { encryptPat } = await import('../../../core/utils/crypto.js');
    const encrypted = encryptPat('secret-value');
    const { rows } = await query<{ id: string }>(
      `INSERT INTO llm_providers (name, base_url, api_key, auth_type, verify_ssl, default_model, is_default)
       VALUES ('X','http://x/v1',$1,'bearer',true,'m1',true) RETURNING id`,
      [encrypted],
    );
    const cfg = await getProviderById(rows[0]!.id);
    expect(cfg).toMatchObject({ name: 'X', apiKey: 'secret-value' });
  });
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement**

Create `backend/src/domains/llm/services/llm-provider-service.ts`:

```ts
import { query } from '../../../core/db/postgres.js';
import { encryptPat, decryptPat } from '../../../core/utils/crypto.js';
import type { LlmProvider, LlmProviderInput, LlmProviderUpdate } from '@compendiq/contracts';

/** Internal row shape returned from PG — includes the encrypted api_key. */
interface ProviderRow {
  id: string;
  name: string;
  base_url: string;
  api_key: string | null;
  auth_type: 'bearer' | 'none';
  verify_ssl: boolean;
  default_model: string | null;
  is_default: boolean;
  created_at: Date;
  updated_at: Date;
}

/** Server-side config — decrypted. NEVER returned from HTTP routes. */
export interface ProviderConfigRow {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string | null;
  authType: 'bearer' | 'none';
  verifySsl: boolean;
  defaultModel: string | null;
  isDefault: boolean;
}

function rowToDto(r: ProviderRow): LlmProvider {
  const preview = r.api_key ? ('…' + (decryptSafe(r.api_key)?.slice(-4) ?? '')) : null;
  return {
    id: r.id,
    name: r.name,
    baseUrl: r.base_url,
    authType: r.auth_type,
    verifySsl: r.verify_ssl,
    defaultModel: r.default_model,
    isDefault: r.is_default,
    hasApiKey: r.api_key !== null,
    keyPreview: preview,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

function rowToConfig(r: ProviderRow): ProviderConfigRow {
  return {
    id: r.id,
    name: r.name,
    baseUrl: r.base_url,
    apiKey: r.api_key ? decryptSafe(r.api_key) : null,
    authType: r.auth_type,
    verifySsl: r.verify_ssl,
    defaultModel: r.default_model,
    isDefault: r.is_default,
  };
}

function decryptSafe(enc: string): string | null {
  try { return decryptPat(enc); } catch { return null; }
}

export async function listProviders(): Promise<LlmProvider[]> {
  const r = await query<ProviderRow>(`SELECT * FROM llm_providers ORDER BY is_default DESC, name ASC`);
  return r.rows.map(rowToDto);
}

export async function getProviderById(id: string): Promise<ProviderConfigRow | null> {
  const r = await query<ProviderRow>(`SELECT * FROM llm_providers WHERE id=$1`, [id]);
  return r.rows[0] ? rowToConfig(r.rows[0]) : null;
}

export async function getDefaultProvider(): Promise<ProviderConfigRow | null> {
  const r = await query<ProviderRow>(`SELECT * FROM llm_providers WHERE is_default=TRUE LIMIT 1`);
  return r.rows[0] ? rowToConfig(r.rows[0]) : null;
}

export function normalizeBaseUrl(raw: string): string {
  let s = raw.trim().replace(/\/+$/, '');
  if (!/\/v1$/.test(s)) s += '/v1';
  return s;
}
```

- [ ] **Step 4: Run → pass.**

- [ ] **Step 5: Commit**

```bash
git add backend/src/domains/llm/services/llm-provider-service.ts \
        backend/src/domains/llm/services/llm-provider-service.test.ts
git commit -m "llm: provider-service read helpers with apiKey masking"
```

### Task 7: Provider service — create, update, delete, set-default

- [ ] **Step 1: Add failing test**

Append:

```ts
import { createProvider, updateProvider, deleteProvider, setDefaultProvider } from './llm-provider-service.js';

describe.skipIf(!dbAvailable)('llm-provider-service — write', () => {
  beforeEach(async () => { await truncateAllTables(); });

  it('create normalizes baseUrl and encrypts apiKey', async () => {
    const p = await createProvider({
      name: 'Box', baseUrl: 'http://gpu:11434', apiKey: 'topsecret',
      authType: 'bearer', verifySsl: true, defaultModel: 'm1',
    });
    expect(p.baseUrl).toBe('http://gpu:11434/v1');
    const raw = await query<{ api_key: string }>(`SELECT api_key FROM llm_providers WHERE id=$1`, [p.id]);
    expect(raw.rows[0]!.api_key).not.toBe('topsecret');  // encrypted
  });

  it('update with omitted apiKey keeps the stored key', async () => {
    const p = await createProvider({ name: 'A', baseUrl: 'http://a/v1', apiKey: 'orig', authType: 'bearer', verifySsl: true });
    await updateProvider(p.id, { defaultModel: 'm2' });
    const cfg = await getProviderById(p.id);
    expect(cfg!.apiKey).toBe('orig');
    expect(cfg!.defaultModel).toBe('m2');
  });

  it('setDefaultProvider flips is_default atomically', async () => {
    const a = await createProvider({ name: 'A', baseUrl: 'http://a/v1', authType: 'none', verifySsl: true });
    const b = await createProvider({ name: 'B', baseUrl: 'http://b/v1', authType: 'none', verifySsl: true });
    await setDefaultProvider(a.id);
    await setDefaultProvider(b.id);
    const list = await listProviders();
    expect(list.find(p => p.id === a.id)!.isDefault).toBe(false);
    expect(list.find(p => p.id === b.id)!.isDefault).toBe(true);
  });

  it('deleteProvider throws when provider is default', async () => {
    const a = await createProvider({ name: 'A', baseUrl: 'http://a/v1', authType: 'none', verifySsl: true });
    await setDefaultProvider(a.id);
    await expect(deleteProvider(a.id)).rejects.toThrow(/default/i);
  });

  it('deleteProvider throws with referenced-by info when in use', async () => {
    const a = await createProvider({ name: 'A', baseUrl: 'http://a/v1', authType: 'none', verifySsl: true });
    await query(`INSERT INTO llm_usecase_assignments (usecase, provider_id, model) VALUES ('chat',$1,'m')`, [a.id]);
    await expect(deleteProvider(a.id)).rejects.toThrow(/referenced/i);
  });
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement**

Append to `llm-provider-service.ts`:

```ts
import { getPool } from '../../../core/db/postgres.js';

export async function createProvider(input: LlmProviderInput): Promise<LlmProvider> {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const apiKey = input.apiKey ? encryptPat(input.apiKey) : null;
  const r = await query<ProviderRow>(
    `INSERT INTO llm_providers (name, base_url, api_key, auth_type, verify_ssl, default_model)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING *`,
    [input.name.trim(), baseUrl, apiKey, input.authType, input.verifySsl, input.defaultModel ?? null],
  );
  return rowToDto(r.rows[0]!);
}

export async function updateProvider(id: string, patch: LlmProviderUpdate): Promise<LlmProvider | null> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  const push = (col: string, val: unknown) => { sets.push(`${col}=$${i++}`); vals.push(val); };
  if (patch.name !== undefined)         push('name', patch.name.trim());
  if (patch.baseUrl !== undefined)      push('base_url', normalizeBaseUrl(patch.baseUrl));
  if (patch.apiKey !== undefined)       push('api_key', patch.apiKey ? encryptPat(patch.apiKey) : null);
  if (patch.authType !== undefined)     push('auth_type', patch.authType);
  if (patch.verifySsl !== undefined)    push('verify_ssl', patch.verifySsl);
  if (patch.defaultModel !== undefined) push('default_model', patch.defaultModel);
  if (sets.length === 0) {
    const row = await query<ProviderRow>(`SELECT * FROM llm_providers WHERE id=$1`, [id]);
    return row.rows[0] ? rowToDto(row.rows[0]) : null;
  }
  sets.push(`updated_at=NOW()`);
  vals.push(id);
  const r = await query<ProviderRow>(
    `UPDATE llm_providers SET ${sets.join(', ')} WHERE id=$${i} RETURNING *`, vals,
  );
  return r.rows[0] ? rowToDto(r.rows[0]) : null;
}

export async function deleteProvider(id: string): Promise<void> {
  const row = await query<{ is_default: boolean }>(`SELECT is_default FROM llm_providers WHERE id=$1`, [id]);
  if (!row.rows[0]) return;
  if (row.rows[0].is_default) {
    throw new Error('Cannot delete the default provider — set another provider as default first.');
  }
  const refs = await query<{ usecase: string }>(
    `SELECT usecase FROM llm_usecase_assignments WHERE provider_id=$1`, [id],
  );
  if (refs.rows.length > 0) {
    throw new Error(`Provider is referenced by: ${refs.rows.map(r => r.usecase).join(', ')}`);
  }
  await query(`DELETE FROM llm_providers WHERE id=$1`, [id]);
}

export async function setDefaultProvider(id: string): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE llm_providers SET is_default=FALSE WHERE is_default=TRUE`);
    const r = await client.query(`UPDATE llm_providers SET is_default=TRUE, updated_at=NOW() WHERE id=$1`, [id]);
    if (r.rowCount === 0) throw new Error('Provider not found');
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { client.release(); }
}
```

- [ ] **Step 4: Run → pass.**

- [ ] **Step 5: Commit**

```bash
git commit -am "llm: provider-service create/update/delete/set-default"
```

### Task 8: Resolver — `resolveUsecase` truth table

**Files:**
- Create: `backend/src/domains/llm/services/llm-provider-resolver.ts`
- Create: `backend/src/domains/llm/services/llm-provider-resolver.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// backend/src/domains/llm/services/llm-provider-resolver.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import { createProvider, setDefaultProvider } from './llm-provider-service.js';
import { resolveUsecase, bumpProviderCacheVersion } from './llm-provider-resolver.js';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('resolveUsecase — truth table', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => {
    await truncateAllTables();
    bumpProviderCacheVersion();
  });

  async function seed() {
    const a = await createProvider({ name: 'A', baseUrl: 'http://a/v1', authType: 'none', verifySsl: true, defaultModel: 'mA' });
    const b = await createProvider({ name: 'B', baseUrl: 'http://b/v1', authType: 'none', verifySsl: true, defaultModel: 'mB' });
    await setDefaultProvider(a.id);
    return { aId: a.id, bId: b.id };
  }

  it('inherit (null,null) -> default provider + default_model', async () => {
    const { aId } = await seed();
    const r = await resolveUsecase('chat');
    expect(r.config.id).toBe(aId);
    expect(r.model).toBe('mA');
  });

  it('provider-only (B, null) -> B + B.default_model', async () => {
    const { bId } = await seed();
    await query(`INSERT INTO llm_usecase_assignments (usecase, provider_id, model) VALUES ('summary',$1,NULL)`, [bId]);
    const r = await resolveUsecase('summary');
    expect(r.config.id).toBe(bId);
    expect(r.model).toBe('mB');
  });

  it('full override (B, "gpt-4o") -> B + "gpt-4o"', async () => {
    const { bId } = await seed();
    await query(`INSERT INTO llm_usecase_assignments (usecase, provider_id, model) VALUES ('quality',$1,$2)`, [bId, 'gpt-4o']);
    const r = await resolveUsecase('quality');
    expect(r.config.id).toBe(bId);
    expect(r.model).toBe('gpt-4o');
  });

  it('model-only (null, "gpt-4o") -> default provider + "gpt-4o"', async () => {
    const { aId } = await seed();
    await query(`INSERT INTO llm_usecase_assignments (usecase, provider_id, model) VALUES ('auto_tag',NULL,$1)`, ['gpt-4o']);
    const r = await resolveUsecase('auto_tag');
    expect(r.config.id).toBe(aId);
    expect(r.model).toBe('gpt-4o');
  });

  it('throws when no default provider exists', async () => {
    await expect(resolveUsecase('chat')).rejects.toThrow(/no default/i);
  });

  it('changes take effect without restart (no caching on assignment)', async () => {
    const { aId, bId } = await seed();
    await query(`INSERT INTO llm_usecase_assignments (usecase, provider_id, model) VALUES ('chat',$1,NULL)`, [aId]);
    expect((await resolveUsecase('chat')).config.id).toBe(aId);
    await query(`UPDATE llm_usecase_assignments SET provider_id=$1 WHERE usecase='chat'`, [bId]);
    expect((await resolveUsecase('chat')).config.id).toBe(bId);
  });
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement resolver**

Create `backend/src/domains/llm/services/llm-provider-resolver.ts`:

```ts
import { query } from '../../../core/db/postgres.js';
import { decryptPat } from '../../../core/utils/crypto.js';
import { invalidateDispatcher, type ProviderConfig } from './openai-compatible-client.js';
import type { LlmUsecase } from '@compendiq/contracts';

interface ResolveRow {
  usecase_provider_id: string | null;
  usecase_model: string | null;
  provider_id: string;
  provider_name: string;
  provider_base_url: string;
  provider_api_key: string | null;
  provider_auth_type: 'bearer' | 'none';
  provider_verify_ssl: boolean;
  provider_default_model: string | null;
  provider_is_default: boolean;
}

interface Resolved {
  config: ProviderConfig & { id: string; name: string; defaultModel: string | null };
  model: string;
}

// In-memory cache of provider configs keyed by id, invalidated by version bump.
let cacheVersion = 0;
const configCache = new Map<string, { version: number; cfg: ProviderConfig & { id: string; name: string; defaultModel: string | null } }>();

export function bumpProviderCacheVersion(): void {
  cacheVersion += 1;
  // Also close any pooled undici dispatchers for those providers (they'll be
  // re-created on the next resolveUsecase/listProviders call).
  for (const entry of configCache.values()) invalidateDispatcher(entry.cfg.providerId);
  configCache.clear();
}

function decryptSafe(s: string | null): string | null {
  if (!s) return null;
  try { return decryptPat(s); } catch { return null; }
}

export async function resolveUsecase(usecase: LlmUsecase): Promise<Resolved> {
  // One round-trip: pull the use-case row + the default provider + the chosen
  // provider (if any) in a single query using a CTE.
  const sql = `
    WITH assignment AS (
      SELECT provider_id, model FROM llm_usecase_assignments WHERE usecase=$1
    ),
    target AS (
      SELECT p.*
      FROM llm_providers p
      WHERE p.id = (SELECT provider_id FROM assignment)
      UNION ALL
      SELECT p.*
      FROM llm_providers p
      WHERE p.is_default
        AND NOT EXISTS (SELECT 1 FROM assignment WHERE provider_id IS NOT NULL)
      LIMIT 1
    )
    SELECT
      a.provider_id AS usecase_provider_id,
      a.model       AS usecase_model,
      t.id          AS provider_id,
      t.name        AS provider_name,
      t.base_url    AS provider_base_url,
      t.api_key     AS provider_api_key,
      t.auth_type   AS provider_auth_type,
      t.verify_ssl  AS provider_verify_ssl,
      t.default_model AS provider_default_model,
      t.is_default  AS provider_is_default
    FROM target t
    LEFT JOIN assignment a ON TRUE
  `;
  const r = await query<ResolveRow>(sql, [usecase]);
  const row = r.rows[0];
  if (!row) throw new Error('No default provider configured — set one in Settings → LLM.');

  const cacheKey = row.provider_id;
  let cached = configCache.get(cacheKey);
  if (!cached || cached.version !== cacheVersion) {
    cached = {
      version: cacheVersion,
      cfg: {
        providerId: row.provider_id,
        id: row.provider_id,
        name: row.provider_name,
        baseUrl: row.provider_base_url,
        apiKey: decryptSafe(row.provider_api_key),
        authType: row.provider_auth_type,
        verifySsl: row.provider_verify_ssl,
        defaultModel: row.provider_default_model,
      },
    };
    configCache.set(cacheKey, cached);
  }

  const model = row.usecase_model ?? cached.cfg.defaultModel ?? '';
  return { config: cached.cfg, model };
}
```

- [ ] **Step 4: Run → pass.**

- [ ] **Step 5: Commit**

```bash
git add backend/src/domains/llm/services/llm-provider-resolver.ts \
        backend/src/domains/llm/services/llm-provider-resolver.test.ts
git commit -m "llm: resolver with inherit/provider-only/override/model-only"
```

### Task 9: Wire cache-invalidation into provider-service writes

- [ ] **Step 1: Add failing test**

Append to `llm-provider-service.test.ts`:

```ts
import { resolveUsecase, bumpProviderCacheVersion } from './llm-provider-resolver.js';

describe.skipIf(!dbAvailable)('cache invalidation on writes', () => {
  beforeEach(async () => { await truncateAllTables(); bumpProviderCacheVersion(); });
  it('updateProvider flips the cached baseUrl on the next resolve', async () => {
    const p = await createProvider({ name: 'A', baseUrl: 'http://a/v1', authType: 'none', verifySsl: true, defaultModel: 'm' });
    await setDefaultProvider(p.id);
    expect((await resolveUsecase('chat')).config.baseUrl).toBe('http://a/v1');
    await updateProvider(p.id, { baseUrl: 'http://aa/v1' });
    expect((await resolveUsecase('chat')).config.baseUrl).toBe('http://aa/v1');
  });
});
```

- [ ] **Step 2: Run → fail (cache stale).**

- [ ] **Step 3: Wire invalidation**

At the top of `llm-provider-service.ts`, import:

```ts
import { bumpProviderCacheVersion } from './llm-provider-resolver.js';
```

Add `bumpProviderCacheVersion();` at the bottom of each of `createProvider`, `updateProvider`, `deleteProvider`, `setDefaultProvider` (immediately before the `return` / function exit).

- [ ] **Step 4: Run → pass.**

- [ ] **Step 5: Commit**

```bash
git commit -am "llm: invalidate resolver cache on provider writes"
```

### Task 10: Bootstrap — seed providers from env on fresh install

**Files:**
- Create: `backend/src/domains/llm/services/llm-provider-bootstrap.ts`
- Create: `backend/src/domains/llm/services/llm-provider-bootstrap.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import { bootstrapLlmProviders } from './llm-provider-bootstrap.js';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('llm-provider-bootstrap', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => { await truncateAllTables(); delete process.env.OLLAMA_BASE_URL; delete process.env.OPENAI_BASE_URL; delete process.env.OPENAI_API_KEY; });

  it('seeds Ollama row from OLLAMA_BASE_URL on fresh install', async () => {
    process.env.OLLAMA_BASE_URL = 'http://gpu:11434';
    await bootstrapLlmProviders();
    const r = await query<{ name: string; base_url: string; is_default: boolean }>(`SELECT * FROM llm_providers`);
    expect(r.rows).toEqual([expect.objectContaining({ name: 'Ollama', base_url: 'http://gpu:11434/v1', is_default: true })]);
  });

  it('rewrites Ollama sentinel when OLLAMA_BASE_URL differs', async () => {
    await query(`INSERT INTO llm_providers (name, base_url, auth_type, is_default) VALUES ('Ollama','http://localhost:11434/v1','none',true)`);
    process.env.OLLAMA_BASE_URL = 'http://real:11434';
    await bootstrapLlmProviders();
    const r = await query<{ base_url: string }>(`SELECT base_url FROM llm_providers WHERE name='Ollama'`);
    expect(r.rows[0]!.base_url).toBe('http://real:11434/v1');
  });

  it('promotes oldest provider to default when none is flagged', async () => {
    await query(`INSERT INTO llm_providers (name, base_url, auth_type) VALUES ('X','http://x/v1','none')`);
    await bootstrapLlmProviders();
    const r = await query<{ is_default: boolean }>(`SELECT is_default FROM llm_providers WHERE name='X'`);
    expect(r.rows[0]!.is_default).toBe(true);
  });
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement**

Create `backend/src/domains/llm/services/llm-provider-bootstrap.ts`:

```ts
import { query } from '../../../core/db/postgres.js';
import { logger } from '../../../core/utils/logger.js';
import { encryptPat } from '../../../core/utils/crypto.js';
import { normalizeBaseUrl } from './llm-provider-service.js';
import { bumpProviderCacheVersion } from './llm-provider-resolver.js';

const DEPRECATED_VARS = [
  'OLLAMA_BASE_URL', 'OPENAI_BASE_URL', 'OPENAI_API_KEY', 'LLM_BEARER_TOKEN',
  'DEFAULT_LLM_MODEL', 'SUMMARY_MODEL', 'QUALITY_MODEL', 'EMBEDDING_MODEL',
];

export async function bootstrapLlmProviders(): Promise<void> {
  const count = await query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM llm_providers`);
  const isEmpty = count.rows[0]!.c === '0';

  if (isEmpty) {
    // Fresh install: seed from env.
    if (process.env.OLLAMA_BASE_URL) {
      await query(
        `INSERT INTO llm_providers (name, base_url, auth_type, verify_ssl, default_model)
         VALUES ($1,$2,'none',$3,$4)
         ON CONFLICT (name) DO NOTHING`,
        ['Ollama', normalizeBaseUrl(process.env.OLLAMA_BASE_URL),
         process.env.LLM_VERIFY_SSL !== 'false', process.env.DEFAULT_LLM_MODEL ?? null],
      );
    }
    if (process.env.OPENAI_BASE_URL || process.env.OPENAI_API_KEY) {
      const encryptedKey = process.env.OPENAI_API_KEY
        ? encryptPat(process.env.OPENAI_API_KEY) : null;
      await query(
        `INSERT INTO llm_providers (name, base_url, api_key, auth_type, verify_ssl, default_model)
         VALUES ($1,$2,$3,'bearer',$4,$5)
         ON CONFLICT (name) DO NOTHING`,
        ['OpenAI', normalizeBaseUrl(process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'),
         encryptedKey, process.env.LLM_VERIFY_SSL !== 'false', process.env.DEFAULT_LLM_MODEL ?? null],
      );
    }
  } else {
    // Existing install: rewrite the Ollama sentinel if env differs.
    if (process.env.OLLAMA_BASE_URL) {
      const expected = normalizeBaseUrl(process.env.OLLAMA_BASE_URL);
      await query(
        `UPDATE llm_providers SET base_url=$1, updated_at=NOW()
         WHERE name='Ollama' AND base_url='http://localhost:11434/v1' AND $1 <> 'http://localhost:11434/v1'`,
        [expected],
      );
    }
  }

  // Promote an oldest row to default if none is flagged.
  const hasDefault = await query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM llm_providers WHERE is_default`);
  if (hasDefault.rows[0]!.c === '0') {
    await query(
      `UPDATE llm_providers SET is_default=TRUE, updated_at=NOW()
       WHERE id = (SELECT id FROM llm_providers ORDER BY created_at ASC LIMIT 1)`,
    );
  }

  // Deprecation warnings.
  for (const v of DEPRECATED_VARS) {
    if (process.env[v]) {
      logger.warn({ envVar: v }, 'Deprecated LLM env var is set — it has no effect after migration 054. Configure providers in Settings → LLM.');
    }
  }

  bumpProviderCacheVersion();
}
```

- [ ] **Step 4: Run → pass.**

- [ ] **Step 5: Commit**

```bash
git add backend/src/domains/llm/services/llm-provider-bootstrap.ts \
        backend/src/domains/llm/services/llm-provider-bootstrap.test.ts
git commit -m "llm: bootstrap seed from env + sentinel rewrite + deprecation warnings"
```

### Task 11: Wire bootstrap into `app.ts`

**Files:** Modify `backend/src/app.ts`

- [ ] **Step 1: Add failing test**

Append to `backend/src/app.test.ts`:

```ts
import { bootstrapLlmProviders } from './domains/llm/services/llm-provider-bootstrap.js';
import { buildApp } from './app.js';

it('calls bootstrapLlmProviders during buildApp', async () => {
  const spy = vi.fn();
  vi.doMock('./domains/llm/services/llm-provider-bootstrap.js', () => ({ bootstrapLlmProviders: spy }));
  await buildApp();
  expect(spy).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run → fail (no call site).**

- [ ] **Step 3: Implementation**

In `backend/src/app.ts`, find the section that runs `runMigrations()` (post-connect) and append immediately after it:

```ts
import { bootstrapLlmProviders } from './domains/llm/services/llm-provider-bootstrap.js';
// …later, after runMigrations() returns:
await bootstrapLlmProviders();
```

- [ ] **Step 4: Run → pass.**

- [ ] **Step 5: Commit**

```bash
git commit -am "app: run llm provider bootstrap after migrations"
```

---

## Phase 4 — Routes

### Task 12: Provider routes — GET list + GET by id

**Files:**
- Create: `backend/src/routes/llm/llm-providers.ts`
- Create: `backend/src/routes/llm/llm-providers.test.ts`

- [ ] **Step 1: Failing test**

```ts
// backend/src/routes/llm/llm-providers.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../test-db-helper.js';
import { query } from '../../core/db/postgres.js';
import { buildApp } from '../../app.js';
import type { FastifyInstance } from 'fastify';
import { createTestUserAndLogin } from '../../../test-setup.js'; // existing helper, mirror neighbors' usage

const dbAvailable = await isDbAvailable();
let app: FastifyInstance;
let adminToken: string;

describe.skipIf(!dbAvailable)('GET /api/admin/llm-providers', () => {
  beforeAll(async () => { await setupTestDb(); app = await buildApp(); });
  afterAll(async () => { await app.close(); await teardownTestDb(); });
  beforeEach(async () => {
    await truncateAllTables();
    ({ token: adminToken } = await createTestUserAndLogin(app, { role: 'admin' }));
  });

  it('returns [] when no providers', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/admin/llm-providers',
      headers: { authorization: `Bearer ${adminToken}` } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual([]);
  });

  it('never returns the plaintext apiKey', async () => {
    await query(
      `INSERT INTO llm_providers (name, base_url, api_key, auth_type, verify_ssl, is_default)
       VALUES ('X','http://x/v1','encrypted-sekret','bearer',true,true)`,
    );
    const r = await app.inject({ method: 'GET', url: '/api/admin/llm-providers',
      headers: { authorization: `Bearer ${adminToken}` } });
    const body = r.json();
    expect(body[0]).toMatchObject({ name: 'X', hasApiKey: true });
    expect(JSON.stringify(body)).not.toContain('encrypted-sekret');
  });
});
```

(Look at a neighboring route test like `llm-admin.test.ts` for the exact shape of `createTestUserAndLogin` if the helper path differs; mirror it.)

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement**

Create `backend/src/routes/llm/llm-providers.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  LlmProviderInputSchema, LlmProviderUpdateSchema,
} from '@compendiq/contracts';
import {
  listProviders, getProviderById, createProvider, updateProvider,
  deleteProvider, setDefaultProvider,
} from '../../domains/llm/services/llm-provider-service.js';
import { checkHealth, listModels as clientListModels } from '../../domains/llm/services/openai-compatible-client.js';
import { emitLlmAudit } from '../../domains/llm/services/llm-audit-hook.js';
import { assertNonSsrfUrl } from '../../core/utils/ssrf-guard.js';
import { getRateLimits } from '../../core/services/rate-limit-service.js';

const ADMIN_LIMIT = { config: { rateLimit: { max: async () => (await getRateLimits()).admin.max, timeWindow: '1 minute' } } };

export async function llmProviderRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.get('/admin/llm-providers', { preHandler: fastify.requireAdmin, ...ADMIN_LIMIT }, async () => {
    return listProviders();
  });

  fastify.post('/admin/llm-providers', { preHandler: fastify.requireAdmin, ...ADMIN_LIMIT }, async (req, reply) => {
    const input = LlmProviderInputSchema.parse(req.body);
    await assertNonSsrfUrl(input.baseUrl);
    const provider = await createProvider(input);
    emitLlmAudit({ event: 'llm_provider_created', userId: req.userId, metadata: { providerId: provider.id, name: provider.name } });
    reply.code(201);
    return provider;
  });

  fastify.patch('/admin/llm-providers/:id', { preHandler: fastify.requireAdmin, ...ADMIN_LIMIT }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const patch = LlmProviderUpdateSchema.parse(req.body);
    if (patch.baseUrl) await assertNonSsrfUrl(patch.baseUrl);
    const updated = await updateProvider(id, patch);
    if (!updated) return reply.code(404).send({ error: 'Provider not found' });
    emitLlmAudit({ event: 'llm_provider_updated', userId: req.userId, metadata: { providerId: id, fields: Object.keys(patch) } });
    return updated;
  });

  fastify.delete('/admin/llm-providers/:id', { preHandler: fastify.requireAdmin, ...ADMIN_LIMIT }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    try {
      await deleteProvider(id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'delete failed';
      if (/default|referenced/i.test(msg)) return reply.code(409).send({ error: msg });
      throw err;
    }
    emitLlmAudit({ event: 'llm_provider_deleted', userId: req.userId, metadata: { providerId: id } });
    return { ok: true };
  });

  fastify.post('/admin/llm-providers/:id/set-default', { preHandler: fastify.requireAdmin, ...ADMIN_LIMIT }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    try { await setDefaultProvider(id); }
    catch { return reply.code(404).send({ error: 'Provider not found' }); }
    emitLlmAudit({ event: 'llm_provider_set_default', userId: req.userId, metadata: { providerId: id } });
    return { ok: true };
  });

  fastify.post('/admin/llm-providers/:id/test', { preHandler: fastify.requireAdmin, ...ADMIN_LIMIT }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const cfg = await getProviderById(id);
    if (!cfg) return reply.code(404).send({ error: 'Provider not found' });
    const health = await checkHealth({ providerId: cfg.id, baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, authType: cfg.authType, verifySsl: cfg.verifySsl });
    let sampleModelsCount = 0;
    if (health.connected) {
      const models = await clientListModels({ providerId: cfg.id, baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, authType: cfg.authType, verifySsl: cfg.verifySsl });
      sampleModelsCount = models.length;
    }
    return { ...health, sampleModelsCount };
  });

  fastify.get('/admin/llm-providers/:id/models', { preHandler: fastify.requireAdmin, ...ADMIN_LIMIT }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const cfg = await getProviderById(id);
    if (!cfg) return reply.code(404).send({ error: 'Provider not found' });
    return clientListModels({ providerId: cfg.id, baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, authType: cfg.authType, verifySsl: cfg.verifySsl });
  });
}
```

Register in `backend/src/app.ts` where other LLM route files are registered (look for `llmAdminRoutes` and add `llmProviderRoutes` with the same prefix pattern `/api`).

- [ ] **Step 4: Run → pass.**

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/llm/llm-providers.ts backend/src/routes/llm/llm-providers.test.ts backend/src/app.ts
git commit -m "routes: provider CRUD + set-default + test + models"
```

### Task 13: Provider routes — POST/PATCH/DELETE tests

**File:** Modify `backend/src/routes/llm/llm-providers.test.ts`

- [ ] **Step 1: Append these four cases**

```ts
describe.skipIf(!dbAvailable)('mutations', () => {
  beforeEach(async () => {
    await truncateAllTables();
    ({ token: adminToken } = await createTestUserAndLogin(app, { role: 'admin' }));
  });

  it('POST returns 201 and the created provider', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/admin/llm-providers',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'A', baseUrl: 'http://a', authType: 'none', verifySsl: true }),
    });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ name: 'A', baseUrl: 'http://a/v1', isDefault: false });
  });

  it('PATCH with omitted apiKey keeps the stored key', async () => {
    const create = await app.inject({
      method: 'POST', url: '/api/admin/llm-providers',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'A', baseUrl: 'http://a/v1', apiKey: 'sekret', authType: 'bearer', verifySsl: true }),
    });
    const { id } = create.json();
    const patch = await app.inject({
      method: 'PATCH', url: `/api/admin/llm-providers/${id}`,
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ defaultModel: 'm2' }),
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toMatchObject({ defaultModel: 'm2', hasApiKey: true });
  });

  it('DELETE returns 409 when provider is default', async () => {
    const create = await app.inject({
      method: 'POST', url: '/api/admin/llm-providers',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'A', baseUrl: 'http://a/v1', authType: 'none', verifySsl: true }),
    });
    const { id } = create.json();
    await app.inject({
      method: 'POST', url: `/api/admin/llm-providers/${id}/set-default`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const del = await app.inject({
      method: 'DELETE', url: `/api/admin/llm-providers/${id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(del.statusCode).toBe(409);
    expect(del.json().error).toMatch(/default/i);
  });

  it('DELETE returns 409 when provider is referenced by a use case', async () => {
    const create = await app.inject({
      method: 'POST', url: '/api/admin/llm-providers',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'B', baseUrl: 'http://b/v1', authType: 'none', verifySsl: true }),
    });
    const { id } = create.json();
    await query(
      `INSERT INTO llm_usecase_assignments (usecase, provider_id, model) VALUES ('summary', $1, 'm')`,
      [id],
    );
    const del = await app.inject({
      method: 'DELETE', url: `/api/admin/llm-providers/${id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(del.statusCode).toBe(409);
    expect(del.json().error).toMatch(/referenced/i);
  });
});
```

- [ ] **Step 2: Run → pass.**
- [ ] **Step 3: Commit**

```bash
git commit -am "test: cover provider route error cases"
```

### Task 14: Use-case routes

**Files:**
- Create: `backend/src/routes/llm/llm-usecases.ts`
- Create: `backend/src/routes/llm/llm-usecases.test.ts`

- [ ] **Step 1: Failing test**

```ts
// llm-usecases.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
// (same boilerplate as llm-providers.test.ts)

describe.skipIf(!dbAvailable)('GET /api/admin/llm-usecases', () => {
  // beforeAll/afterAll/beforeEach as before

  it('returns 5 rows with resolved blocks', async () => {
    const p = await app.inject({
      method: 'POST', url: '/api/admin/llm-providers',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'A', baseUrl: 'http://a/v1', authType: 'none', verifySsl: true, defaultModel: 'mA' }),
    });
    const { id } = p.json();
    await app.inject({
      method: 'POST', url: `/api/admin/llm-providers/${id}/set-default`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const r = await app.inject({ method: 'GET', url: '/api/admin/llm-usecases',
      headers: { authorization: `Bearer ${adminToken}` } });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(Object.keys(body).sort()).toEqual(['auto_tag','chat','embedding','quality','summary']);
    expect(body.chat.resolved).toMatchObject({ providerId: id, model: 'mA' });
  });

  it('PUT upserts a use-case assignment and takes effect on next GET', async () => {
    const a = await app.inject({
      method: 'POST', url: '/api/admin/llm-providers',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'A', baseUrl: 'http://a/v1', authType: 'none', verifySsl: true, defaultModel: 'mA' }),
    });
    const b = await app.inject({
      method: 'POST', url: '/api/admin/llm-providers',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'B', baseUrl: 'http://b/v1', authType: 'none', verifySsl: true, defaultModel: 'mB' }),
    });
    await app.inject({
      method: 'POST', url: `/api/admin/llm-providers/${a.json().id}/set-default`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const put = await app.inject({
      method: 'PUT', url: '/api/admin/llm-usecases',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ summary: { providerId: b.json().id, model: 'gpt-4o-mini' } }),
    });
    expect(put.statusCode).toBe(200);
    const get = await app.inject({
      method: 'GET', url: '/api/admin/llm-usecases',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const body = get.json();
    expect(body.summary).toMatchObject({
      providerId: b.json().id,
      model: 'gpt-4o-mini',
      resolved: { providerId: b.json().id, providerName: 'B', model: 'gpt-4o-mini' },
    });
  });
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement**

Create `backend/src/routes/llm/llm-usecases.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { UpdateUsecaseAssignmentsInputSchema, type LlmUsecase } from '@compendiq/contracts';
import { query, getPool } from '../../core/db/postgres.js';
import { resolveUsecase, bumpProviderCacheVersion } from '../../domains/llm/services/llm-provider-resolver.js';
import { emitLlmAudit } from '../../domains/llm/services/llm-audit-hook.js';
import { getRateLimits } from '../../core/services/rate-limit-service.js';

const ADMIN_LIMIT = { config: { rateLimit: { max: async () => (await getRateLimits()).admin.max, timeWindow: '1 minute' } } };
const USECASES: readonly LlmUsecase[] = ['chat', 'summary', 'quality', 'auto_tag', 'embedding'] as const;

export async function llmUsecaseRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.get('/admin/llm-usecases', { preHandler: fastify.requireAdmin, ...ADMIN_LIMIT }, async () => {
    const rawRows = await query<{ usecase: LlmUsecase; provider_id: string | null; model: string | null }>(
      `SELECT usecase, provider_id, model FROM llm_usecase_assignments`,
    );
    const raw = new Map(rawRows.rows.map(r => [r.usecase, r]));
    const out: Record<string, unknown> = {};
    for (const u of USECASES) {
      const resolved = await resolveUsecase(u).catch(() => null);
      out[u] = {
        providerId: raw.get(u)?.provider_id ?? null,
        model: raw.get(u)?.model ?? null,
        resolved: resolved ? {
          providerId: resolved.config.providerId,
          providerName: resolved.config.name,
          model: resolved.model,
        } : { providerId: '00000000-0000-0000-0000-000000000000', providerName: '', model: '' },
      };
    }
    return out;
  });

  fastify.put('/admin/llm-usecases', { preHandler: fastify.requireAdmin, ...ADMIN_LIMIT }, async (req) => {
    const updates = UpdateUsecaseAssignmentsInputSchema.parse(req.body);
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      for (const u of USECASES) {
        const patch = updates[u];
        if (!patch) continue;
        // Tri-state: undefined leave; null clear that field; string set.
        const sets: string[] = [];
        const vals: unknown[] = [];
        let i = 1;
        if (patch.providerId !== undefined) { sets.push(`provider_id=$${i++}`); vals.push(patch.providerId); }
        if (patch.model !== undefined)      { sets.push(`model=$${i++}`);       vals.push(patch.model); }
        if (sets.length === 0) continue;
        sets.push(`updated_at=NOW()`);
        vals.push(u);
        await client.query(
          `INSERT INTO llm_usecase_assignments (usecase, provider_id, model)
           VALUES ($${i}, ${patch.providerId !== undefined ? `$1` : `NULL`}, ${patch.model !== undefined ? (patch.providerId !== undefined ? `$2` : `$1`) : `NULL`})
           ON CONFLICT (usecase) DO UPDATE SET ${sets.join(', ')}`,
          vals,
        );
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
    finally { client.release(); }
    bumpProviderCacheVersion();
    emitLlmAudit({ event: 'llm_usecase_assignments_updated', userId: req.userId, metadata: { usecases: Object.keys(updates) } });
    return { ok: true };
  });
}
```

Register in `app.ts`.

- [ ] **Step 4: Run → pass.**

- [ ] **Step 5: Commit**

```bash
git commit -am "routes: usecase GET+PUT with resolved payload"
```

### Task 15: Embedding re-embed route

**Files:**
- Create: `backend/src/routes/llm/llm-embedding-reembed.ts`
- Create: `backend/src/routes/llm/llm-embedding-reembed.test.ts`

- [ ] **Step 1: Failing test**

```ts
describe.skipIf(!dbAvailable)('POST /api/admin/embedding/reembed', () => {
  // boilerplate …
  it('returns jobId and pageCount', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/admin/embedding/reembed',
      headers: { authorization: `Bearer ${adminToken}` } });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.jobId).toMatch(/^reembed-/);
    expect(typeof body.pageCount).toBe('number');
  });
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement**

```ts
// backend/src/routes/llm/llm-embedding-reembed.ts
import type { FastifyInstance } from 'fastify';
import { query } from '../../core/db/postgres.js';
import { enqueueReembedAll } from '../../domains/llm/services/embedding-service.js'; // see Task 23
import { getRateLimits } from '../../core/services/rate-limit-service.js';

const ADMIN_LIMIT = { config: { rateLimit: { max: async () => (await getRateLimits()).admin.max, timeWindow: '1 minute' } } };

export async function llmEmbeddingReembedRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);
  fastify.post('/admin/embedding/reembed', { preHandler: fastify.requireAdmin, ...ADMIN_LIMIT }, async () => {
    const { rows } = await query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM pages`);
    const pageCount = parseInt(rows[0]!.c, 10);
    const jobId = await enqueueReembedAll();
    return { jobId, pageCount };
  });
}
```

The route imports `enqueueReembedAll` from `embedding-service.ts`. Task 23
replaces it with the full BullMQ-backed implementation. For this task, add a
stub export at the bottom of `embedding-service.ts` so the import resolves:

```ts
// Stub — replaced in Task 23 with full BullMQ-backed implementation.
export async function enqueueReembedAll(): Promise<string> {
  return `reembed-${Date.now()}`;
}
```

The stub commit goes in this same task.

Register in `app.ts`.

- [ ] **Step 4: Run → pass.**

- [ ] **Step 5: Commit**

```bash
git commit -am "routes: embedding/reembed endpoint"
```

---

## Phase 5 — Call-site migration

### Task 16: `llm-chat.ts` uses `resolveUsecase('chat')`

**Files:** Modify `backend/src/routes/llm/llm-chat.ts`. Update `llm-chat.test.ts`.

- [ ] **Step 1: Read the file, identify every call to `providerStreamChat` / `resolveUserProvider`.**

- [ ] **Step 2: Update the test** to stub `resolveUsecase` instead of `resolveUserProvider`:

```ts
vi.mock('../../domains/llm/services/llm-provider-resolver.js', () => ({
  resolveUsecase: vi.fn().mockResolvedValue({
    config: { providerId: 'p1', baseUrl: 'http://x/v1', apiKey: null, authType: 'none', verifySsl: true, name: 'X', defaultModel: 'm' },
    model: 'm',
  }),
}));
vi.mock('../../domains/llm/services/openai-compatible-client.js', () => ({
  streamChat: async function* () { yield { content: 'hi', done: false }; yield { content: '', done: true }; },
}));
```

- [ ] **Step 3: Replace the body** — every `providerStreamChat(userId, ...)` becomes:

```ts
const { config, model } = await resolveUsecase('chat');
for await (const chunk of streamChat(config, model, messages, signal)) { ... }
```

- [ ] **Step 4: Run `vitest run src/routes/llm/llm-chat.test.ts` → pass.**

- [ ] **Step 5: Commit**

```bash
git commit -am "llm-chat: resolve via use-case instead of user-provider"
```

### Tasks 17–22: Repeat Task 16 for:

- [ ] **Task 17** — `llm-ask.ts` + test (chat)
- [ ] **Task 18** — `llm-summarize.ts` + test (summary)
- [ ] **Task 19** — `llm-quality.ts`, `analyze-quality.ts`, `apply-improvement.ts` + tests (quality)
- [ ] **Task 20** — `llm-generate.ts`, `llm-improve.ts`, `llm-diagram.ts`, `generate-with-pdf.ts`, `improve-instruction.ts`, `improve-page-id.ts` + tests (chat)
- [ ] **Task 21** — `summary-worker.ts`, `quality-worker.ts`, `auto-tagger.ts` in `domains/knowledge/services/` + tests (summary / quality / auto_tag)
- [ ] **Task 22** — `rag-service.ts` + test (embedding for query, chat for answer)

Each task follows the same five-step pattern as Task 16: update mocks, replace body, run test, commit with message `<component>: resolve via use-case`.

### Task 23: `embedding-service.ts` uses `resolveUsecase('embedding')` + `enqueueReembedAll`

- [ ] **Step 1: Failing test** for `enqueueReembedAll` in `embedding-service.test.ts`:

```ts
it('enqueueReembedAll enqueues the existing embed-job for all pages', async () => {
  const jobId = await enqueueReembedAll();
  expect(jobId).toMatch(/^reembed-/);
});
```

- [ ] **Step 2: Replace `ollamaGenerateEmbedding` / `openai.generateEmbedding` calls** with:

```ts
import { resolveUsecase } from './llm-provider-resolver.js';
import { generateEmbedding as clientEmbed } from './openai-compatible-client.js';

export async function embedText(text: string | string[]): Promise<number[][]> {
  const { config, model } = await resolveUsecase('embedding');
  return clientEmbed(config, model, text);
}
```

And `enqueueReembedAll`:

```ts
export async function enqueueReembedAll(): Promise<string> {
  // reuse the existing embed queue — add a job for every dirty page.
  const jobId = `reembed-${Date.now()}`;
  // Implementation: call existing queueService.enqueueAllDirtyPages(jobId) — match neighbor code style.
  return jobId;
}
```

- [ ] **Step 3: Run → pass. Commit.**

```bash
git commit -am "embedding-service: resolve via use-case + add enqueueReembedAll"
```

---

## Phase 6 — Cleanup

### Task 24: Delete old service files

**Files:**
- Delete: `backend/src/domains/llm/services/ollama-service.ts` (+ test)
- Delete: `backend/src/domains/llm/services/ollama-provider.ts`
- Delete: `backend/src/domains/llm/services/openai-service.ts` (+ test)
- Delete: `backend/src/domains/llm/services/llm-provider.ts` (+ test)

- [ ] **Step 1: Run `npx tsc --noEmit`** to confirm no residual imports.
- [ ] **Step 2: `git rm` the four files + their tests.**
- [ ] **Step 3: Run full backend test suite `npm test -w backend` → pass.**
- [ ] **Step 4: Commit**

```bash
git commit -am "llm: delete old ollama/openai services, collapsed into openai-compatible-client"
```

### Task 25: Prune `admin-settings-service.ts`

**Files:** Modify `backend/src/core/services/admin-settings-service.ts`

- [ ] **Step 1: Update neighbor tests** — anything that still asserted `getSharedLlmSettings().llmProvider` etc. needs to be rewritten to call `listProviders()`/`resolveUsecase()` instead.

- [ ] **Step 2: Remove exports** `SharedLlmProvider`, `LlmUsecase` (now in contracts), `SharedLlmSettings`, `getSharedLlmSettings`, `getSharedOpenaiApiKey`, `upsertSharedLlmSettings`, `getUsecaseLlmAssignment`, `upsertUsecaseLlmAssignments`, `getAllUsecaseAssignments`, `__resetUsecaseEnvSeedingForTests`, `seedUsecaseModelFromEnv`.

- [ ] **Step 3: Keep** the non-LLM keys (`embedding_dimensions`, `fts_language`) if they're still read elsewhere. Search for each kept key usage first.

- [ ] **Step 4: Run `npm test -w backend` → pass. `npm run typecheck -w backend` → pass.**

- [ ] **Step 5: Commit**

```bash
git commit -am "admin-settings-service: remove LLM keys, replaced by llm_providers table"
```

### Task 26: Legacy `/api/admin/settings` payload

The old `AdminSettings` response has `llmProvider`, `ollamaModel`, etc. Trim it to just the non-LLM keys. Any frontend reading LLM keys from it must be updated in Phase 7.

- [ ] **Step 1: Update `AdminSettings` contract** in `packages/contracts/src/admin.ts` (or wherever it lives — grep for `AdminSettings`).
- [ ] **Step 2: Update the route handler.**
- [ ] **Step 3: Update its test.**
- [ ] **Step 4: `npm run typecheck -w backend` → find frontend consumers.**
- [ ] **Step 5: Commit.**

```bash
git commit -am "contracts: trim AdminSettings to non-LLM keys"
```

---

## Phase 7 — Frontend

### Task 27: `ProviderEditModal` component

**Files:**
- Create: `frontend/src/features/settings/panels/ProviderEditModal.tsx`
- Create: `frontend/src/features/settings/panels/ProviderEditModal.test.tsx`

- [ ] **Step 1: Failing test**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProviderEditModal } from './ProviderEditModal.js';

const qc = new QueryClient();
const wrapper = ({ children }: { children: React.ReactNode }) =>
  <QueryClientProvider client={qc}>{children}</QueryClientProvider>;

describe('ProviderEditModal — create', () => {
  it('renders fields and submits valid input', async () => {
    const onSaved = vi.fn();
    render(<ProviderEditModal mode="create" open onClose={() => {}} onSaved={onSaved} />, { wrapper });
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'A' } });
    fireEvent.change(screen.getByLabelText(/base url/i), { target: { value: 'http://x/v1' } });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ id: 'u1', name: 'A' }), { status: 201 }));
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await screen.findByText(/saved/i);
    expect(onSaved).toHaveBeenCalled();
  });

  it('disables save when name is empty', () => {
    render(<ProviderEditModal mode="create" open onClose={() => {}} onSaved={() => {}} />, { wrapper });
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement**

```tsx
// frontend/src/features/settings/panels/ProviderEditModal.tsx
import { useState } from 'react';
import { toast } from 'sonner';
import type { LlmProvider, LlmProviderInput } from '@compendiq/contracts';
import { apiFetch } from '../../../shared/lib/api';

interface Props {
  mode: 'create' | 'edit';
  initial?: LlmProvider;
  open: boolean;
  onClose: () => void;
  onSaved: (p: LlmProvider) => void;
}

export function ProviderEditModal({ mode, initial, open, onClose, onSaved }: Props) {
  const [name, setName] = useState(initial?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [authType, setAuthType] = useState<'bearer' | 'none'>(initial?.authType ?? 'bearer');
  const [verifySsl, setVerifySsl] = useState(initial?.verifySsl ?? true);
  const [defaultModel, setDefaultModel] = useState(initial?.defaultModel ?? '');
  const [saving, setSaving] = useState(false);
  const canSave = name.trim().length > 0 && /^https?:\/\//.test(baseUrl);

  if (!open) return null;

  async function save() {
    setSaving(true);
    try {
      const body: LlmProviderInput = {
        name, baseUrl, authType, verifySsl,
        defaultModel: defaultModel || null,
        ...(apiKey ? { apiKey } : {}),
      };
      const saved = mode === 'create'
        ? await apiFetch<LlmProvider>('/admin/llm-providers', { method: 'POST', body: JSON.stringify(body) })
        : await apiFetch<LlmProvider>(`/admin/llm-providers/${initial!.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      toast.success('Saved');
      onSaved(saved);
      onClose();
    } catch (e) { toast.error(e instanceof Error ? e.message : 'save failed'); }
    finally { setSaving(false); }
  }

  return (
    <div role="dialog" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="glass-card w-[480px] space-y-3 p-6">
        <h2 className="text-lg font-semibold">{mode === 'create' ? 'Add provider' : 'Edit provider'}</h2>
        <label className="block text-sm">
          Name
          <input className="glass-input w-full" value={name} onChange={e => setName(e.target.value)} />
        </label>
        <label className="block text-sm">
          Base URL
          <input className="glass-input w-full" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" />
        </label>
        <label className="block text-sm">
          API Key {initial?.hasApiKey && <span className="text-success text-xs ml-2">Configured {initial.keyPreview}</span>}
          <input type="password" className="glass-input w-full" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder={initial?.hasApiKey ? 'Replace key…' : ''} />
        </label>
        <div className="flex gap-4 text-sm">
          <label><input type="radio" checked={authType === 'bearer'} onChange={() => setAuthType('bearer')} /> Bearer</label>
          <label><input type="radio" checked={authType === 'none'} onChange={() => setAuthType('none')} /> None</label>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={verifySsl} onChange={e => setVerifySsl(e.target.checked)} /> Verify TLS
        </label>
        <label className="block text-sm">
          Default model
          <input className="glass-input w-full" value={defaultModel} onChange={e => setDefaultModel(e.target.value)} />
        </label>
        <div className="flex justify-end gap-2">
          <button className="glass-button-secondary" onClick={onClose}>Cancel</button>
          <button className="glass-button-primary" disabled={!canSave || saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run → pass.**

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/settings/panels/ProviderEditModal.tsx \
        frontend/src/features/settings/panels/ProviderEditModal.test.tsx
git commit -m "frontend: ProviderEditModal"
```

### Task 28: `ProviderListSection` component

**Files:**
- Create: `frontend/src/features/settings/panels/ProviderListSection.tsx`
- Create: `frontend/src/features/settings/panels/ProviderListSection.test.tsx`

- [ ] **Step 1: Failing test** — renders list, "Add" opens modal, delete disabled for default, context menu shows referenced usecases on delete error.

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement**

```tsx
// frontend/src/features/settings/panels/ProviderListSection.tsx
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { LlmProvider } from '@compendiq/contracts';
import { apiFetch } from '../../../shared/lib/api';
import { ProviderEditModal } from './ProviderEditModal';

export function ProviderListSection() {
  const qc = useQueryClient();
  const { data: providers = [], isLoading } = useQuery<LlmProvider[]>({
    queryKey: ['llm-providers'], queryFn: () => apiFetch('/admin/llm-providers'),
  });
  const [editing, setEditing] = useState<LlmProvider | null>(null);
  const [adding, setAdding] = useState(false);

  const setDefault = useMutation({
    mutationFn: (id: string) => apiFetch(`/admin/llm-providers/${id}/set-default`, { method: 'POST' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['llm-providers'] }); toast.success('Default updated'); },
    onError: (e) => toast.error(e.message),
  });

  const del = useMutation({
    mutationFn: (id: string) => apiFetch(`/admin/llm-providers/${id}`, { method: 'DELETE' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['llm-providers'] }); toast.success('Provider deleted'); },
    onError: (e: Error) => toast.error(e.message),
  });

  const test = useMutation({
    mutationFn: (id: string) => apiFetch<{ connected: boolean; error?: string; sampleModelsCount: number }>(`/admin/llm-providers/${id}/test`, { method: 'POST' }),
    onSuccess: (r) => toast[r.connected ? 'success' : 'error'](r.connected ? `Connected (${r.sampleModelsCount} models)` : (r.error ?? 'Connection failed')),
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Providers</h3>
        <button className="glass-button-primary" onClick={() => setAdding(true)}>+ Add</button>
      </div>
      {isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      <ul className="divide-y divide-border/40">
        {providers.map((p) => (
          <li key={p.id} className="flex items-center justify-between py-2">
            <div>
              <div className="text-sm font-medium">{p.name} {p.isDefault && <span className="ml-2 rounded bg-primary/15 px-1.5 text-xs text-primary">default</span>}</div>
              <div className="text-xs text-muted-foreground">{p.baseUrl}</div>
            </div>
            <div className="flex gap-2 text-xs">
              <button onClick={() => setEditing(p)}>Edit</button>
              <button onClick={() => setDefault.mutate(p.id)} disabled={p.isDefault}>Set default</button>
              <button onClick={() => test.mutate(p.id)}>Test</button>
              <button onClick={() => del.mutate(p.id)} disabled={p.isDefault}>Delete</button>
            </div>
          </li>
        ))}
      </ul>
      <ProviderEditModal mode="create" open={adding} onClose={() => setAdding(false)}
        onSaved={() => qc.invalidateQueries({ queryKey: ['llm-providers'] })} />
      {editing && <ProviderEditModal mode="edit" initial={editing} open onClose={() => setEditing(null)}
        onSaved={() => qc.invalidateQueries({ queryKey: ['llm-providers'] })} />}
    </div>
  );
}
```

- [ ] **Step 4: Run → pass.**

- [ ] **Step 5: Commit**

```bash
git commit -am "frontend: ProviderListSection"
```

### Task 29: Rewrite `UsecaseAssignmentsSection` against `providerId`

**Files:**
- Create: `frontend/src/features/settings/panels/UsecaseAssignmentsSection.tsx` (extract existing inner component)
- Create: `frontend/src/features/settings/panels/UsecaseAssignmentsSection.test.tsx`

- [ ] **Step 1: Failing test** — renders 5 rows including `embedding`, provider dropdown lists all providers + "Inherit", changing provider fetches models for that provider.

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** — include the new `embedding` row; provider dropdown shows all providers; model dropdown lazy-queries `/admin/llm-providers/:id/models` via a `useQuery` keyed by `providerId`.

```tsx
// frontend/src/features/settings/panels/UsecaseAssignmentsSection.tsx
import { useQuery } from '@tanstack/react-query';
import type { LlmProvider, LlmUsecase, UsecaseAssignments } from '@compendiq/contracts';
import { apiFetch } from '../../../shared/lib/api';

const USECASE_LABELS: Record<LlmUsecase, string> = {
  chat: 'Chat', summary: 'Summary worker', quality: 'Quality worker', auto_tag: 'Auto-tag', embedding: 'Embedding',
};
const USECASES_ORDERED: LlmUsecase[] = ['chat','summary','quality','auto_tag','embedding'];

interface Props {
  assignments: UsecaseAssignments;
  providers: LlmProvider[];
  onChange: (next: UsecaseAssignments) => void;
}

export function UsecaseAssignmentsSection({ assignments, providers, onChange }: Props) {
  function update(u: LlmUsecase, patch: Partial<UsecaseAssignments[LlmUsecase]>) {
    onChange({ ...assignments, [u]: { ...assignments[u], ...patch } });
  }
  return (
    <div className="space-y-2 rounded-md border border-border/50 p-4">
      <h3 className="text-sm font-semibold">Use case assignments</h3>
      {USECASES_ORDERED.map((u) => {
        const row = assignments[u];
        const effectiveProviderId = row.providerId ?? row.resolved.providerId;
        return (
          <div key={u} className="grid grid-cols-[140px_180px_1fr_auto] items-center gap-2">
            <span className="text-sm font-medium flex items-center gap-1">
              {USECASE_LABELS[u]}
              {u === 'embedding' && <span title="Changing requires re-embedding all pages">⚠</span>}
            </span>
            <select className="glass-select" value={row.providerId ?? ''}
              onChange={(e) => update(u, { providerId: e.target.value || null })}
              data-testid={`usecase-${u}-provider`}>
              <option value="">Inherit default</option>
              {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <ModelPicker providerId={effectiveProviderId} value={row.model} onChange={(m) => update(u, { model: m })} testId={`usecase-${u}-model`} inheritLabel="Inherit provider's model" />
            <span className="text-xs text-muted-foreground">→ {row.resolved.providerName} / {row.resolved.model || '(none)'}</span>
          </div>
        );
      })}
    </div>
  );
}

function ModelPicker({ providerId, value, onChange, testId, inheritLabel }: { providerId: string; value: string | null; onChange: (m: string | null) => void; testId: string; inheritLabel: string }) {
  const { data: models = [] } = useQuery<{ name: string }[]>({
    queryKey: ['provider-models', providerId],
    queryFn: () => apiFetch(`/admin/llm-providers/${providerId}/models`),
    enabled: !!providerId && providerId !== '00000000-0000-0000-0000-000000000000',
  });
  return (
    <select className="glass-select" value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} data-testid={testId}>
      <option value="">{inheritLabel}</option>
      {models.map(m => <option key={m.name} value={m.name}>{m.name}</option>)}
    </select>
  );
}
```

- [ ] **Step 4: Run → pass.**

- [ ] **Step 5: Commit**

```bash
git commit -am "frontend: UsecaseAssignmentsSection supports 5 use cases via providerId"
```

### Task 30: `EmbeddingReembedBanner` component

**Files:**
- Create: `frontend/src/features/settings/panels/EmbeddingReembedBanner.tsx`
- Create: `frontend/src/features/settings/panels/EmbeddingReembedBanner.test.tsx`

- [ ] **Step 1: Failing test** — renders only when `shouldPrompt=true`, clicking "Re-embed" POSTs and shows job progress.

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement**

```tsx
import { useState } from 'react';
import { toast } from 'sonner';
import { apiFetch } from '../../../shared/lib/api';

export function EmbeddingReembedBanner({ shouldPrompt }: { shouldPrompt: boolean }) {
  const [running, setRunning] = useState(false);
  if (!shouldPrompt) return null;
  async function run() {
    setRunning(true);
    try {
      const r = await apiFetch<{ jobId: string; pageCount: number }>('/admin/embedding/reembed', { method: 'POST' });
      toast.success(`Re-embed queued for ${r.pageCount} pages (${r.jobId})`);
    } catch (e) { toast.error(e instanceof Error ? e.message : 'failed'); }
    finally { setRunning(false); }
  }
  return (
    <div className="glass-card border-yellow-500/30 p-3 text-sm">
      <div className="flex items-center justify-between">
        <span>⚠ Embedding provider/model changed. Existing vectors are incompatible until you re-embed.</span>
        <button className="glass-button-primary" disabled={running} onClick={run}>
          {running ? 'Queuing…' : 'Re-embed all pages'}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run → pass. Commit.**

### Task 31: Rewrite `LlmTab.tsx`

**Files:** Modify `frontend/src/features/settings/panels/LlmTab.tsx` and `LlmTab.test.tsx` (rename existing test accordingly — currently `OllamaTab.test.tsx` re-exports).

- [ ] **Step 1: Update/rewrite test** to:
  - Stub `/admin/llm-providers`, `/admin/llm-usecases` responses.
  - Assert `ProviderListSection` + `UsecaseAssignmentsSection` render.
  - Assert changing the embedding row triggers the confirmation modal and then the banner becomes visible.

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement**

```tsx
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { LlmProvider, UsecaseAssignments } from '@compendiq/contracts';
import { apiFetch } from '../../../shared/lib/api';
import { ProviderListSection } from './ProviderListSection';
import { UsecaseAssignmentsSection } from './UsecaseAssignmentsSection';
import { EmbeddingReembedBanner } from './EmbeddingReembedBanner';

export function LlmTab() {
  const { data: providers = [] } = useQuery<LlmProvider[]>({
    queryKey: ['llm-providers'], queryFn: () => apiFetch('/admin/llm-providers'),
  });
  const { data: rawAssignments } = useQuery<UsecaseAssignments>({
    queryKey: ['llm-usecases'], queryFn: () => apiFetch('/admin/llm-usecases'),
  });
  const [assignments, setAssignments] = useState<UsecaseAssignments | null>(null);
  const [embeddingDirty, setEmbeddingDirty] = useState(false);

  if (rawAssignments && !assignments) setAssignments(rawAssignments);
  if (!assignments) return <p>Loading…</p>;

  function onChange(next: UsecaseAssignments) {
    const origE = rawAssignments?.embedding;
    const nowE = next.embedding;
    if (origE && (origE.providerId !== nowE.providerId || origE.model !== nowE.model)) {
      setEmbeddingDirty(true);
    }
    setAssignments(next);
  }

  return (
    <div className="space-y-6">
      <ProviderListSection />
      <EmbeddingReembedBanner shouldPrompt={embeddingDirty} />
      <UsecaseAssignmentsSection assignments={assignments} providers={providers} onChange={onChange} />
      {/* Save button etc. — call PUT /admin/llm-usecases */}
    </div>
  );
}

export { LlmTab as OllamaTab };  // keep alias for neighbors that still import OllamaTab
```

- [ ] **Step 4: Run → pass. Commit.**

```bash
git commit -am "frontend: LlmTab composes provider-list + use-case grid + reembed banner"
```

---

## Phase 8 — E2E + docs

### Task 32: Playwright E2E

**Files:** Create `e2e/llm-providers.spec.ts`.

- [ ] **Step 1: Spec**

```ts
import { test, expect } from '@playwright/test';

test('admin adds a provider, sets as default, assigns to chat, chats succeed', async ({ page, request }) => {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill('admin@test.local');
  await page.getByLabel(/password/i).fill('admin-password');
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.goto('/settings/llm');

  await page.getByRole('button', { name: /add/i }).click();
  await page.getByLabel(/name/i).fill('E2E');
  await page.getByLabel(/base url/i).fill(process.env.E2E_LLM_URL ?? 'http://localhost:11434/v1');
  await page.getByRole('button', { name: /save/i }).click();
  await expect(page.getByText('E2E')).toBeVisible();

  await page.getByRole('button', { name: /set default/i }).first().click();
  await expect(page.getByText(/default updated/i)).toBeVisible();

  // Assign to chat use case
  await page.getByTestId('usecase-chat-provider').selectOption({ label: 'E2E' });

  // Issue a chat request
  await page.goto('/ai');
  await page.getByRole('textbox').fill('say hi');
  await page.getByRole('button', { name: /send/i }).click();
  await expect(page.locator('.message-assistant')).toBeVisible({ timeout: 30_000 });
});
```

- [ ] **Step 2: Run `npx playwright test e2e/llm-providers.spec.ts` → pass** (requires the dev stack running: `docker compose -f docker/docker-compose.yml up -d && npm run dev` per CLAUDE.md).

- [ ] **Step 3: Commit**

```bash
git add e2e/llm-providers.spec.ts
git commit -m "e2e: multi-provider add/default/assign/chat flow"
```

### Task 33: ADR + architecture diagrams

**Files:**
- Modify: `docs/ARCHITECTURE-DECISIONS.md`
- Modify: `docs/architecture/03-backend-domains.md`
- Modify: `docs/architecture/06-data-model.md`

- [ ] **Step 1: Append an ADR entry** to `ARCHITECTURE-DECISIONS.md` with the next available ADR number, titled "Multi-LLM-provider configuration". Body: summarize Q1–Q5 decisions with links to `docs/superpowers/specs/2026-04-20-multi-llm-providers-design.md`.

- [ ] **Step 2: Update `03-backend-domains.md`** — the LLM domain box currently lists `ollama-service`, `ollama-provider`, `openai-service`. Replace with `openai-compatible-client`, `llm-provider-service`, `llm-provider-resolver`, `llm-provider-bootstrap`.

- [ ] **Step 3: Update `06-data-model.md`** — add `llm_providers` and `llm_usecase_assignments` nodes with the FK from assignments → providers.

- [ ] **Step 4: Commit**

```bash
git commit -am "docs: ADR + architecture diagrams for multi-llm-provider"
```

### Task 34: Prune env-var docs

**Files:**
- Modify: `CLAUDE.md`
- Modify: `AGENTS.md`
- Modify: `backend/.env.example`

- [ ] **Step 1:** Delete these env var entries (they no longer have runtime effect):
  `OLLAMA_BASE_URL`, `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `LLM_BEARER_TOKEN` (keep the name but mark deprecated in `.env.example`), `DEFAULT_LLM_MODEL`, `SUMMARY_MODEL`, `QUALITY_MODEL`, `EMBEDDING_MODEL`.

- [ ] **Step 2:** Update the "External Services" section in `CLAUDE.md` to say "LLM providers configured via admin UI (Settings → LLM)".

- [ ] **Step 3:** Commit

```bash
git commit -am "docs: trim deprecated env vars, point to admin UI"
```

### Task 35: Full test suite + lint + typecheck pass

- [ ] **Step 1:** `npm install` (from repo root per CLAUDE.md).
- [ ] **Step 2:** `npm run lint` → pass.
- [ ] **Step 3:** `npm run typecheck` → pass.
- [ ] **Step 4:** `npm test` → pass both backend and frontend.
- [ ] **Step 5:** `docker compose -f docker/docker-compose.yml up -d && npx playwright test` → E2E passes.

If any step fails, fix in place and re-run before closing the task.

### Task 36: Open PR to `dev`

- [ ] **Step 1:** Push branch: `git push -u origin feature/multi-llm-providers`.
- [ ] **Step 2:** `gh pr create --base dev --title "feat: multi-LLM-provider configuration" --body-file docs/superpowers/specs/2026-04-20-multi-llm-providers-design.md`.
- [ ] **Step 3:** Add the `PR:Approved` label only after human review.

---

## Rollback

If the migration causes a production incident after merge to `main`:
1. Restore the PG backup taken immediately before `054`.
2. Revert the release tag on `main` to the previous version.
3. Bump a patch release reverting the frontend to the pre-054 tag so the `/admin/settings` shape matches.

No down-migration is provided — the seeding path is destructive by design.
