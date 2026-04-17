# Plan: Per-Use-Case LLM Provider/Model Configuration (Issue #214)

**Branch:** `feature/214-per-usecase-llm-config` (from `dev`)
**Migration number:** `053` (verified — `052_seed_granular_permissions.sql` is current head)
**Risk:** Low — all changes are additive, falling back to existing behavior when no override is set.

---

## Goal

Let admins assign an optional `{provider, model}` override per LLM use case (`chat`, `summary`, `quality`, `auto_tag`), with each override falling back to the shared default. Move `SUMMARY_MODEL` / `QUALITY_MODEL` off env vars (DB-backed; env becomes deprecated bootstrap fallback). Changes take effect without restart.

Embedding stays on its existing `embedding_model` setting (per issue).

---

## 1. Data Model — new `admin_settings` keys

Eight new keys in the existing `admin_settings` (key, value) table — no schema change, just new rows.

| Use case   | Provider key                     | Model key                     |
| ---------- | -------------------------------- | ----------------------------- |
| chat       | `llm_usecase_chat_provider`      | `llm_usecase_chat_model`      |
| summary    | `llm_usecase_summary_provider`   | `llm_usecase_summary_model`   |
| quality    | `llm_usecase_quality_provider`   | `llm_usecase_quality_model`   |
| auto_tag   | `llm_usecase_auto_tag_provider`  | `llm_usecase_auto_tag_model`  |

**Semantics.** Row absent OR empty string = inherit shared default. Provider value is `'ollama' | 'openai'`. Model value is whatever the provider exposes.

**Why keys, not a JSON blob.** Matches the existing `admin_settings` pattern (`llm_provider`, `ollama_model`, `openai_model`, `embedding_model`, `fts_language`, `smtp_*`). Reuses the existing `unnest()` batch-upsert helper in `upsertSharedLlmSettings`. No domain migration.

### Migration `053_llm_usecase_assignments.sql`

Additive and idempotent. Seeds from env vars only when the DB row is absent. Migration is **additive-only** — rollback does not delete existing rows (see §10).

```sql
-- Migration 053: Per-use-case LLM provider/model assignments.
-- Seeds summary/quality use-case model rows from deprecated env vars on upgrade
-- so existing deployments don't regress. Provider defaults to inheriting the
-- shared default (row absent), which matches pre-migration behavior.
--
-- Idempotent via ON CONFLICT DO NOTHING — reruns are safe.

-- SUMMARY_MODEL -> llm_usecase_summary_model (env only, checked via current_setting
-- pattern is not available in migrations; seeded by app on first boot instead).
-- This migration intentionally does NOT read env vars — seeding from env is the
-- responsibility of the bootstrap path in admin-settings-service.ts (§2), which
-- runs every startup and is safe to rerun. Keeping env-to-DB seeding in TS means
-- we can log it, audit it, and test it.

-- No-op migration: documents the four new use-case key pairs but creates no rows.
-- The resolver (§2) treats missing rows as "inherit shared default".
SELECT 1; -- placeholder; the migration file exists to reserve slot 053 and
          -- document the new key namespace for schema reviewers.
```

**Decision:** seed from env in TS, not SQL. Reason: the migration runner has no access to `process.env` reliably (runs from a pooled client), we want structured logging on seed, and env-to-DB seeding must only happen once per key (honor "env = bootstrap fallback only"). A one-line `SELECT 1;` migration keeps the slot reserved so the next PR doesn't collide.

**Alternative considered:** have the migration insert hardcoded defaults. Rejected — then admins who *already* set the env var would get stale seeds on restart, breaking "DB is source of truth".

---

## 2. Resolver — `getUsecaseLlmAssignment(usecase)`

**Location:** extend `backend/src/core/services/admin-settings-service.ts` (sibling to `getSharedLlmSettings`). Keeps domain boundary: core service, no domain imports. No new file needed — fits the existing `admin-settings-service` surface.

### Signature

```ts
export type LlmUsecase = 'chat' | 'summary' | 'quality' | 'auto_tag';

export interface UsecaseLlmAssignment {
  provider: SharedLlmProvider;        // always resolved (never undefined)
  model: string;                       // may be '' if no default configured anywhere
  source: {
    provider: 'usecase' | 'shared' | 'default';
    model:    'usecase' | 'shared' | 'env' | 'default';
  };
}

export async function getUsecaseLlmAssignment(
  usecase: LlmUsecase,
): Promise<UsecaseLlmAssignment>;
```

### Fallback order

Per field, independently:

**Provider:** `llm_usecase_<name>_provider` (DB) → shared `llm_provider` (DB) → `'ollama'` (default constant).

**Model:** `llm_usecase_<name>_model` (DB) → shared model matching the resolved provider (`ollama_model` or `openai_model` from DB) → env bootstrap (`SUMMARY_MODEL` for summary, `QUALITY_MODEL` for quality, `DEFAULT_LLM_MODEL` for all four) → `''`.

Note: provider and model are resolved **independently**, so an admin can override only the provider and still inherit the shared model for that provider, or vice versa.

### Env-bootstrap seeding (one-shot)

On **every call** to `getUsecaseLlmAssignment`, if the DB row for the model key is absent AND the relevant env var is set AND we haven't already seeded this key this process, write the env value into `admin_settings` via the same `unnest()` upsert pattern used elsewhere. Track seeded keys in a module-level `Set<string>` to avoid redundant writes.

Rationale: mirrors the `COMPENDIQ_LICENSE_KEY` pattern called out in `CLAUDE.md` (env = deprecated bootstrap, DB is source of truth). Admins editing the DB value will have it take precedence immediately because the seed only runs when the row is absent.

### Caching strategy (critical — must not block "runtime change without restart")

**No in-process cache.** Each call hits `admin_settings` with a single `SELECT ... WHERE setting_key = ANY(...)`. The existing `getSharedLlmSettings` does the same, and it's called per-request today with no perf issue.

If a hot-path profile later shows this as a bottleneck, add a short-TTL Redis cache (say, 30s) keyed on `admin_settings_llm_usecase_<name>` — but the invalidation rule must be: any PUT to `/admin/settings` or the new `/admin/settings/llm-usecases` endpoint invalidates all keys with prefix `admin_settings_llm_usecase_`. **Not in this PR** — keep it simple and prove the need first.

**Explicitly rejected:** module-level `let cache` with no TTL. That would reintroduce the "restart required" bug the issue is fixing.

### Upsert helper

```ts
export async function upsertUsecaseLlmAssignments(
  updates: Partial<Record<LlmUsecase, { provider?: SharedLlmProvider | null; model?: string | null }>>,
): Promise<void>;
```

Semantics: `null` for either field deletes the DB row (revert to inherited default). `undefined` leaves the key untouched. Reuses the existing batch `unnest()` upsert + `ANY()` delete pattern from `upsertSharedLlmSettings` (lines 135–155 of `admin-settings-service.ts`).

---

## 3. Call-site changes

Four services change. Each is a one-line swap + import adjustment. No behavior change when no overrides are set (resolver returns the same shared default they already use).

### 3a. `backend/src/domains/knowledge/services/summary-worker.ts`

- **Delete** line 33: `const SUMMARY_MODEL = process.env.SUMMARY_MODEL ?? process.env.DEFAULT_LLM_MODEL ?? '';`
- **Rewrite** `resolveSummaryModel()` (lines 66–73): call `getUsecaseLlmAssignment('summary')`, return `.model`.
- **Delete** lines 276–283 inside `runSummaryBatch`: the duplicated inline fallback. Replace with `const { model: resolvedModel } = await getUsecaseLlmAssignment('summary');` (or accept the explicit `model` parameter as-is, falling through to the resolver when absent).
- **Update** the warn log at line 285 to reference "admin settings → Summary use case" instead of env var names.
- **Provider routing.** The worker currently calls `summarizeContent(model, ...)` from `ollama-service.ts` which routes through `getActiveProvider()` — i.e., it respects the *shared* provider only. To honor a use-case provider override, switch to `providerStreamChat(userId, model, messages)` from `llm-provider.ts`. **But** `providerStreamChat` needs a userId and the summary worker has none. **Decision:** add a new `providerStreamChatForUsecase(provider, model, messages)` overload in `llm-provider.ts` that takes an explicit provider instead of looking it up per-user. Summary worker calls this with the resolver's `{provider, model}`.
- `getSummaryStatus` (line 75) — call resolver, return resolved `model` in the response so the UI can show what's actually being used.

### 3b. `backend/src/domains/knowledge/services/quality-worker.ts`

- **Delete** line 20: `const QUALITY_MODEL_ENV = ...`.
- **Rewrite** `resolveQualityModel()` (lines 26–33): call `getUsecaseLlmAssignment('quality')`, fall through to `'qwen3:4b'` when the resolver returns an empty string (preserve existing hardcoded fallback — acceptance criteria doesn't ask to remove it, and it's the only thing keeping the worker working on a fresh install).
- **Update** logger line 344: replace `QUALITY_MODEL_ENV || '(from admin settings)'` with `(await resolveQualityModel())`.
- Same provider-routing concern as summary — `collectStreamedResponse` uses `streamChat` from `ollama-service.ts`. Swap to the new `providerStreamChatForUsecase`.

### 3c. `backend/src/domains/knowledge/services/auto-tagger.ts`

Auto-tagger is different: the `model` parameter is always supplied by the caller (route receives `{ model: string }` in the body — see `backend/src/routes/knowledge/pages-tags.ts:10,25`). So the resolver applies at the **route layer** as a default when the frontend doesn't supply one.

- No change in `auto-tagger.ts` itself.
- In `pages-tags.ts`, when `request.body.model` is absent/empty, resolve via `getUsecaseLlmAssignment('auto_tag')`. This preserves backward compat while enabling the new override.
- Better: widen `AutoTagBodySchema` to `z.object({ model: z.string().min(1).optional() })` and fall back to the resolver when absent. Frontend can then stop asking the user to pick a model for auto-tag.

### 3d. Chat routes — `llm-ask.ts`, `llm-chat` (wherever), `llm-improve.ts`, `llm-generate.ts`, `llm-summarize.ts`, `llm-quality.ts`, `llm-diagram.ts`

All of these already take `model` from the request body. **No change in this PR** — the user picks a model in the frontend. The `chat` use-case assignment is *used by the frontend as the default* for the model picker. Backend keeps honoring whatever the frontend sent.

**Exception:** if a chat route has a server-side default fallback (grep shows none today), it should route via the `chat` use-case. Call-site audit in §5c.

---

## 4. Admin API

### Extend the existing `/api/admin/settings` endpoint — single round-trip

**Decision: extend, not split.** The existing `GET /admin/settings` and `PUT /admin/settings` already aggregate 14+ settings. Adding `usecaseAssignments` keeps the admin UI's single-save UX intact and avoids a second mutation. The `Partial<...>` merge semantics of `upsertSharedLlmSettings` generalize cleanly.

### GET `/api/admin/settings` — add to response

```ts
{
  // ... existing fields unchanged
  usecaseAssignments: {
    chat:     { provider: 'ollama' | 'openai' | null, model: string | null, resolved: { provider: 'ollama' | 'openai', model: string } },
    summary:  { ... },
    quality:  { ... },
    auto_tag: { ... },
  }
}
```

Each entry: `provider`/`model` = the raw DB override (or `null` if inheriting); `resolved` = what the resolver actually returns right now (for UI display — "currently using: ollama / qwen3:4b (inherited from shared default)").

**Route code:** in `backend/src/routes/foundation/admin.ts` `GET /admin/settings` handler (lines 229–270), add a `Promise.all([...])` branch that calls a new `getAllUsecaseAssignments()` (one query selecting all 8 keys, plus 4 resolver calls for `resolved`).

### PUT `/api/admin/settings` — accept

```ts
{
  // ... existing fields unchanged
  usecaseAssignments: Partial<Record<LlmUsecase, { provider?: 'ollama' | 'openai' | null, model?: string | null }>>
}
```

`null` clears the override. `undefined` leaves it untouched. Calls `upsertUsecaseLlmAssignments` under the same transaction path already used for LLM changes (lines 323–333).

**Validation:** Zod refinement — if `provider` is `'openai'` and the corresponding model is set but the shared openai config has no API key configured, **do not reject** (admin may be setting up in stages), but the `getUsecaseLlmAssignment` call at runtime will fall back gracefully when the provider is unusable. Keep the API permissive.

Audit log: include `usecaseAssignments` keys in the existing `logAuditEvent` call (line 432–438) with sensitive-free payload (provider/model names are not secrets).

### Contract additions — `packages/contracts/src/schemas/admin.ts`

Add to both `AdminSettingsSchema` and `UpdateAdminSettingsSchema`:

```ts
export const LlmUsecaseSchema = z.enum(['chat', 'summary', 'quality', 'auto_tag']);

export const UsecaseAssignmentSchema = z.object({
  provider: LlmProviderSchema.nullable(),
  model: z.string().max(200).nullable(),
  // On GET only:
  resolved: z.object({
    provider: LlmProviderSchema,
    model: z.string(),
  }).optional(),
});

export const UsecaseAssignmentsSchema = z.object({
  chat:     UsecaseAssignmentSchema,
  summary:  UsecaseAssignmentSchema,
  quality:  UsecaseAssignmentSchema,
  auto_tag: UsecaseAssignmentSchema,
});

// On PUT: partial, nullable fields distinguish "clear" from "untouched".
export const UpdateUsecaseAssignmentsSchema = z.partialRecord(
  LlmUsecaseSchema,
  z.object({
    provider: LlmProviderSchema.nullable().optional(),
    model: z.string().max(200).nullable().optional(),
  }),
);
```

Then extend `AdminSettingsSchema.usecaseAssignments` = `UsecaseAssignmentsSchema`, and `UpdateAdminSettingsSchema.usecaseAssignments` = `UpdateUsecaseAssignmentsSchema.optional()`. Rebuild contracts (`npm run build -w @compendiq/contracts`).

---

## 5. Admin UI

### 5a. Where

Mount a new `<UsecaseAssignmentsSection />` component **inside the existing `LlmTab`** in `frontend/src/features/settings/SettingsPage.tsx` (function starts at line 706), between the "Embedding model" block (ending line 973) and the Save/Test button row (line 981). This keeps everything LLM-related on one tab and one Save button.

### 5b. What

Four rows (one per use case), each:
- **Label:** "Chat", "Summary worker", "Quality worker", "Auto-tag"
- **Provider select:** `[Inherit shared default] | Ollama | OpenAI Compatible`
- **Model select:** populated from the relevant provider's `/ollama/models?provider=<p>` endpoint (already used elsewhere in `LlmTab`). When "Inherit" is selected for provider, show the shared default's model dropdown (read-only preview) with text "Inherited: `<provider>/<model>`".
- **Hint line:** "Currently using: `<resolved.provider>/<resolved.model>`"

### 5c. Model dropdown reuse

The dropdowns reuse the exact same `ollamaModels` / `openaiModels` queries already set up in `LlmTab` (lines 756–767). No new query hooks. A small factored helper `<ModelSelect provider={p} value={m} onChange={...} />` keeps the four rows DRY.

### 5d. State

Extend the existing `LlmTab` state with a single `usecaseAssignments` object (shape from contracts). `handleSave` at line 798 includes `usecaseAssignments` in the PUT body only when it differs from the loaded value.

---

## 6. Tests

Required per `CLAUDE.md` rule 1. All backend tests use real PostgreSQL via `test-db-helper.ts`.

### New test files

| File                                                                                          | What it pins down                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend/src/core/services/admin-settings-service.usecase.test.ts`                            | Resolver fallback order: (a) usecase row wins; (b) shared default fills; (c) env bootstraps when row absent; (d) `''` when nothing set. One test per rung. Also: null provider + set model → resolver fills provider from shared default. |
| `backend/src/domains/knowledge/services/summary-worker.usecase.test.ts`                       | Summary worker picks up a DB change without restart: start worker, call `getUsecaseLlmAssignment('summary')` once → model A; update `admin_settings` row; call again → model B. No cache, no restart.       |
| `backend/src/domains/knowledge/services/quality-worker.usecase.test.ts`                       | Same shape: DB change takes effect on next batch cycle.                                                                                                                                                    |
| `backend/src/routes/foundation/admin.usecase.test.ts`                                         | Admin API round-trip: GET returns defaults; PUT sets `{chat: {provider: 'openai', model: 'gpt-4o'}}`; GET returns it; PUT `{chat: {provider: null, model: null}}` clears it.                              |
| `backend/src/core/db/migrations/__tests__/migration-053.test.ts` (append to existing)         | Migration 053 runs without error; is idempotent; does not touch existing `admin_settings` rows.                                                                                                            |

### Edits to existing test files

| File                                                                         | Change                                                                                                                                                            |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend/src/core/services/admin-settings-service.test.ts`                   | Add case for `upsertUsecaseLlmAssignments` batch upsert + null-delete semantics.                                                                                  |
| `backend/src/domains/knowledge/services/summary-worker.test.ts`              | Update the existing `resolveSummaryModel` assertion to reflect the new resolver call path.                                                                        |
| `backend/src/domains/knowledge/services/quality-worker.test.ts`              | Same.                                                                                                                                                             |
| `backend/src/routes/foundation/admin.test.ts`                                | Extend the existing `/admin/settings` GET/PUT tests to include `usecaseAssignments` in the payload shape.                                                         |
| `backend/src/routes/knowledge/pages-tags.test.ts` + `auto-tag.test.ts`       | Add case: auto-tag request with omitted `model` → resolver is consulted and its value is passed to `autoTagPage`.                                                 |
| `frontend/src/features/settings/SettingsPage.test.tsx` (extends `OllamaTab` cases) | Render `LlmTab`; verify the four use-case rows appear; pick a non-default provider+model for `summary`; click Save; assert PUT body includes `usecaseAssignments.summary`. |

---

## 7. Docs

### `.env.example` — mark deprecated

Change the comments (lines 63, 68, 78) to:

```env
# DEPRECATED (bootstrap fallback only, issue #214). Set via Admin → Settings → LLM → Use case assignments.
# Consulted only when the corresponding admin_settings row is absent.
# DEFAULT_LLM_MODEL=
# SUMMARY_MODEL=
# QUALITY_MODEL=qwen3:4b
```

### `CLAUDE.md` — env section (lines describing `SUMMARY_MODEL`, `QUALITY_MODEL`, `DEFAULT_LLM_MODEL`)

Add one sentence each: "deprecated bootstrap fallback — configured in Settings → LLM → Use case assignments (issue #214), consulted only when the `admin_settings` row is absent." Mirror the `COMPENDIQ_LICENSE_KEY` wording already present.

### Architecture diagrams

Per `CLAUDE.md` rule 6: check if any diagram needs updating.

- **`03-backend-domains.md`** — no service boundary change. The resolver lives in an existing core service. No new domain. **No update needed.**
- **`06-data-model.md`** — `admin_settings` is a key-value table; the four new keys are not structurally interesting. Existing docs already enumerate `llm_provider`, `ollama_model`, `openai_model`, etc. Add a bullet under admin_settings noting the `llm_usecase_*` key family for completeness.
- **`09-flow-rag-chat.md`** — currently shows "admin selects model" as one step. Optionally add a parallel arrow "resolver picks per-use-case override". Low-value — flag in the PR description rather than changing it.

**Recommendation:** update `06-data-model.md` only. Flag `03-backend-domains.md` and `09-flow-rag-chat.md` as "reviewed, no change needed" in the PR body.

---

## 8. ESLint / domain boundaries

Sanity-check against `CLAUDE.md` § "Domain Boundary Rules":

- Resolver in `core/services/admin-settings-service.ts` — stays in `core`, no domain imports. ✅
- `summary-worker` / `quality-worker` import from `core/services/admin-settings-service.js` — already do (line 18 and 14 respectively). ✅
- Chat routes: no new imports needed; they already import `llm-provider.js`. ✅
- Contracts (`packages/contracts`) — already consumed by both backend and frontend. ✅
- No new inter-domain import introduced.

---

## 9. Security

- Parameterized SQL only — all queries use `$1`, `$2`, `ANY($1::text[])`. ✅
- Zod validation on `PUT /admin/settings` input. ✅
- Admin-only (`fastify.requireAdmin`) on both routes — already enforced by the existing `/admin/settings` hook. ✅
- No secrets involved; `openaiApiKey` is untouched by this PR.

---

## 10. Rollback

Per phase:

**Phase 1 — Contracts, migration, resolver (no call-site changes yet).**
- Rollback: revert the commit. The migration `053` is a `SELECT 1;` no-op, so no DB state to undo. New `admin_settings` rows written by seeding are harmless (ignored by old code).

**Phase 2 — Workers switch to resolver.**
- Rollback: revert the commit, restart. Workers fall back to reading env vars directly (old behavior). Any `admin_settings` rows created by seeding remain but are ignored.

**Phase 3 — Admin API + contracts extension.**
- Rollback: revert the commit + `npm run build -w @compendiq/contracts`. Frontend still works because `usecaseAssignments` is optional in the schema.

**Phase 4 — Admin UI.**
- Rollback: revert the commit. No server-side impact.

**Migration-level rollback.** Migration is additive-only (`SELECT 1;` plus seed rows written by TS). To hard-revert, run `DELETE FROM admin_settings WHERE setting_key LIKE 'llm_usecase_%';` — documented in the PR body.

---

## 11. Acceptance criteria → plan step mapping

| # | Acceptance criterion                                                                                           | Plan step(s)          |
| - | -------------------------------------------------------------------------------------------------------------- | --------------------- |
| 1 | Admin can set summary/quality/chat/auto-tag provider+model independently via Settings → LLM, each optional.    | §1, §4, §5            |
| 2 | `summary-worker` and `quality-worker` read model from admin settings at runtime; changes take effect without a restart. | §2 (no cache), §3a, §3b, §6 (usecase tests) |
| 3 | `SUMMARY_MODEL` / `QUALITY_MODEL` / `DEFAULT_LLM_MODEL` documented as deprecated bootstrap fallbacks.          | §7 (.env.example, CLAUDE.md) |
| 4 | Migration seeds existing env values into `admin_settings` on upgrade.                                          | §1 (migration file) + §2 (one-shot env seed in resolver) |
| 5a | Tests cover resolver fallback order.                                                                          | §6 row 1              |
| 5b | Tests cover summary worker picking up DB change without restart.                                              | §6 row 2              |
| 5c | Tests cover admin API round-trip.                                                                             | §6 row 4              |
| 6 | Architecture diagram(s) updated if boundaries change.                                                          | §7 — only `06-data-model.md` updated; others reviewed, flagged in PR. |

---

## 12. Implementation order (4 commits)

1. `feat(admin): add per-use-case LLM assignment resolver + migration 053`
   — contracts schema, migration, `getUsecaseLlmAssignment`, `upsertUsecaseLlmAssignments`, unit tests. No call-site changes yet. Safe to deploy.

2. `feat(workers): resolve summary/quality model from admin settings`
   — summary-worker, quality-worker, auto-tagger route, `providerStreamChatForUsecase` helper in `llm-provider.ts`. Existing behavior preserved when no overrides set.

3. `feat(admin-api): expose usecase assignments on /admin/settings`
   — extend GET/PUT handler in `admin.ts`, audit log, route tests.

4. `feat(admin-ui): use-case assignments table in LLM settings tab`
   — `<UsecaseAssignmentsSection />`, `LlmTab` integration, frontend test.

Plus a fifth doc-only commit: `docs: deprecate SUMMARY_MODEL/QUALITY_MODEL env vars; update data-model diagram`.

Each commit is independently reversible; 1–3 are pure backend and can ship without the UI (admin edits via API/curl until the UI lands).
