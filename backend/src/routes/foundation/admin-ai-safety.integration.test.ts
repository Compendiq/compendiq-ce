import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';

// admin.ts imports the cluster-wide LLM queue setters (Redis cache-bus).
// They are not under test here — keep Redis out of this suite.
vi.mock('../../domains/llm/services/llm-queue.js', () => ({
  setLlmConcurrencyClusterWide: vi.fn().mockResolvedValue(undefined),
  setLlmMaxQueueDepthClusterWide: vi.fn().mockResolvedValue(undefined),
}));

import {
  setupTestDb,
  truncateAllTables,
  teardownTestDb,
  isDbAvailable,
} from '../../test-db-helper.js';
import { query } from '../../core/db/postgres.js';
import { adminRoutes } from './admin.js';

/**
 * Issue #768 — route-level regression test for the AI Safety settings
 * round-trip, with the REAL `@compendiq/contracts` schemas and the REAL
 * Postgres in the loop.
 *
 * The reported symptom ("Swiss spelling — never use ß" reverts to unchecked
 * after Save + navigate away) matches exactly what a stale
 * `@compendiq/contracts` build produces: `UpdateAdminSettingsSchema.parse()`
 * silently strips the unknown `aiOutputRuleSwissSpelling` key (Zod drops
 * unknown object keys without erroring), the upsert branch is skipped, and
 * the read-back GET omits the field. The pre-existing coverage could never
 * catch that: `AiSafetyTab.test.tsx` mocks `fetch`, and
 * `ai-safety-service.test.ts` calls the service directly, bypassing the
 * contract schema. This suite closes that gap by injecting through the full
 * Fastify route → Zod contract → service → real `admin_settings` table path.
 */

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)(
  'AI Safety settings round-trip — PUT → DB → GET through the real contract schema (#768)',
  () => {
    let app: FastifyInstance;
    let adminId = '';

    beforeAll(async () => {
      await setupTestDb();
      app = Fastify({ logger: false });
      await app.register(sensible);
      // Stub auth at the decorator boundary (per repo test rules); the
      // userId is a real seeded admin row so the audit_log FK holds.
      app.decorate(
        'requireAdmin',
        async (request: { userId: string; username: string; userRole: string }) => {
          request.userId = adminId;
          request.username = 'ai_safety_admin';
          request.userRole = 'admin';
        },
      );
      await app.register(adminRoutes, { prefix: '/api' });
      await app.ready();
    });

    afterAll(async () => {
      await app.close();
      await teardownTestDb();
    });

    beforeEach(async () => {
      await truncateAllTables();
      const r = await query<{ id: string }>(
        `INSERT INTO users (username, password_hash, role)
         VALUES ('ai_safety_admin', 'fakehash', 'admin') RETURNING id`,
      );
      adminId = r.rows[0]!.id;
    });

    async function readSetting(key: string): Promise<string | null> {
      const r = await query<{ setting_value: string }>(
        `SELECT setting_value FROM admin_settings WHERE setting_key = $1`,
        [key],
      );
      return r.rows[0]?.setting_value ?? null;
    }

    it('persists aiOutputRuleSwissSpelling: true and returns it on the read-back GET (same process, 60s cache invalidated)', async () => {
      // 1. Prime the in-process 60s outputRuleCache with the default (false),
      //    exactly like the settings page does when the tab first renders.
      const initial = await app.inject({ method: 'GET', url: '/api/admin/settings' });
      expect(initial.statusCode).toBe(200);
      expect(initial.json().aiOutputRuleSwissSpelling).toBe(false);

      // 2. Save — the exact payload AiSafetyTab.handleSave() sends.
      const put = await app.inject({
        method: 'PUT',
        url: '/api/admin/settings',
        payload: {
          aiGuardrailNoFabricationEnabled: true,
          aiGuardrailNoFabrication:
            'IMPORTANT: Do not fabricate, invent, or hallucinate references, sources, URLs, citations, or bibliographic entries. If you do not have a verified source for a claim, say so explicitly. Never generate fake links or made-up author names. Only cite sources that were provided to you in the context.',
          aiOutputRuleStripReferences: true,
          aiOutputRuleReferenceAction: 'flag',
          aiOutputRuleSwissSpelling: true,
        },
      });
      expect(put.statusCode).toBe(200);

      // 3. The row must exist in admin_settings — a silently-stripped key
      //    (stale contracts build, hypothesis 1 of #768) would leave it NULL.
      expect(await readSetting('ai_output_rule_swiss_spelling')).toBe('true');

      // 4. Read-back GET (what the invalidated TanStack query refetches) must
      //    reflect the new value despite the cache primed in step 1 — the PUT
      //    handler invalidates the in-process outputRuleCache.
      const readBack = await app.inject({ method: 'GET', url: '/api/admin/settings' });
      expect(readBack.statusCode).toBe(200);
      expect(readBack.json().aiOutputRuleSwissSpelling).toBe(true);
    });

    it('persists turning the rule back OFF (true → false round-trip)', async () => {
      await query(
        `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
         VALUES ('ai_output_rule_swiss_spelling', 'true', NOW())`,
      );

      const put = await app.inject({
        method: 'PUT',
        url: '/api/admin/settings',
        payload: { aiOutputRuleSwissSpelling: false },
      });
      expect(put.statusCode).toBe(200);
      expect(await readSetting('ai_output_rule_swiss_spelling')).toBe('false');

      const readBack = await app.inject({ method: 'GET', url: '/api/admin/settings' });
      expect(readBack.json().aiOutputRuleSwissSpelling).toBe(false);
    });

    it('persists the value standalone (no sibling AI-safety fields in the payload)', async () => {
      const put = await app.inject({
        method: 'PUT',
        url: '/api/admin/settings',
        payload: { aiOutputRuleSwissSpelling: true },
      });
      expect(put.statusCode).toBe(200);
      expect(await readSetting('ai_output_rule_swiss_spelling')).toBe('true');
    });

    it('round-trips the sibling AI-safety fields too (guardrails + reference action)', async () => {
      const put = await app.inject({
        method: 'PUT',
        url: '/api/admin/settings',
        payload: {
          aiGuardrailNoFabricationEnabled: false,
          aiOutputRuleStripReferences: false,
          aiOutputRuleReferenceAction: 'strip',
          aiOutputRuleSwissSpelling: true,
        },
      });
      expect(put.statusCode).toBe(200);

      const readBack = await app.inject({ method: 'GET', url: '/api/admin/settings' });
      expect(readBack.statusCode).toBe(200);
      const body = readBack.json();
      expect(body.aiGuardrailNoFabricationEnabled).toBe(false);
      expect(body.aiOutputRuleStripReferences).toBe(false);
      expect(body.aiOutputRuleReferenceAction).toBe('strip');
      expect(body.aiOutputRuleSwissSpelling).toBe(true);
    });
  },
);
