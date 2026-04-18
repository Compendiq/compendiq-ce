# Plan: Wire the `chat` use-case assignment through chat/RAG routes (Issue #217)

**Branch:** `feature/217-chat-usecase-wiring` (from `dev`)
**Follow-up to:** #214 / PR #216
**Risk:** Low — all changes are additive, falling back to existing per-user routing when no `chat` override is set. No migrations, no schema changes, no new public types.

---

## Goal

When an admin sets `{provider, model}` for the `chat` use case in Settings → LLM → Use case assignments, the chat/RAG endpoints (`/api/llm/ask`, `/api/llm/generate`, `/api/llm/improve`, `/api/llm/summarize`, `/api/llm/generate-diagram`, `/api/llm/analyze-quality`) must route through that provider+model via `providerStreamChatForUsecase`. When no override is set, the endpoints preserve existing behavior (per-user `providerStreamChat`). The UI row for `chat` in `UsecaseAssignmentsSection` is re-enabled by removing `chat` from the `WIRED_USECASES` gate.

---

## 1. State verification (read against issue text)

Verified against repo HEAD — the issue's description matches the current code with **two drifts** worth calling out:

1. **`WIRED_USECASES` is in `LlmTab.tsx`, not `SettingsPage.tsx`.** The issue names `frontend/src/features/settings/SettingsPage.tsx`; the actual location is `frontend/src/features/settings/panels/LlmTab.tsx:367`. `SettingsPage.tsx` just renders the tab shell. The plan targets the correct file; no functional difference.
2. **There is no standalone `llm-chat.ts` route file.** The issue's scope list mentions a `chat` route — the only conversational endpoints are the six listed in §3. `llm-chat.test.ts` is a cross-cutting integration file that exercises several route modules; it does not register its own routes.

Everything else from the issue checks out:

- `backend/src/domains/llm/services/llm-provider.ts:88-117` — `resolveUserProvider(userId)` returns the shared provider from `admin_settings` and `providerStreamChat(userId, model, …)` dispatches on that. It does **not** consult `getUsecaseLlmAssignment('chat')`.
- `backend/src/domains/llm/services/llm-provider.ts:130-162` — `providerStreamChatForUsecase(provider, model, …)` and `providerChatForUsecase(provider, model, …)` exist with the expected shapes.
- `backend/src/core/services/admin-settings-service.ts:346-358` — `getUsecaseLlmAssignment` exists with the documented `usecase → shared → env → default` ladder, no in-process cache (one `getAdminSettingsMap` round-trip per call), so runtime DB edits take effect without restart.
- `backend/src/routes/llm/llm-ask.ts:227` — current call is `providerStreamChat(userId, model, messages, controller.signal)`.
- `frontend/src/features/settings/panels/LlmTab.tsx:367` — `WIRED_USECASES = new Set(['summary', 'quality', 'auto_tag'])`. Tooltip text at lines 413/436 says `"Chat routing through per-use-case assignments is not yet wired — tracked as a follow-up to #214."`.

**Reference pattern to match.** The cleanest precedent is `pagesTagRoutes` in `backend/src/routes/knowledge/pages-tags.ts:34-77` — an authenticated (non-admin-gated), interactive, user-facing route that resolves the `auto_tag` assignment via `getUsecaseLlmAssignment(…)`, lets the body override the `model` but **always** takes the `provider` from the resolver, and dispatches via `providerChatForUsecase(provider, model, …)`. The summary-worker (`backend/src/domains/knowledge/services/summary-worker.ts:245`) and quality-worker (`backend/src/domains/knowledge/services/quality-worker.ts:158`) use `providerStreamChatForUsecase` identically for streaming. Chat routes will match this pattern.

---

## 2. Decisions on the two open product questions

### Decision 1 — Override vs. default semantics

**Decision: override.** When `chat` has a row set in `admin_settings` (i.e. `assignment.source.provider === 'usecase'` for the provider, or `assignment.source.model === 'usecase'` for the model), the chat routes route through that override, replacing what the user configured. When no override is set (source falls through to `shared`, `env`, or `default`), existing per-user behavior is preserved byte-for-byte.

**Rationale.**

- Matches the `summary` / `quality` / `auto_tag` precedent in every existing wired call site — they all read `getUsecaseLlmAssignment(…)` and unconditionally use what the resolver returns, no user-provider merging.
- Gives admins a meaningful control surface: the UI row's purpose is to let an admin pin a specific provider for compliance/cost reasons (e.g. "all chat goes through our sanctioned OpenAI proxy"). A default-only semantic would mean the row has no effect whenever the user has configured anything, which is effectively every chat user — making the row useless and the UI misleading again.
- The resolver already has a full fallback ladder (`usecase → shared → env → default`), so "no override" is the natural, well-tested inherit path. We get default semantics for free when the admin simply doesn't set the row.

**Rejected alternative — default semantics.** Admin value fills in only when the user hasn't picked. Rejected because: (a) the UI has no per-user chat model picker that's tied to `llm_provider` — users pick from a model list that assumes the shared provider, so "user hasn't picked" is ambiguous; (b) diverges from the three existing wired use cases without a good reason; (c) leaves the admin control with ambiguous runtime effect, reintroducing the exact confusion #216 disabled the row to avoid.

### Decision 2 — User-passed model when only the provider is overridden

**Decision: when the admin sets `chat.provider` but **not** `chat.model` (resolver's `source.model` is `'shared'`, `'env'`, or `'default'`), the user-passed `model` from the request body is sent to the admin-selected provider. When the admin sets **both** `chat.provider` and `chat.model`, both are locked and the body `model` is ignored.**

**Rationale.**

- Mirrors the `auto_tag` pattern exactly (`backend/src/routes/knowledge/pages-tags.ts:42-43`): `const model = bodyModel ?? assignment.model;` — the resolver's `provider` is the source of truth for provider; `model` is "body wins, else resolver". For `chat`, we invert the priority slightly (resolver-usecase wins over body, else body, else resolver-shared) so that the admin can still fully lock the model when they want to.
- The resolver's `source` field tells us precisely which fallback tier the model came from — we can distinguish "admin pinned a specific chat model" (`source.model === 'usecase'`) from "admin only pinned the provider; model came from elsewhere" (`source.model !== 'usecase'`). This makes the lock precise and auditable.
- Pragmatic: the UI model pickers are provider-specific (OpenAI model list vs. Ollama model list). If the admin flips the provider to OpenAI but leaves the model field as "inherit", users' current model selections (likely Ollama-shaped like `qwen3:32b`) would be sent to OpenAI and hard-fail with 404. Letting the user model win in that case is still wrong, but it's **the exact same failure mode** as the shared-provider case today (admin flips shared provider without telling users), so we don't regress — we just don't add a new failure mode.
- The clean resolution for the model-shape mismatch is out of scope for this issue: either (a) force the body model to be dropped in favor of the resolver's shared model whenever `source.provider === 'usecase'` and `source.model !== 'usecase'`, or (b) add a UI warning. Decided to defer: §7 adds a follow-up bullet and I note it inline in the code comment so future maintainers see it.

**Resolution rule (concrete, applied in §3's helper):**

```
if assignment.source.model === 'usecase':
    model = assignment.model          // admin pinned both; ignore body
else:
    model = body.model ?? assignment.model   // body wins; else shared/env fallback
```

Both branches always use `assignment.provider` as the provider (which may itself be inherited from the shared default when no usecase override is set — that's the correct behavior for the "no override" case).

---

## 3. Per-file edits

All six chat/RAG routes grow a small header block that resolves the chat assignment and chooses between `providerStreamChat` (no chat-usecase override present) and `providerStreamChatForUsecase` (override present). To avoid copy-paste drift, extract one helper in `_helpers.ts` and call it from each route. No public API changes; all request/response shapes unchanged.

### 3.1 `backend/src/routes/llm/_helpers.ts` — add `resolveChatAssignment()` helper

Add near the other exports (e.g. below `MAX_PDF_TEXT_FOR_LLM`):

```ts
import {
  getUsecaseLlmAssignment,
  type UsecaseLlmAssignment,
} from '../../core/services/admin-settings-service.js';

/**
 * Resolve the `{provider, model}` pair for the `chat` use case, applying the
 * issue #217 semantics:
 *
 *   - If the admin has set a model override (`source.model === 'usecase'`), both
 *     the provider and the model come from the resolver — the caller's `bodyModel`
 *     is ignored.
 *   - Otherwise, the provider still comes from the resolver (which itself
 *     inherits the shared default when no usecase override is set), and the
 *     model is the caller's `bodyModel` — only falling back to the resolver's
 *     model (shared/env/default) when the caller passed nothing.
 *
 * Semantics for the two product questions (see docs/plans/issue-217-…):
 *   Q1 — override vs. default: override.
 *   Q2 — body model + usecase provider: free (body wins), unless the admin also
 *        pinned the model (then locked).
 *
 * The returned `assignment.source` is preserved as-is so callers can audit
 * which tier produced the result (useful for the audit hook and debugging).
 *
 * Follow-up (out of scope for #217): when `source.provider === 'usecase'` and
 * `source.model !== 'usecase'`, a caller-supplied Ollama-shaped model may be
 * sent to OpenAI (or vice versa). Today this fails at the provider with a 4xx
 * — same failure mode as a shared-provider flip. Tracked as a follow-up.
 */
export async function resolveChatAssignment(bodyModel: string): Promise<{
  provider: UsecaseLlmAssignment['provider'];
  model: string;
  /** True when the resolver produced the provider (admin override exists). */
  hasUsecaseOverride: boolean;
  /** Full resolver result, for audit/logging. */
  assignment: UsecaseLlmAssignment;
}> {
  const assignment = await getUsecaseLlmAssignment('chat');
  const model =
    assignment.source.model === 'usecase'
      ? assignment.model
      : (bodyModel || assignment.model);
  const hasUsecaseOverride =
    assignment.source.provider === 'usecase' ||
    assignment.source.model === 'usecase';
  return { provider: assignment.provider, model, hasUsecaseOverride, assignment };
}
```

Notes:

- Defensive `bodyModel || assignment.model` handles the `bodyModel === ''` case (Zod schemas already reject empty string, but this is cheap insurance).
- `hasUsecaseOverride` is the single flag the route uses to pick between the two dispatch functions. When `false`, the route uses `providerStreamChat(userId, bodyModel, …)` exactly as today — provider resolution runs through `resolveUserProvider` so no per-user semantics change.
- No caching. Each call hits the resolver, which itself hits `admin_settings` once — matches the documented "changes take effect without restart" contract from #214.

### 3.2 `backend/src/routes/llm/llm-ask.ts` — primary acceptance-criteria route

Edits:

1. **Import** (top of file, add to the existing `_helpers.js` import block):
   ```ts
   import { ..., resolveChatAssignment } from './_helpers.js';
   ```
   and add `providerStreamChatForUsecase` to the `llm-provider.js` import:
   ```ts
   import {
     providerStreamChat,
     providerStreamChatForUsecase,
     resolveUserProvider,
   } from '../../domains/llm/services/llm-provider.js';
   ```

2. **Replace the stream dispatch** (around `llm-ask.ts:227`). Current code:
   ```ts
   // Resolve per-user LLM provider and stream
   const generator = providerStreamChat(userId, model, messages, controller.signal);
   ```
   Becomes:
   ```ts
   // Issue #217: honor the per-use-case `chat` provider/model override when the
   // admin has set one in Settings → LLM → Use case assignments. When no
   // override is set, preserve the existing per-user routing byte-for-byte.
   const chat = await resolveChatAssignment(model);
   const generator = chat.hasUsecaseOverride
     ? providerStreamChatForUsecase(chat.provider, chat.model, messages, controller.signal)
     : providerStreamChat(userId, model, messages, controller.signal);
   ```

3. **Audit emissions** — two `emitLlmAudit({ … provider: (await resolveUserProvider(userId)).type … })` calls at lines 260 and 285. Under a chat-usecase override, the real provider used is `chat.provider`, not `resolveUserProvider`. Replace both with:
   ```ts
   provider: chat.hasUsecaseOverride ? chat.provider : (await resolveUserProvider(userId)).type,
   ```
   Same for the `model` audit field — on the success path audit already uses the body `model`; on override the real model is `chat.model`. Replace both `model,` usages in the `emitLlmAudit({ … })` calls with:
   ```ts
   model: chat.hasUsecaseOverride ? chat.model : model,
   ```
   Keeps the audit trail honest and non-misleading for downstream observability (LlmAuditPage consumes this).

4. **Logging** — add one structured debug line immediately after the `chat` resolver call for forensics:
   ```ts
   logger.debug(
     { userId, bodyModel: model, resolved: chat.assignment, usedOverride: chat.hasUsecaseOverride },
     'Resolved chat usecase assignment',
   );
   ```

No other edits in this file. The `model` used for the cache key (line 136, `buildRagCacheKey(model, …)`) must stay `model` (the body value) — cache key identity is per-request, not per-provider, and changing it would invalidate every cached RAG response on deploy. The risk of false cache hits when the admin flips providers is low because the message prefix changes too (system prompt is the same, but the conversation history differs), and the worst case is one stale response per `{question, docIds}` cell. Acceptable for this issue; we can key on resolved provider+model in a follow-up.

### 3.3 `backend/src/routes/llm/llm-generate.ts`

Identical pattern to §3.2. Lines to edit:

1. Import `resolveChatAssignment` from `./_helpers.js`; add `providerStreamChatForUsecase` to the `llm-provider.js` import.
2. Around line 112 (`const generator = providerStreamChat(userId, model, generateMessages);`), replace with the same `chat.hasUsecaseOverride ? … : …` dispatch as §3.2 step 2, sans the `controller.signal` argument (this route doesn't pass one).
3. Lines 120 and 133 — replace `provider: (await resolveUserProvider(userId)).type` with the `chat.hasUsecaseOverride ? chat.provider : …` ternary. Do the same for the `model` field, as in §3.2 step 3.
4. Add the same `logger.debug` line as §3.2 step 4 (requires adding the `logger` import, which is already present — line 8).

Cache-key note identical to §3.2 — keep the body `model` in `buildLlmCacheKey` (line 96).

### 3.4 `backend/src/routes/llm/llm-improve.ts`

Identical pattern. Lines to edit:

1. Imports: `resolveChatAssignment` and `providerStreamChatForUsecase`.
2. Around line 112 (`const generator = providerStreamChat(userId, model, improveMessages);`): swap to ternary dispatch (no signal).
3. Lines 128 and 141 — swap `provider` and `model` audit fields as in §3.2.
4. Add the `logger.debug` line. `logger` is not imported in this file today — add `import { logger } from '../../core/utils/logger.js';`.

Cache-key: keep `model` at line 79.

### 3.5 `backend/src/routes/llm/llm-summarize.ts`

No audit emission in this route, so the edit is smaller:

1. Imports: `resolveChatAssignment` and `providerStreamChatForUsecase`.
2. Around line 82 (`const generator = providerStreamChat(userId, model, […]);`): swap to ternary dispatch (no signal).
3. Add `logger.debug` line — `logger` is not imported today; add `import { logger } from '../../core/utils/logger.js';`.

Cache-key: keep `model` at line 72.

### 3.6 `backend/src/routes/llm/llm-diagram.ts`

1. Imports: `resolveChatAssignment` and `providerStreamChatForUsecase`.
2. Around line 50 (`const generator = providerStreamChat(request.userId, model, [ … ]);`): swap to ternary dispatch.
3. Add `logger.debug` line — `logger` is not imported today; add the import.

Cache-key: keep `model` at line 42.

### 3.7 `backend/src/routes/llm/llm-quality.ts`

(The issue calls this out separately — the `/api/llm/analyze-quality` route, which is user-initiated quality analysis, *not* the background quality worker.)

1. Imports: `resolveChatAssignment` and `providerStreamChatForUsecase`.
2. Around line 52 (`const generator = providerStreamChat(userId, model, […]);`): swap to ternary dispatch.
3. Add `logger.debug` line — `logger` is not imported today; add the import.

Cache-key: keep `model` at line 43.

**Note on the naming overlap.** This route uses the `chat` use case, not the `quality` use case. The `quality` use case is the background batch worker (`backend/src/domains/knowledge/services/quality-worker.ts`) that already routes via `getUsecaseLlmAssignment('quality')`. The user-initiated analyze-quality endpoint is conversational and belongs under `chat`. A one-line code comment above the dispatch clarifies this to prevent future confusion:

```ts
// Routes through the `chat` usecase, not `quality` — this is the interactive
// analyze-quality endpoint. The `quality` usecase governs the background
// quality worker (see domains/knowledge/services/quality-worker.ts).
```

### 3.8 `frontend/src/features/settings/panels/LlmTab.tsx` — re-enable the chat row

Single one-line edit at line 367:

```diff
-const WIRED_USECASES: ReadonlySet<LlmUsecase> = new Set(['summary', 'quality', 'auto_tag']);
+const WIRED_USECASES: ReadonlySet<LlmUsecase> = new Set(['chat', 'summary', 'quality', 'auto_tag']);
```

No other changes needed — the `disabled={!wired}` gates at lines 412/435 and the tooltip text at lines 413/436 both read off this set, and the helper text at line 447-452 switches automatically.

Also refresh the comment on the `WIRED_USECASES` declaration (lines 360-366). The current comment references this issue by saying "still read the shared provider (tracked as a follow-up to issue #214)". Update to reflect the new truth:

```ts
/**
 * Use cases whose resolver is wired into a production code path today. Rows
 * for use cases not in this set are rendered read-only with a "not yet wired"
 * note. As of issue #217, all four use cases are wired — the set is kept as
 * an extension point for future use cases added to `LlmUsecase`.
 */
```

---

## 4. Test plan

The three test cases from the issue's acceptance criteria, plus the UI re-enable.

### 4.1 `backend/src/routes/llm/llm-ask.test.ts` — extend existing file

Existing file uses route-level mocks and injects HTTP. Pattern mirrors `backend/src/routes/knowledge/auto-tag.test.ts:60-71`.

**Add at top-of-file mocks** (below the `ollama-service` mock, alongside the existing `mockStreamChat`):

```ts
// --- Mock: llm-provider (streaming helpers) ---
// Keep the default streamChat passthrough for ollama-based tests; spy the
// usecase helper so we can assert routing (#217).
const mockStreamChatForUsecase = vi.fn();
const mockResolveUserProvider = vi.fn().mockResolvedValue({ type: 'ollama' });
vi.mock('../../domains/llm/services/llm-provider.js', async () => {
  const actual = await vi.importActual<typeof import('../../domains/llm/services/llm-provider.js')>(
    '../../domains/llm/services/llm-provider.js',
  );
  return {
    ...actual,
    providerStreamChat: (...args: unknown[]) => mockStreamChat(...args),
    providerStreamChatForUsecase: (...args: unknown[]) => mockStreamChatForUsecase(...args),
    resolveUserProvider: (...args: unknown[]) => mockResolveUserProvider(...args),
  };
});

// --- Mock: admin-settings-service (issue #217 — chat usecase resolver) ---
const mockGetUsecaseLlmAssignment = vi.fn();
vi.mock('../../core/services/admin-settings-service.js', () => ({
  getUsecaseLlmAssignment: (...args: unknown[]) => mockGetUsecaseLlmAssignment(...args),
}));
```

**Reset in `beforeEach`** (alongside the existing mock resets):

```ts
mockStreamChatForUsecase.mockReset();
mockGetUsecaseLlmAssignment.mockReset();
// Default: no override — route should dispatch via providerStreamChat.
mockGetUsecaseLlmAssignment.mockResolvedValue({
  provider: 'ollama',
  model: '',
  source: { provider: 'shared', model: 'shared' },
});
```

**Three new test cases** in the `describe('POST /api/llm/ask')` block:

```ts
describe('issue #217 — chat usecase routing', () => {
  it('consults getUsecaseLlmAssignment("chat") on every request', async () => {
    mockHybridSearch.mockResolvedValue([]);
    mockStreamChat.mockReturnValue(singleChunkGenerator('answer'));

    await app.inject({
      method: 'POST',
      url: '/api/llm/ask',
      payload: { question: 'hi', model: 'llama3' },
    });

    expect(mockGetUsecaseLlmAssignment).toHaveBeenCalledWith('chat');
  });

  it('routes via providerStreamChatForUsecase when admin set a chat override', async () => {
    mockHybridSearch.mockResolvedValue([]);
    // Admin has set provider=openai AND model=gpt-4o-mini for chat.
    mockGetUsecaseLlmAssignment.mockResolvedValue({
      provider: 'openai',
      model: 'gpt-4o-mini',
      source: { provider: 'usecase', model: 'usecase' },
    });
    mockStreamChatForUsecase.mockReturnValue(singleChunkGenerator('answer'));

    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/ask',
      payload: { question: 'hi', model: 'llama3' }, // body model ignored
    });

    expect(response.statusCode).toBe(200);
    expect(mockStreamChatForUsecase).toHaveBeenCalledTimes(1);
    expect(mockStreamChat).not.toHaveBeenCalled();

    const [provider, usedModel] = mockStreamChatForUsecase.mock.calls[0]!;
    expect(provider).toBe('openai');
    expect(usedModel).toBe('gpt-4o-mini');
  });

  it('preserves per-user routing when no chat override is set', async () => {
    mockHybridSearch.mockResolvedValue([]);
    mockStreamChat.mockReturnValue(singleChunkGenerator('answer'));
    // Default resolver result (shared source) left from beforeEach.

    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/ask',
      payload: { question: 'hi', model: 'llama3' },
    });

    expect(response.statusCode).toBe(200);
    expect(mockStreamChat).toHaveBeenCalledTimes(1);
    expect(mockStreamChatForUsecase).not.toHaveBeenCalled();

    const [userId, usedModel] = mockStreamChat.mock.calls[0]!;
    expect(userId).toBe('test-user-123');
    expect(usedModel).toBe('llama3'); // body model preserved
  });

  it('locks model when admin set only provider override (body.model still honored for usecase=model not set)', async () => {
    mockHybridSearch.mockResolvedValue([]);
    // Admin set provider=openai but left model inherited (shared/env).
    mockGetUsecaseLlmAssignment.mockResolvedValue({
      provider: 'openai',
      model: 'qwen3.5', // shared fallback
      source: { provider: 'usecase', model: 'shared' },
    });
    mockStreamChatForUsecase.mockReturnValue(singleChunkGenerator('answer'));

    await app.inject({
      method: 'POST',
      url: '/api/llm/ask',
      payload: { question: 'hi', model: 'user-picked-model' },
    });

    expect(mockStreamChatForUsecase).toHaveBeenCalledTimes(1);
    const [provider, usedModel] = mockStreamChatForUsecase.mock.calls[0]!;
    expect(provider).toBe('openai');
    // Q2 decision: body model wins when source.model !== 'usecase'.
    expect(usedModel).toBe('user-picked-model');
  });
});
```

Maps to the three acceptance-criteria test cases: (a) resolver is consulted; (b) override routes via `providerStreamChatForUsecase`; (c) no override preserves existing behavior. The fourth test documents the Q2 semantics decision in executable form.

### 4.2 Smoke test for the other five routes

Don't re-test the full chat-usecase semantics per route — the logic is extracted into `resolveChatAssignment`. Instead, add one minimal smoke test per route file (`llm-generate.test.ts` via `generate-with-pdf.test.ts`, `llm-improve.test.ts` via `improve-*.test.ts`, `llm-summarize.test.ts`, `llm-diagram.test.ts` via `generate-diagram.test.ts`, `llm-quality.test.ts` via `analyze-quality.test.ts`) asserting that `getUsecaseLlmAssignment('chat')` was called exactly once per request. The existing test files already mock `../../core/services/admin-settings-service.js` implicitly or via other paths — extend the mock block only where needed.

This keeps the cross-route coverage without duplicating every branch.

### 4.3 `_helpers.test.ts` — new file for `resolveChatAssignment`

New test file `backend/src/routes/llm/_helpers.test.ts` covers the helper in isolation:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGet = vi.fn();
vi.mock('../../core/services/admin-settings-service.js', () => ({
  getUsecaseLlmAssignment: (...args: unknown[]) => mockGet(...args),
}));

import { resolveChatAssignment } from './_helpers.js';

describe('resolveChatAssignment (issue #217)', () => {
  beforeEach(() => mockGet.mockReset());

  it('returns body model when no usecase override exists', async () => {
    mockGet.mockResolvedValue({
      provider: 'ollama',
      model: 'shared-model',
      source: { provider: 'shared', model: 'shared' },
    });
    const r = await resolveChatAssignment('body-model');
    expect(r.provider).toBe('ollama');
    expect(r.model).toBe('body-model');
    expect(r.hasUsecaseOverride).toBe(false);
  });

  it('locks model when source.model === usecase', async () => {
    mockGet.mockResolvedValue({
      provider: 'openai',
      model: 'admin-pinned',
      source: { provider: 'usecase', model: 'usecase' },
    });
    const r = await resolveChatAssignment('body-model');
    expect(r.model).toBe('admin-pinned');
    expect(r.hasUsecaseOverride).toBe(true);
  });

  it('allows body model when only provider is pinned', async () => {
    mockGet.mockResolvedValue({
      provider: 'openai',
      model: 'shared-fallback',
      source: { provider: 'usecase', model: 'shared' },
    });
    const r = await resolveChatAssignment('user-picked');
    expect(r.provider).toBe('openai');
    expect(r.model).toBe('user-picked');
    expect(r.hasUsecaseOverride).toBe(true);
  });

  it('falls back to resolver model when body model is empty', async () => {
    mockGet.mockResolvedValue({
      provider: 'ollama',
      model: 'shared-fallback',
      source: { provider: 'shared', model: 'shared' },
    });
    const r = await resolveChatAssignment('');
    expect(r.model).toBe('shared-fallback');
  });
});
```

### 4.4 Frontend — re-enable assertion

Currently `frontend/src/features/settings/panels/` has no `*.test.*` files. Rather than introduce a new test infrastructure for a one-line change, add a minimal snapshot-free assertion in a new `LlmTab.test.tsx` only if the frontend suite has `@testing-library/react` already (which it does per CLAUDE.md). Test:

1. Render `LlmTab` with mocked `useSettings` returning a settings shape with chat row; mocked `useLlmModels`.
2. Assert the `chat` provider select is not disabled: `expect(screen.getByTestId('usecase-chat-provider')).not.toBeDisabled();`.
3. Assert the helper text no longer contains "Not yet wired".

If the team prefers a lighter touch, a Playwright spec under `e2e/settings-chat-usecase.spec.ts` that navigates to Settings → LLM → Use case assignments and asserts the `chat` row's provider `<select>` is enabled is also acceptable and matches the existing E2E footprint. Pick one; the Playwright route is cheaper if `react-testing-library` infra is not yet on this page.

### 4.5 Full command to run locally

```bash
cd backend && npx vitest run src/routes/llm/llm-ask.test.ts \
                       src/routes/llm/_helpers.test.ts \
                       src/routes/llm/generate-with-pdf.test.ts \
                       src/routes/llm/improve-page-id.test.ts \
                       src/routes/llm/llm-summarize.test.ts \
                       src/routes/llm/generate-diagram.test.ts \
                       src/routes/llm/analyze-quality.test.ts
cd frontend && npx vitest run src/features/settings/panels/LlmTab.test.tsx
npm run typecheck && npm run lint
```

E2E (optional but recommended for the UI change):

```bash
npx playwright test e2e/settings-chat-usecase.spec.ts
```

---

## 5. Execution order (for `code-implementer`)

Do these in order — the test scaffolding in step 1 catches dispatch regressions in steps 2-4.

1. **Add `resolveChatAssignment` helper to `_helpers.ts`** (§3.1) plus its unit test `_helpers.test.ts` (§4.3). Run: `npx vitest run src/routes/llm/_helpers.test.ts`. Must go green before touching any route.
2. **Wire `llm-ask.ts`** (§3.2) and add the four new chat-usecase test cases (§4.1). Run: `npx vitest run src/routes/llm/llm-ask.test.ts`. Full acceptance coverage gates here.
3. **Wire the other five routes** (§3.3–§3.7) and add per-route smoke tests (§4.2). Run: the full `src/routes/llm/` suite.
4. **Re-enable UI row** (§3.8) and add the frontend test (§4.4). Run the frontend test + E2E if applicable.
5. **Typecheck + lint**: `npm run typecheck && npm run lint`.
6. **Update CHANGELOG.md** under the next unreleased section: `Wire the chat use-case assignment through chat/RAG routes (#217).`
7. **Update architecture diagrams if needed**: no domain boundary or data model change, so `03-backend-domains.md` and `06-data-model.md` are unaffected. The RAG flow diagram `09-rag-flow.md` should note that provider resolution now consults `getUsecaseLlmAssignment('chat')` when an admin override is set. Per CLAUDE.md rule 6, verify and update or flag in PR description.

---

## 6. Rollback procedure

All changes are contained to:

- `backend/src/routes/llm/_helpers.ts` (additive — new export)
- `backend/src/routes/llm/_helpers.test.ts` (new file)
- `backend/src/routes/llm/llm-{ask,generate,improve,summarize,diagram,quality}.ts` (touch stream dispatch + audit + debug log only)
- `backend/src/routes/llm/{route-test files}.ts` (additive test cases only)
- `frontend/src/features/settings/panels/LlmTab.tsx` (one-line `Set` contents edit plus comment refresh)
- `frontend/src/features/settings/panels/LlmTab.test.tsx` (new file) or `e2e/settings-chat-usecase.spec.ts` (new file)

No migrations. No schema changes. No changes to `@compendiq/contracts`. No changes to the resolver in `admin-settings-service.ts`.

**To roll back:**

```bash
git revert <merge-commit-sha>
```

This reverts code only. Any `llm_usecase_chat_provider` / `llm_usecase_chat_model` rows admins created in `admin_settings` during the window stay in the DB (they are already writable from pre-#217 UI — PR #216 disabled the input controls but not the PUT endpoint). After revert, those rows become no-op again (same behavior as the #214 ship state). No data cleanup required.

**Partial rollback (UI-only)** — if the backend wiring is fine but a UI bug requires reverting just the re-enable: revert only the `LlmTab.tsx` edit. Admins lose the ability to edit the chat row; existing DB rows continue to route correctly. This is a safe intermediate state.

---

## 7. Follow-ups out of scope

Document in the PR description so the work isn't lost:

1. **Cache key should include resolved provider+model** — `buildRagCacheKey` / `buildLlmCacheKey` both take the body `model`. On admin provider flip, one stale cached response per `{question, docIds}` cell can leak. Low-priority polish; tracked.
2. **Model-shape mismatch between provider override and body model** — if admin sets `chat.provider=openai` but the user's chat UI still ships an Ollama-shaped model (e.g. `qwen3:32b`), the request hard-fails at the provider. Consider adding a UI warning banner on the chat page when `assignment.source.provider === 'usecase' && assignment.source.model !== 'usecase'` and the user's model doesn't exist on the resolved provider's model list. Separate frontend-only issue.
3. **Streaming backpressure on `providerStreamChatForUsecase`** — inherited from #214; the stream helper bypasses `enqueue()`. Pre-existing limitation, documented in `llm-provider.ts:97-103`.
4. **Audit `provider` field on cache-hit path in `/api/llm/ask`** — the cached-SSE path (lines 198-206) skips `emitLlmAudit` entirely, so cache hits don't show up in the audit trail at all. Not a regression from this issue but worth noting.

---

## 8. Acceptance-criteria checklist

Direct mapping to the issue:

- [ ] **`POST /api/llm/ask` consults `getUsecaseLlmAssignment('chat')` and routes via `providerStreamChatForUsecase` when admin set an override** — §3.2, §4.1 tests 1 and 2.
- [ ] **Remaining chat routes (`generate`, `improve`, `summarize`, `diagram`, `quality`) updated consistently** — §3.3–§3.7.
- [ ] **Re-enable chat row in `UsecaseAssignmentsSection`** — §3.8.
- [ ] **Resolver consulted on chat path test** — §4.1 test 1.
- [ ] **Override routes via `providerStreamChatForUsecase` test** — §4.1 test 2.
- [ ] **No override preserves existing behavior test** — §4.1 test 3.
- [ ] **Both semantics questions decided + documented** — §2.
