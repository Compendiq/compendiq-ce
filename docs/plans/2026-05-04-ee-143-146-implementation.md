# EE #143 + #146 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finalize the existing `feat/143-slack-teams-deep` EE branch and ship a fresh #146 implementation that rebases the EE org LLM policy from a `ollama|openai` enum onto provider IDs sourced from `llm_providers`, with enforcement at both admin-mutation routes and runtime use-case resolution.

**Architecture:** Three coordinated branches. CE adds a small `resolveUsecaseOverride` hook to the `EnterprisePlugin` contract and the existing `LlmPolicyTab.tsx` switches to provider dropdowns; EE rewrites `llm-policy-service.ts` to store provider UUIDs, adds idempotent migration that auto-disables legacy values, registers a new preHandler against `PUT /api/admin/llm-usecases`, and exports the `resolveUsecaseOverride` from its plugin. EE #143 finalisation is a sequence of test-and-ship steps on an already-implemented branch.

**Tech Stack:** Fastify 5 (route hooks via `addHook('onRoute', …)`), Postgres (no schema migrations needed — reuses `admin_settings` + `llm_providers`), TanStack Query for the FE dropdown, Zod for request validation, BullMQ on Redis (`noeviction` policy required for #143).

---

## Branches

- **CE:** `feature/146-llm-policy-resolver-hook` — branch from `dev`. Backend hook + frontend dropdown.
- **EE:** `feat/146-llm-policy-providers` — branch from `main`. Service rewrite + middleware + migration + tests.
- **EE:** `feat/143-slack-teams-deep` — already exists; finalize.

---

## Section A — CE: resolver hook contract + frontend tab

**Working directory:** `/home/simon/Documents/Compendiq/compendiq-ce`

### Task A1: Branch off dev

**Files:** none (git op)

- [ ] **Step 1:** Stash any in-flight changes, switch to dev, pull, branch.

  ```bash
  cd /home/simon/Documents/Compendiq/compendiq-ce
  git fetch origin
  git switch -c feature/146-llm-policy-resolver-hook origin/dev
  ```

- [ ] **Step 2:** Verify clean tree.

  ```bash
  git status
  ```
  Expected: `nothing to commit, working tree clean`.

---

### Task A2: Extend `EnterprisePlugin` contract with `resolveUsecaseOverride`

**Files:**
- Modify: `backend/src/core/enterprise/types.ts`

- [ ] **Step 1:** Add the optional method to the `EnterprisePlugin` interface. Append at the bottom of the interface, before the closing brace.

  ```ts
  /**
   * Optional runtime override hook consulted by `resolveUsecase` in the
   * LLM provider resolver. When EE's org LLM policy is enabled, this
   * returns the policy's provider id and model; otherwise null. CE noop
   * always returns null.
   */
  resolveUsecaseOverride?(usecase: import('@compendiq/contracts').LlmUsecase): Promise<{ providerId: string; model: string } | null>;
  ```

- [ ] **Step 2:** Verify TypeScript compiles.

  ```bash
  npm run typecheck -w backend
  ```
  Expected: 0 errors.

- [ ] **Step 3:** Commit.

  ```bash
  git add backend/src/core/enterprise/types.ts
  git commit -m "feat(#146): add resolveUsecaseOverride hook to EnterprisePlugin contract"
  ```

---

### Task A3: Add noop implementation that returns null

**Files:**
- Modify: `backend/src/core/enterprise/noop.ts`
- Test: `backend/src/core/enterprise/noop.test.ts` (create if absent — check first)

- [ ] **Step 1:** Check if `noop.test.ts` exists.

  ```bash
  ls backend/src/core/enterprise/noop.test.ts 2>&1
  ```

- [ ] **Step 2 (RED):** Create or extend `backend/src/core/enterprise/noop.test.ts` with:

  ```ts
  import { describe, it, expect } from 'vitest';
  import { noopPlugin } from './noop.js';

  describe('noopPlugin.resolveUsecaseOverride', () => {
    it('returns null for any usecase', async () => {
      expect(noopPlugin.resolveUsecaseOverride).toBeDefined();
      const result = await noopPlugin.resolveUsecaseOverride!('chat');
      expect(result).toBeNull();
    });

    it('returns null for summary, quality, auto_tag, embedding', async () => {
      for (const u of ['summary', 'quality', 'auto_tag', 'embedding'] as const) {
        expect(await noopPlugin.resolveUsecaseOverride!(u)).toBeNull();
      }
    });
  });
  ```

- [ ] **Step 3 (RED):** Run test — must fail because `resolveUsecaseOverride` is not defined on `noopPlugin`.

  ```bash
  cd backend && npx vitest run src/core/enterprise/noop.test.ts
  ```
  Expected: FAIL.

- [ ] **Step 4 (GREEN):** Edit `backend/src/core/enterprise/noop.ts`. Add the method right after `requireFeature`:

  ```ts
  resolveUsecaseOverride: async () => null,
  ```

- [ ] **Step 5:** Run tests.

  ```bash
  cd backend && npx vitest run src/core/enterprise/noop.test.ts
  ```
  Expected: PASS.

- [ ] **Step 6:** Commit.

  ```bash
  cd /home/simon/Documents/Compendiq/compendiq-ce
  git add backend/src/core/enterprise/noop.ts backend/src/core/enterprise/noop.test.ts
  git commit -m "feat(#146): noop returns null from resolveUsecaseOverride"
  ```

---

### Task A4: Resolver consults override before CTE query

**Files:**
- Modify: `backend/src/domains/llm/services/llm-provider-resolver.ts`
- Test: `backend/src/domains/llm/services/llm-provider-resolver.test.ts`

- [ ] **Step 1 (RED):** Open the existing test file. Add a new `describe` block at the bottom:

  ```ts
  describe.skipIf(!dbAvailable)('resolveUsecase — enterprise override', () => {
    beforeEach(async () => { /* reuse existing reset helper from this file */ });

    it('returns the override provider+model when the enterprise hook resolves a value', async () => {
      // Arrange: seed two providers; mark provider B as default and assigned to chat
      const a = await seedProvider({ name: 'A', baseUrl: 'http://a/v1', defaultModel: 'a-default' });
      const b = await seedProvider({ name: 'B', baseUrl: 'http://b/v1', defaultModel: 'b-default', isDefault: true });
      await setUsecaseAssignment('chat', { providerId: b, model: 'b-assigned' });

      // Stub enterprise.resolveUsecaseOverride to return provider A + a custom model
      vi.doMock('../../../core/enterprise/loader.js', () => ({
        getEnterprise: () => ({
          ...noopPlugin,
          resolveUsecaseOverride: async () => ({ providerId: a, model: 'override-model' }),
        }),
      }));
      vi.resetModules();
      const { resolveUsecase: r } = await import('./llm-provider-resolver.js');

      // Act
      const result = await r('chat');

      // Assert: provider A wins, model is override-model — assignment row ignored
      expect(result.config.id).toBe(a);
      expect(result.model).toBe('override-model');
    });

    it('falls through to assignment row when override returns null', async () => {
      const a = await seedProvider({ name: 'A', baseUrl: 'http://a/v1', defaultModel: 'a-default', isDefault: true });
      await setUsecaseAssignment('chat', { providerId: a, model: 'a-assigned' });

      vi.doMock('../../../core/enterprise/loader.js', () => ({
        getEnterprise: () => ({ ...noopPlugin, resolveUsecaseOverride: async () => null }),
      }));
      vi.resetModules();
      const { resolveUsecase: r } = await import('./llm-provider-resolver.js');

      const result = await r('chat');
      expect(result.config.id).toBe(a);
      expect(result.model).toBe('a-assigned');
    });
  });
  ```

  Adapt `seedProvider` / `setUsecaseAssignment` / `dbAvailable` / reset helper names to whatever the existing file already uses — read the file first.

- [ ] **Step 2 (RED):** Run the test.

  ```bash
  cd backend && npx vitest run src/domains/llm/services/llm-provider-resolver.test.ts -t 'enterprise override'
  ```
  Expected: FAIL (override is never consulted).

- [ ] **Step 3 (GREEN):** Modify `llm-provider-resolver.ts`. Add at top:

  ```ts
  import { getEnterprise } from '../../../core/enterprise/loader.js';
  ```

  Then at the start of `resolveUsecase`, before the SQL block:

  ```ts
  // Enterprise override: when org LLM policy is enabled, EE returns the
  // policy's (providerId, model). CE noop always returns null.
  const override = await getEnterprise().resolveUsecaseOverride?.(usecase);
  if (override) {
    const overrideRows = await query<ResolveRow>(
      `SELECT
         NULL::uuid AS usecase_provider_id,
         NULL::text AS usecase_model,
         id            AS provider_id,
         name          AS provider_name,
         base_url      AS provider_base_url,
         api_key       AS provider_api_key,
         auth_type     AS provider_auth_type,
         verify_ssl    AS provider_verify_ssl,
         default_model AS provider_default_model,
         is_default    AS provider_is_default
       FROM llm_providers WHERE id = $1`,
      [override.providerId],
    );
    const orow = overrideRows.rows[0];
    if (!orow) {
      throw new Error('No default provider configured — set one in Settings → LLM.');
    }
    const cacheKey = orow.provider_id;
    let cached = configCache.get(cacheKey);
    if (!cached || cached.version !== getProviderCacheVersion()) {
      cached = {
        version: getProviderCacheVersion(),
        cfg: {
          providerId: orow.provider_id,
          id: orow.provider_id,
          name: orow.provider_name,
          baseUrl: orow.provider_base_url,
          apiKey: decryptSafe(orow.provider_api_key),
          authType: orow.provider_auth_type,
          verifySsl: orow.provider_verify_ssl,
          defaultModel: orow.provider_default_model,
        },
      };
      configCache.set(cacheKey, cached);
    }
    return { config: cached.cfg, model: override.model };
  }
  ```

- [ ] **Step 4 (GREEN):** Run the test again.

  ```bash
  cd backend && npx vitest run src/domains/llm/services/llm-provider-resolver.test.ts
  ```
  Expected: PASS for both new cases and all pre-existing cases.

- [ ] **Step 5:** Run typecheck + lint.

  ```bash
  cd /home/simon/Documents/Compendiq/compendiq-ce
  npm run typecheck -w backend && npm run lint -w backend
  ```
  Expected: 0 errors / no new warnings.

- [ ] **Step 6:** Commit.

  ```bash
  git add backend/src/domains/llm/services/llm-provider-resolver.ts backend/src/domains/llm/services/llm-provider-resolver.test.ts
  git commit -m "feat(#146): resolveUsecase consults enterprise override hook"
  ```

---

### Task A5: Frontend — switch `LlmPolicyTab` to provider dropdown

**Files:**
- Modify: `frontend/src/features/admin/LlmPolicyTab.tsx`
- Test: `frontend/src/features/admin/LlmPolicyTab.test.tsx`

- [ ] **Step 1:** Read the existing test file to see the current mock setup. The frontend test scaffolding will already mock `apiFetch` — extend that.

  ```bash
  cat frontend/src/features/admin/LlmPolicyTab.test.tsx
  ```

- [ ] **Step 2 (RED):** Update test file. Replace the existing tests with assertions that:
  1. The provider radio is gone — instead a `<select data-testid="llm-policy-provider">` is rendered with options sourced from `/admin/llm-providers`.
  2. The `model` input remains a free-form text field.
  3. On save, the PUT body contains `{ enabled, providerId, model }` (not `{ provider, ... }`).

  ```tsx
  it('lists configured providers in the dropdown and submits providerId on save', async () => {
    apiFetchMock.mockImplementation(async (path: string, opts?: { method?: string; body?: string }) => {
      if (path === '/admin/llm-policy' && (!opts || opts.method !== 'PUT')) {
        return { enabled: false, providerId: null, model: null };
      }
      if (path === '/admin/llm-providers') {
        return [
          { id: 'prov-a', name: 'Local Ollama', baseUrl: 'http://o/v1', defaultModel: 'llama3' },
          { id: 'prov-b', name: 'OpenAI Proxy', baseUrl: 'http://p/v1', defaultModel: 'gpt-4o-mini' },
        ];
      }
      if (opts?.method === 'PUT') {
        putBody = JSON.parse(opts.body!);
        return { ok: true };
      }
    });

    render(<LlmPolicyTab />, { wrapper });
    await userEvent.click(await screen.findByLabelText(/enabled/i));
    await userEvent.selectOptions(await screen.findByTestId('llm-policy-provider'), 'prov-b');
    await userEvent.type(screen.getByLabelText(/model/i), 'gpt-4o-mini');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(putBody).toEqual({ enabled: true, providerId: 'prov-b', model: 'gpt-4o-mini' }));
  });
  ```

- [ ] **Step 3 (RED):** Run test.

  ```bash
  cd frontend && npx vitest run src/features/admin/LlmPolicyTab.test.tsx
  ```
  Expected: FAIL.

- [ ] **Step 4 (GREEN):** Modify `LlmPolicyTab.tsx`:
  - Replace the `OrgLlmProvider` type and `LlmPolicy` interface so `provider` becomes `providerId: string | null`.
  - Add a `useQuery(['admin','llm-providers'], () => apiFetch<Array<{id:string;name:string;baseUrl:string;defaultModel:string|null}>>('/admin/llm-providers'))` hook.
  - Replace the radio group with a `<select data-testid="llm-policy-provider" value={providerId ?? ''} onChange={…}>` populated from the providers query.
  - Update form state: `providerId` setter, populate from `policy.providerId`.
  - On submit, send `{ enabled, providerId: enabled ? providerId : null, model: enabled ? (model.trim() || null) : null }`.
  - Show the selected provider's `defaultModel` as the placeholder of the model input (look up via `providers.find(p => p.id === providerId)`).

- [ ] **Step 5 (GREEN):** Run test.

  ```bash
  cd frontend && npx vitest run src/features/admin/LlmPolicyTab.test.tsx
  ```
  Expected: PASS.

- [ ] **Step 6:** Run typecheck + lint.

  ```bash
  cd /home/simon/Documents/Compendiq/compendiq-ce
  npm run typecheck -w frontend && npm run lint -w frontend
  ```
  Expected: 0 errors.

- [ ] **Step 7:** Commit.

  ```bash
  git add frontend/src/features/admin/LlmPolicyTab.tsx frontend/src/features/admin/LlmPolicyTab.test.tsx
  git commit -m "feat(#146): LlmPolicyTab uses provider dropdown bound to /admin/llm-providers"
  ```

---

### Task A6: Push CE branch + open PR

- [ ] **Step 1:** Run the full CE test suite once.

  ```bash
  npm test
  ```
  Expected: green.

- [ ] **Step 2:** Push.

  ```bash
  git push -u origin feature/146-llm-policy-resolver-hook
  ```

- [ ] **Step 3:** Open PR against `dev`.

  ```bash
  gh pr create --base dev --title "feat(#146): add resolveUsecaseOverride hook + provider dropdown in LlmPolicyTab" --body "$(cat <<'EOF'
  ## Summary

  Backend (CE) and frontend (CE) prep work for EE #146 (rebase org LLM policy on provider IDs).

  - `EnterprisePlugin` interface gets an optional `resolveUsecaseOverride(usecase)` hook.
  - `noop.ts` returns null (community mode unchanged).
  - `resolveUsecase` consults the override before reading `llm_usecase_assignments`. EE will return the org policy's `(providerId, model)` from this hook when policy is active.
  - `LlmPolicyTab.tsx` swaps the Ollama/OpenAI radio for a Provider dropdown sourced from `/admin/llm-providers`.

  CE-only deployments are unaffected — the policy tab is gated on `hasFeature('org_llm_policy')` and the noop hook returns null.

  EE PR (compendiq-ee#TBD) lands the policy rewrite that uses this hook.

  ## Test plan

  - [ ] `npm test` green
  - [ ] Manual smoke: CE-only run shows the gated card on the policy tab
  - [ ] EE preview consumes this submodule and the override hook resolves correctly
  EOF
  )"
  ```

---

## Section B — EE: #146 service rewrite + middleware + migration

**Working directory:** `/home/simon/Documents/Compendiq/compendiq-ee`

### Task B1: Wait for CE merge, sync submodule, branch off main

- [ ] **Step 1:** Confirm the CE PR (Section A) has merged to `dev`. Pull EE main.

  ```bash
  cd /home/simon/Documents/Compendiq/compendiq-ee
  git fetch origin
  git switch main && git pull
  ```

- [ ] **Step 2:** Sync the CE submodule pointer to current `dev` HEAD.

  ```bash
  cd ce && git fetch origin && git checkout origin/dev && cd ..
  git add ce
  git commit -m "chore: sync CE submodule to dev HEAD (with #146 resolver hook)"
  ```

- [ ] **Step 3:** Create and switch to the EE feature branch.

  ```bash
  git switch -c feat/146-llm-policy-providers
  ```

---

### Task B2: Rewrite `OrgLlmPolicy` shape in service

**Files:**
- Modify: `overlay/backend/src/enterprise/llm-policy-service.ts`
- Test: `overlay/backend/src/enterprise/llm-policy-service.test.ts`

- [ ] **Step 1 (RED):** Open the existing test file and replace tests for the legacy shape with the new shape. Key tests to add:

  ```ts
  describe('OrgLlmPolicy — provider-id model', () => {
    beforeEach(async () => { await resetDb(); });

    it('returns disabled defaults when no rows exist', async () => {
      expect(await getOrgLlmPolicy()).toEqual({ enabled: false, providerId: null, model: null });
    });

    it('round-trips enabled+providerId+model', async () => {
      const id = await seedProvider({ name: 'A', baseUrl: 'http://a/v1', defaultModel: 'm1' });
      await setOrgLlmPolicy({ enabled: true, providerId: id, model: 'm1' });
      expect(await getOrgLlmPolicy()).toEqual({ enabled: true, providerId: id, model: 'm1' });
    });

    it('rejects unknown providerId on enable', async () => {
      await expect(setOrgLlmPolicy({ enabled: true, providerId: '00000000-0000-0000-0000-000000000000', model: 'm1' }))
        .rejects.toThrow(/provider.+not.+found/i);
    });

    it('rejects empty model on enable', async () => {
      const id = await seedProvider({ name: 'A', baseUrl: 'http://a/v1' });
      await expect(setOrgLlmPolicy({ enabled: true, providerId: id, model: '' }))
        .rejects.toThrow(/model.+required/i);
    });

    it('isLlmPolicyActive reflects enabled flag', async () => {
      expect(await isLlmPolicyActive()).toBe(false);
      const id = await seedProvider({ name: 'A', baseUrl: 'http://a/v1' });
      await setOrgLlmPolicy({ enabled: true, providerId: id, model: 'm1' });
      expect(await isLlmPolicyActive()).toBe(true);
    });

    it('getActivePolicyResolution returns null when disabled', async () => {
      expect(await getActivePolicyResolution()).toBeNull();
    });

    it('getActivePolicyResolution returns providerId+model when enabled', async () => {
      const id = await seedProvider({ name: 'A', baseUrl: 'http://a/v1' });
      await setOrgLlmPolicy({ enabled: true, providerId: id, model: 'm1' });
      expect(await getActivePolicyResolution()).toEqual({ providerId: id, model: 'm1' });
    });
  });
  ```

- [ ] **Step 2 (RED):** Run tests; confirm they fail.

  ```bash
  npx vitest run overlay/backend/src/enterprise/llm-policy-service.test.ts
  ```
  Expected: FAIL on type / runtime mismatches.

- [ ] **Step 3 (GREEN):** Rewrite `llm-policy-service.ts`:

  ```ts
  import { query } from '../core/db/postgres.js';
  import { logger } from '../core/utils/logger.js';

  export interface OrgLlmPolicy {
    enabled: boolean;
    providerId: string | null;
    model: string | null;
  }

  const POLICY_KEYS = {
    enabled: 'org_llm_policy_enabled',
    providerId: 'org_llm_policy_provider_id',
    model: 'org_llm_policy_model',
  } as const;
  const ALL_KEYS = Object.values(POLICY_KEYS);

  const DEFAULT_POLICY: OrgLlmPolicy = { enabled: false, providerId: null, model: null };

  export async function getOrgLlmPolicy(): Promise<OrgLlmPolicy> {
    try {
      const result = await query<{ setting_key: string; setting_value: string }>(
        `SELECT setting_key, setting_value FROM admin_settings WHERE setting_key = ANY($1::text[])`,
        [ALL_KEYS],
      );
      const map: Record<string, string> = {};
      for (const row of result.rows) map[row.setting_key] = row.setting_value;
      return {
        enabled: map[POLICY_KEYS.enabled] === 'true',
        providerId: map[POLICY_KEYS.providerId] || null,
        model: map[POLICY_KEYS.model] || null,
      };
    } catch (err) {
      logger.error({ err }, 'Failed to read org LLM policy from admin_settings');
      return { ...DEFAULT_POLICY };
    }
  }

  export async function setOrgLlmPolicy(policy: Partial<OrgLlmPolicy>): Promise<void> {
    // Validate when enabling, or when changing fields with enabled already true.
    const current = await getOrgLlmPolicy();
    const next: OrgLlmPolicy = {
      enabled: policy.enabled ?? current.enabled,
      providerId: policy.providerId !== undefined ? policy.providerId : current.providerId,
      model: policy.model !== undefined ? policy.model : current.model,
    };
    if (next.enabled) {
      if (!next.providerId) throw new Error('providerId required when enabling org LLM policy');
      if (!next.model || !next.model.trim()) throw new Error('model required when enabling org LLM policy');
      const exists = await query<{ id: string }>(
        `SELECT id FROM llm_providers WHERE id = $1`,
        [next.providerId],
      );
      if (exists.rows.length === 0) {
        throw new Error(`provider ${next.providerId} not found in llm_providers`);
      }
    }

    const upserts: Array<{ key: string; value: string }> = [];
    if (policy.enabled !== undefined) upserts.push({ key: POLICY_KEYS.enabled, value: String(policy.enabled) });
    if (policy.providerId !== undefined) upserts.push({ key: POLICY_KEYS.providerId, value: policy.providerId ?? '' });
    if (policy.model !== undefined) upserts.push({ key: POLICY_KEYS.model, value: policy.model ?? '' });
    if (upserts.length === 0) return;

    const keys = upserts.map((u) => u.key);
    const values = upserts.map((u) => u.value);
    await query(
      `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
       SELECT key, value, NOW()
       FROM unnest($1::text[], $2::text[]) AS t(key, value)
       ON CONFLICT (setting_key) DO UPDATE
       SET setting_value = EXCLUDED.setting_value, updated_at = NOW()`,
      [keys, values],
    );
    logger.info({ updatedKeys: keys }, 'Org LLM policy updated');
  }

  export async function isLlmPolicyActive(): Promise<boolean> {
    try {
      const result = await query<{ setting_value: string }>(
        `SELECT setting_value FROM admin_settings WHERE setting_key = $1`,
        [POLICY_KEYS.enabled],
      );
      return result.rows[0]?.setting_value === 'true';
    } catch (err) {
      logger.error({ err }, 'Failed to check org LLM policy status');
      return false;
    }
  }

  export async function getActivePolicyResolution(): Promise<{ providerId: string; model: string } | null> {
    const p = await getOrgLlmPolicy();
    if (!p.enabled || !p.providerId || !p.model) return null;
    return { providerId: p.providerId, model: p.model };
  }
  ```

- [ ] **Step 4 (GREEN):** Re-run tests.

  ```bash
  npx vitest run overlay/backend/src/enterprise/llm-policy-service.test.ts
  ```
  Expected: PASS.

- [ ] **Step 5:** Commit.

  ```bash
  git add overlay/backend/src/enterprise/llm-policy-service.ts overlay/backend/src/enterprise/llm-policy-service.test.ts
  git commit -m "feat(#146): rewrite OrgLlmPolicy on providerId+model with validation"
  ```

---

### Task B3: Idempotent migration of legacy values on plugin boot

**Files:**
- Modify: `overlay/backend/src/enterprise/llm-policy-service.ts`
- Test: `overlay/backend/src/enterprise/llm-policy-service.test.ts`

- [ ] **Step 1 (RED):** Add tests:

  ```ts
  describe('migrateLegacyOrgLlmPolicy', () => {
    beforeEach(async () => { await resetDb(); });

    it('disables policy and removes legacy provider key when value is "ollama"', async () => {
      await query(`INSERT INTO admin_settings (setting_key, setting_value) VALUES
        ('org_llm_policy_enabled', 'true'),
        ('org_llm_policy_provider', 'ollama'),
        ('org_llm_policy_model', 'llama3')`);
      await migrateLegacyOrgLlmPolicy();
      const enabled = await query(`SELECT setting_value FROM admin_settings WHERE setting_key = 'org_llm_policy_enabled'`);
      const legacy = await query(`SELECT 1 FROM admin_settings WHERE setting_key = 'org_llm_policy_provider'`);
      expect(enabled.rows[0].setting_value).toBe('false');
      expect(legacy.rows.length).toBe(0);
    });

    it.each(['openai', ''])('disables on legacy value %j', async (legacyVal) => {
      await query(`INSERT INTO admin_settings (setting_key, setting_value) VALUES
        ('org_llm_policy_enabled', 'true'),
        ('org_llm_policy_provider', $1),
        ('org_llm_policy_model', 'm')`, [legacyVal]);
      await migrateLegacyOrgLlmPolicy();
      const enabled = await query(`SELECT setting_value FROM admin_settings WHERE setting_key = 'org_llm_policy_enabled'`);
      expect(enabled.rows[0].setting_value).toBe('false');
    });

    it('is idempotent — second run is a no-op', async () => {
      await query(`INSERT INTO admin_settings (setting_key, setting_value) VALUES
        ('org_llm_policy_enabled', 'true'),
        ('org_llm_policy_provider', 'ollama'),
        ('org_llm_policy_model', 'm')`);
      await migrateLegacyOrgLlmPolicy();
      await migrateLegacyOrgLlmPolicy();
      const legacy = await query(`SELECT 1 FROM admin_settings WHERE setting_key = 'org_llm_policy_provider'`);
      expect(legacy.rows.length).toBe(0);
    });

    it('does nothing when no legacy key exists', async () => {
      await migrateLegacyOrgLlmPolicy();
      const all = await query(`SELECT setting_key FROM admin_settings WHERE setting_key LIKE 'org_llm_policy_%'`);
      expect(all.rows.length).toBe(0);
    });
  });
  ```

- [ ] **Step 2 (RED):** Run; expect FAIL.

- [ ] **Step 3 (GREEN):** Append to `llm-policy-service.ts`:

  ```ts
  /**
   * Migrate legacy `org_llm_policy_provider` (enum 'ollama'|'openai'|'') rows
   * to the new provider-id model. Auto-disables the policy and removes the
   * legacy key. Admin must reconfigure via the UI.
   *
   * Idempotent: running twice is a no-op.
   */
  export async function migrateLegacyOrgLlmPolicy(): Promise<void> {
    const legacy = await query<{ setting_value: string }>(
      `SELECT setting_value FROM admin_settings WHERE setting_key = 'org_llm_policy_provider'`,
    );
    if (legacy.rows.length === 0) return;
    const val = legacy.rows[0].setting_value;
    if (val !== 'ollama' && val !== 'openai' && val !== '') {
      // Unexpected — leave alone, log
      logger.warn({ val }, 'Skipping LLM policy migration: legacy key has unexpected value');
      return;
    }
    await query(
      `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
       VALUES ('org_llm_policy_enabled', 'false', NOW())
       ON CONFLICT (setting_key) DO UPDATE SET setting_value = 'false', updated_at = NOW()`,
    );
    await query(`DELETE FROM admin_settings WHERE setting_key = 'org_llm_policy_provider'`);
    logger.warn({ legacyValue: val }, 'org LLM policy disabled by migration to provider-id model — admin must reconfigure');
  }
  ```

- [ ] **Step 4 (GREEN):** Run tests.

- [ ] **Step 5:** Wire migration into `registerRoutes` (EE plugin's CE-invoked bootstrap, declared at `overlay/backend/src/enterprise/plugin.ts:167`). Add this near the top of the function body, before the first route registration:

  ```ts
  // Idempotent — safe to run on every plugin load.
  // Auto-disables the org LLM policy if it still holds a legacy
  // ('ollama' | 'openai' | '') value from before #146.
  await migrateLegacyOrgLlmPolicy();
  ```

  And add the import at the top of the file (alongside the other `./llm-policy-service.js` import if there is one — combine):

  ```ts
  import { migrateLegacyOrgLlmPolicy } from './llm-policy-service.js';
  ```

- [ ] **Step 6:** Run plugin tests.

  ```bash
  npx vitest run overlay/backend/src/enterprise/plugin.test.ts
  ```

- [ ] **Step 7:** Commit.

  ```bash
  git add overlay/backend/src/enterprise/llm-policy-service.ts overlay/backend/src/enterprise/llm-policy-service.test.ts overlay/backend/src/enterprise/plugin.ts
  git commit -m "feat(#146): idempotent migration disables legacy policy values on plugin boot"
  ```

---

### Task B4: Update route schema in `llm-policy.ts`

**Files:**
- Modify: `overlay/backend/src/routes/foundation/llm-policy.ts`
- Test: `overlay/backend/src/routes/foundation/llm-policy.test.ts` (find/extend; create if absent)

- [ ] **Step 1:** Existing route shape (verified at planning time):

  ```ts
  const UpdateLlmPolicySchema = z.object({
    enabled: z.boolean().optional(),
    provider: z.enum(['ollama', 'openai']).nullable().optional(),
    model: z.string().max(200).nullable().optional(),
  });
  // ...PUT handler logs `provider` in the audit event.
  ```

  Look for an adjacent test scaffold (`grep -l 'admin/llm-policy' overlay/backend/src/routes/`).

- [ ] **Step 2 (RED):** Write/extend tests covering:
  1. PUT with `{ enabled: true, providerId: <uuid>, model: 'm' }` succeeds when provider exists. Response body is the full policy.
  2. PUT with `{ provider: 'ollama' }` (legacy shape) returns 400 (`unrecognized_keys` from Zod) — confirms the legacy field is no longer accepted.
  3. PUT with `{ enabled: true, providerId: 'not-a-uuid', model: 'm' }` returns 400.
  4. PUT with `{ enabled: true, providerId: <unknown-uuid>, model: 'm' }` returns 400 with the service's "provider … not found" message.
  5. Audit event payload contains `providerId` instead of `provider`.

- [ ] **Step 3 (GREEN):** Replace the schema and audit-log fields:

  ```ts
  const UpdateLlmPolicySchema = z.object({
    enabled: z.boolean().optional(),
    providerId: z.string().uuid().nullable().optional(),
    model: z.string().min(1).max(200).nullable().optional(),
  }).strict(); // reject unknown keys so the legacy `provider` field 400s

  // ...inside the handler audit log:
  ...(body.providerId !== undefined && { providerId: body.providerId }),
  ```

  Wrap `setOrgLlmPolicy(body)` in a try/catch — if the service throws `provider … not found` or `model required` or `providerId required`, return `reply.status(400).send({ error: 'ValidationError', message: err.message })`. Other errors rethrow.

- [ ] **Step 4:** Run route tests + typecheck.

- [ ] **Step 5:** Commit.

  ```bash
  git add overlay/backend/src/routes/foundation/llm-policy.ts overlay/backend/src/routes/foundation/llm-policy.test.ts
  git commit -m "feat(#146): llm-policy PUT accepts providerId UUID, rejects legacy enum"
  ```

---

### Task B5: Use-case-assignment enforcement preHandler

**Files:**
- Modify: `overlay/backend/src/enterprise/llm-policy-middleware.ts`
- Modify: `overlay/backend/src/enterprise/plugin.ts` — to register the `onRoute` hook
- Test: `overlay/backend/src/enterprise/llm-policy-middleware.test.ts`

- [ ] **Step 1 (RED):** Add to `llm-policy-middleware.test.ts`:

  ```ts
  describe('createUsecaseAssignmentEnforcement', () => {
    let app: FastifyInstance;

    beforeEach(async () => {
      await resetDb();
      app = Fastify();
      // Register a stub PUT /api/admin/llm-usecases route for the test.
      app.put('/api/admin/llm-usecases', {
        preHandler: createUsecaseAssignmentEnforcement(),
      }, async () => ({ ok: true }));
      await app.ready();
    });
    afterEach(async () => app.close());

    it('returns 403 PolicyEnforced when policy is active', async () => {
      const id = await seedProvider({ name: 'A', baseUrl: 'http://a/v1' });
      await setOrgLlmPolicy({ enabled: true, providerId: id, model: 'm' });

      const res = await app.inject({ method: 'PUT', url: '/api/admin/llm-usecases', payload: {} });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: 'PolicyEnforced' });
    });

    it('passes through when policy is disabled', async () => {
      const res = await app.inject({ method: 'PUT', url: '/api/admin/llm-usecases', payload: {} });
      expect(res.statusCode).toBe(200);
    });
  });
  ```

- [ ] **Step 2 (RED):** Run; expect FAIL.

- [ ] **Step 3 (GREEN):** Append to `llm-policy-middleware.ts`:

  ```ts
  export function createUsecaseAssignmentEnforcement(): FastifyPreHandler {
    return async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      try {
        const active = await isLlmPolicyActive();
        if (active) {
          reply.status(403).send({
            error: 'PolicyEnforced',
            message: 'Use-case assignments are locked by organization LLM policy',
            statusCode: 403,
          });
        }
      } catch (err) {
        logger.error({ err }, 'LLM policy enforcement check failed (usecase assignments) — allowing request');
      }
    };
  }
  ```

- [ ] **Step 4 (GREEN):** In `plugin.ts`, register the `onRoute` hook so this preHandler attaches to the CE-registered `PUT /api/admin/llm-usecases`. Add inside the EE plugin's Fastify-instance setup (likely in `registerRoutes` or wherever the existing license-middleware is registered):

  ```ts
  fastify.addHook('onRoute', (routeOptions) => {
    if (routeOptions.method === 'PUT' && routeOptions.url === '/api/admin/llm-usecases') {
      const existing = routeOptions.preHandler;
      const enforce = createUsecaseAssignmentEnforcement();
      routeOptions.preHandler = existing
        ? Array.isArray(existing) ? [...existing, enforce] : [existing, enforce]
        : enforce;
    }
  });
  ```

- [ ] **Step 5:** Run middleware + plugin tests.

  ```bash
  npx vitest run overlay/backend/src/enterprise/llm-policy-middleware.test.ts overlay/backend/src/enterprise/plugin.test.ts
  ```

- [ ] **Step 6:** Commit.

  ```bash
  git add overlay/backend/src/enterprise/llm-policy-middleware.ts overlay/backend/src/enterprise/llm-policy-middleware.test.ts overlay/backend/src/enterprise/plugin.ts
  git commit -m "feat(#146): block PUT /api/admin/llm-usecases when org LLM policy is active"
  ```

---

### Task B6: Wire `resolveUsecaseOverride` into the EE plugin

**Files:**
- Modify: `overlay/backend/src/enterprise/plugin.ts`
- Test: `overlay/backend/src/enterprise/plugin.test.ts`

- [ ] **Step 1 (RED):** Add to plugin.test.ts:

  ```ts
  describe('plugin.resolveUsecaseOverride', () => {
    beforeEach(async () => { await resetDb(); });

    it('returns null when policy is disabled', async () => {
      expect(await enterprisePlugin.resolveUsecaseOverride!('chat')).toBeNull();
    });

    it('returns providerId+model when policy is enabled', async () => {
      const id = await seedProvider({ name: 'A', baseUrl: 'http://a/v1' });
      await setOrgLlmPolicy({ enabled: true, providerId: id, model: 'mX' });
      expect(await enterprisePlugin.resolveUsecaseOverride!('chat')).toEqual({ providerId: id, model: 'mX' });
    });

    it('returns the same value for any usecase (global policy)', async () => {
      const id = await seedProvider({ name: 'B', baseUrl: 'http://b/v1' });
      await setOrgLlmPolicy({ enabled: true, providerId: id, model: 'mY' });
      for (const u of ['chat','summary','quality','auto_tag','embedding'] as const) {
        expect(await enterprisePlugin.resolveUsecaseOverride!(u)).toEqual({ providerId: id, model: 'mY' });
      }
    });
  });
  ```

  Adapt `enterprisePlugin` to whatever the test currently imports as the EE plugin export.

- [ ] **Step 2 (RED):** Run; expect FAIL (method not defined).

- [ ] **Step 3 (GREEN):** In `plugin.ts`, import `getActivePolicyResolution` and add the method to the exported plugin object:

  ```ts
  import { getActivePolicyResolution } from './llm-policy-service.js';

  // ...inside the exported plugin object literal
  resolveUsecaseOverride: async (_usecase) => getActivePolicyResolution(),
  ```

  The hook is global — `_usecase` is unused; the policy applies to all use cases.

- [ ] **Step 4 (GREEN):** Run tests.

- [ ] **Step 5:** Commit.

  ```bash
  git add overlay/backend/src/enterprise/plugin.ts overlay/backend/src/enterprise/plugin.test.ts
  git commit -m "feat(#146): EE plugin exports resolveUsecaseOverride backed by org LLM policy"
  ```

---

### Task B7: End-to-end runtime test — policy → resolveUsecase

**Files:**
- Create: `overlay/backend/src/enterprise/llm-policy-runtime.test.ts`

- [ ] **Step 1:** Write integration test that:
  1. Seeds two providers A (default) and B.
  2. Assigns `chat` use-case to provider A in `llm_usecase_assignments`.
  3. Calls `resolveUsecase('chat')` from CE — expect provider A.
  4. Enables policy with provider B + model `mZ`.
  5. Calls `resolveUsecase('chat')` again — expect provider B and model `mZ`.
  6. Disables policy.
  7. Calls `resolveUsecase('chat')` — expect provider A again (with the assignment-row model).

  This is the canonical proof of the issue's "LLM calls resolve to the policy provider/model when policy is enabled" success criterion.

- [ ] **Step 2:** Run.

  ```bash
  npx vitest run overlay/backend/src/enterprise/llm-policy-runtime.test.ts
  ```
  Expected: PASS.

- [ ] **Step 3:** Commit.

  ```bash
  git add overlay/backend/src/enterprise/llm-policy-runtime.test.ts
  git commit -m "test(#146): end-to-end policy enforcement on resolveUsecase"
  ```

---

### Task B8: Run full EE suite + push + open PR

- [ ] **Step 1:** Run all tests.

  ```bash
  cd /home/simon/Documents/Compendiq/compendiq-ee
  npm test
  ```
  Expected: green. If failures, triage; root-cause and fix on this branch.

- [ ] **Step 2:** Push.

  ```bash
  git push -u origin feat/146-llm-policy-providers
  ```

- [ ] **Step 3:** Open PR against EE `main`.

  ```bash
  gh pr create --base main --title "fix(#146): rebase org LLM policy on provider IDs and use-case assignments" --body "$(cat <<'EOF'
  ## Summary

  Replaces the legacy `ollama|openai` enum policy with one based on `llm_providers.id` (UUID) and a free-form model string, mirroring the CE provider+use-case-assignment model.

  - `OrgLlmPolicy` shape: `{ enabled, providerId, model }`.
  - Idempotent migration on plugin boot auto-disables policy when legacy `'ollama'`/`'openai'`/`''` value is detected and removes the legacy key.
  - New preHandler returns 403 PolicyEnforced on `PUT /api/admin/llm-usecases` when policy is active.
  - EE plugin exports `resolveUsecaseOverride`; CE consumes it from `llm-provider-resolver.ts` (CE PR #TBD landed first).
  - Policy enforcement is global — same `(providerId, model)` for every use case (matches issue's wording: "LLM calls resolve to the policy provider/model").
  - `routes/foundation/llm-policy.ts` validates `providerId` as `z.string().uuid()`.

  Closes Compendiq/compendiq-ee#146.

  ## Test plan

  - [ ] All EE tests pass
  - [ ] `llm-policy-runtime.test.ts` proves the end-to-end criterion
  - [ ] Manual smoke: enable policy in UI, confirm `PUT /api/admin/llm-usecases` returns 403; chat call resolves to policy provider
  - [ ] Manual smoke: disable policy, confirm assignment row is honored again
  EOF
  )"
  ```

---

## Section C — EE: finalize #143

**Working directory:** `/home/simon/Documents/Compendiq/compendiq-ee`

### Task C1: Switch to the existing #143 branch

- [ ] **Step 1:** Switch to the branch (it has uncommitted compose edits).

  ```bash
  cd /home/simon/Documents/Compendiq/compendiq-ee
  git switch feat/143-slack-teams-deep
  git status
  ```
  Expected: `modified: docker/docker-compose.ee.yml`.

---

### Task C2: Baseline the test suite

- [ ] **Step 1:** Run with the working-tree compose still uncommitted. Capture results.

  ```bash
  npm test 2>&1 | tee /tmp/143-baseline-test.log
  ```

- [ ] **Step 2:** If failures, triage them. Group by root cause. For each unique failure mode, decide: trivial fix (apply on this branch), real bug (apply on this branch), pre-existing flake (note in PR body, do not fix).

  No specific code can be planned here without seeing the failures — investigate in-session.

- [ ] **Step 3:** Once tests are green (or knowingly-amber with documented exceptions), proceed.

---

### Task C3: Commit pending compose changes

- [ ] **Step 1:** Confirm the diff is what we expect.

  ```bash
  git diff docker/docker-compose.ee.yml
  ```
  Expected:
  - removes `OLLAMA_BASE_URL`, `LLM_PROVIDER`, `OPENAI_BASE_URL`, `EMBEDDING_MODEL` env vars
  - changes Redis `--maxmemory-policy allkeys-lru` → `noeviction`

- [ ] **Step 2:** Commit.

  ```bash
  git add docker/docker-compose.ee.yml
  git commit -m "$(cat <<'EOF'
  chore(#143): align compose with BullMQ + drop legacy LLM env

  - Redis maxmemory-policy: noeviction (BullMQ requires it; eviction
    silently drops queued jobs and breaks at-least-once delivery for the
    chat-delivery worker).
  - Drop OLLAMA_BASE_URL / LLM_PROVIDER / OPENAI_BASE_URL / EMBEDDING_MODEL
    (legacy bootstrap env vars; replaced by the llm_providers table per
    ADR-021 — kept only as fresh-install fallback in CE startup).

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task C4: Verify `SLACK_TEAMS_DEEP` advertisement

**Files:**
- Inspect: `overlay/backend/src/enterprise/plugin.ts` — already includes `SLACK_TEAMS_DEEP` in `TIER_FEATURES.enterprise` (verified at design time).
- Inspect: `overlay/backend/src/enterprise/plugin.test.ts` — assertions should expect presence.

- [ ] **Step 1:** Confirm presence.

  ```bash
  grep -n SLACK_TEAMS_DEEP overlay/backend/src/enterprise/plugin.ts
  ```

  Expected: a line inside the `enterprise` set.

- [ ] **Step 2:** Inspect plugin test for the corresponding assertion.

  ```bash
  grep -n -A2 SLACK_TEAMS_DEEP overlay/backend/src/enterprise/plugin.test.ts
  ```

  If the test still asserts absence, switch the assertion to presence.

- [ ] **Step 3:** Run plugin test.

  ```bash
  npx vitest run overlay/backend/src/enterprise/plugin.test.ts
  ```
  Expected: PASS.

- [ ] **Step 4:** If a test was modified, commit.

  ```bash
  git add overlay/backend/src/enterprise/plugin.test.ts
  git commit -m "test(#143): assert SLACK_TEAMS_DEEP advertised on enterprise tier"
  ```

  Otherwise skip.

---

### Task C5: Sync CE submodule if behind

- [ ] **Step 1:** Check if the EE branch's CE pin is behind `dev`.

  ```bash
  cd ce && git fetch origin && git log --oneline HEAD..origin/dev | head -10 && cd ..
  ```

- [ ] **Step 2:** If behind by anything material, sync.

  ```bash
  cd ce && git checkout origin/dev && cd ..
  git add ce
  git commit -m "chore: sync CE submodule to dev HEAD"
  ```

- [ ] **Step 3:** Re-run the EE test suite.

  ```bash
  npm test
  ```

---

### Task C6: Push + open PR

- [ ] **Step 1:** Push.

  ```bash
  git push -u origin feat/143-slack-teams-deep
  ```

- [ ] **Step 2:** Open PR.

  ```bash
  gh pr create --base main --title "feat(#143): slack_teams_deep foundations + finalize" --body "$(cat <<'EOF'
  ## Summary

  Finalises the Slack/Teams deep-integration foundations branch.

  Backend additions on this branch:
  - Slack OAuth flow with state-cookie binding (login-CSRF defense).
  - Teams JWT validation, with the non-prod bypass closed.
  - Multi-tenant token storage with isolation guard.
  - BullMQ-based chat-delivery worker + outbox poller for at-least-once delivery to Slack/Teams.
  - Channel→space mapping service.
  - Slack Events API signature verification.
  - Admin + event routes (`chat-events`, `chat-integrations-admin`, `chat-mappings-admin`).

  This PR also:
  - Switches Redis `maxmemory-policy` to `noeviction` (BullMQ durability requirement).
  - Drops legacy LLM env vars from compose (replaced by `llm_providers`, ADR-021).
  - Re-adds `SLACK_TEAMS_DEEP` to `TIER_FEATURES.enterprise` and pins the assertion in `plugin.test.ts` to presence.

  Closes Compendiq/compendiq-ee#143.

  ## Test plan

  - [ ] EE test suite green
  - [ ] Plugin test asserts `SLACK_TEAMS_DEEP` advertised on enterprise tier
  - [ ] Manual smoke: Slack OAuth happy-path, Teams JWT happy-path
  - [ ] Manual smoke: enable a chat integration, confirm a chat-delivery job is enqueued via BullMQ outbox
  EOF
  )"
  ```

---

## Self-review checklist

- **Spec coverage:**
  - #146 storage rename → Tasks B2 (service rewrite uses new key names).
  - #146 migration → Task B3.
  - #146 service validation → Task B2.
  - #146 route schema → Task B4.
  - #146 admin mutation enforcement → Task B5.
  - #146 runtime override → Tasks A4 (CE side) + B6 (EE side) + B7 (E2E).
  - #146 frontend dropdown → Task A5.
  - #143 compose commit → Task C3.
  - #143 SLACK_TEAMS_DEEP advertisement → Task C4.
  - #143 PR → Task C6.

- **No placeholders.** All code shown; no "TBD", "implement later". One spot intentionally left to in-session inspection: Task C2 step 2 (test failures unknown until run) — acceptable because the failure space cannot be enumerated in advance.

- **Type consistency.** `OrgLlmPolicy.providerId` (camel) used throughout; database key `org_llm_policy_provider_id` (snake) used in SQL. `resolveUsecaseOverride` signature matches between A2, A3, A4, B6.

---

## Execution model — Agent Teams

`TeamCreate` with three members:

- **`ee-policy-impl`** (`code-implementer`) — Sections A and B.
- **`ee-slack-finalize`** (`code-implementer`) — Section C.
- **`ee-reviewer`** (`critic`) — pre-PR review on each branch before push.

Both implementers can start in parallel (different repos / different branches in EE). The reviewer gate runs serially per PR.

Sequencing:

1. `ee-policy-impl` runs Section A, opens CE PR.
2. After CE PR merges to `dev`, `ee-policy-impl` runs Section B (depends on the new CE submodule pin).
3. `ee-slack-finalize` runs Section C in parallel from start (independent of #146).
4. `ee-reviewer` runs before each push.

External docs (Ref MCP / `gemini-researcher`) consulted ad-hoc during impl: BullMQ Redis policies (already settled), Fastify `addHook('onRoute')` semantics, Zod 4 UUID validation, jose for any JWT touches in #143 follow-up fixes.
