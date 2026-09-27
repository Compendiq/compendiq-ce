import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageFreezePreviewResponse, PageLifecycleState } from '@compendiq/contracts';
import { PAGE_GOVERNANCE_POLICY_LOCK_KEY } from '../db/advisory-locks.js';
import { getPool, query } from '../db/postgres.js';
import { createClient, type RedisClientType } from 'redis';
import { setRedisClient } from './redis-cache.js';
import { initPageBaselineOutbox } from './page-baseline-outbox.js';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../../test-db-helper.js';
import {
  _resetPageBaselineGovernanceForTests,
  pageBaselineEligibilityDenialReason,
  registerPageBaselineEnforcementReadiness,
  setPageBaselineReadinessProvider,
} from './page-baseline-governance.js';
import {
  freezePage,
  getPageBaselineEvidence,
  getPageBaselineActivationState,
  getPageLifecycleState,
  previewPageBaseline,
  setPageBaselineCreationEnabled,
  setPageGovernancePolicy,
  unfreezePage,
} from './page-baseline-service.js';

const dbAvailable = await isDbAvailable();
const PAUSE_PAGE_TRANSITION_LOCK = 279_099;
const PAUSE_FUNCTION = 'pause_page_governance_transition_test';
const PAUSE_TRIGGER = 'pause_page_governance_transition_test';

type PolicyResult = { enabled: boolean; policyRevision: string };

// No service boundary is mocked: retained files use a temporary real directory,
// while users, policy rows, lifecycle state, history, and advisory locks all
// remain real.
describe.skipIf(!dbAvailable)('page governance policy fence — real PostgreSQL', () => {
  let attachmentsDir: string;
  let adminId: string;
  let redis: RedisClientType;
  let stopOutbox: () => Promise<void>;

  beforeAll(async () => {
    await setupTestDb();
    redis = createClient({ url: process.env.REDIS_URL, socket: { reconnectStrategy: false } });
    await redis.connect();
    setRedisClient(redis);
    attachmentsDir = await mkdtemp(join(tmpdir(), 'baseline-governance-race-'));
    vi.stubEnv('ATTACHMENTS_DIR', attachmentsDir);
  });

  beforeEach(async () => {
    await truncateAllTables();
    _resetPageBaselineGovernanceForTests();
    setPageBaselineReadinessProvider(async () => ({ ready: true, blockers: [] }));
    const admin = await query<{ id: string }>(
      `INSERT INTO users (username, email, password_hash, role, display_name)
       VALUES ('governance-race-admin', 'governance-race-admin@test.invalid', 'x', 'admin', 'Governance admin')
       RETURNING id`,
    );
    adminId = admin.rows[0]!.id;
    await query(
      `INSERT INTO user_settings (user_id, confluence_enabled)
       VALUES ($1, FALSE)`,
      [adminId],
    );
    await setPageBaselineCreationEnabled(adminId, true);
    stopOutbox = await initPageBaselineOutbox();
  });

  afterEach(async () => { await stopOutbox(); });

  afterAll(async () => {
    _resetPageBaselineGovernanceForTests();
    await redis.quit();
    await teardownTestDb();
    await rm(attachmentsDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  async function seedPage(spaceKey: string): Promise<number> {
    const page = await query<{ id: number }>(
      `INSERT INTO pages (
         source, space_key, title, body_html, body_storage, body_text,
         visibility, created_by_user_id
       ) VALUES ('standalone', $1, 'Governed document', '<p>Reviewed body</p>',
                 '<p>Reviewed body</p>', 'Reviewed body', 'shared', $2)
       RETURNING id`,
      [spaceKey, adminId],
    );
    return page.rows[0]!.id;
  }

  function publish(pageId: number, prepared: PageFreezePreviewResponse) {
    return freezePage({
      pageId,
      actorId: adminId,
      reason: 'Publish the reviewed governance race baseline',
      expectedContentRevision: prepared.contentRevision,
      expectedManifestDigest: prepared.manifestDigest,
    });
  }

  async function lifecycle(pageId: number): Promise<PageLifecycleState> {
    const client = await getPool().connect();
    try {
      return await getPageLifecycleState(client, pageId, adminId);
    } finally {
      client.release();
    }
  }


  async function installPageTransitionPause(): Promise<void> {
    await query(`CREATE FUNCTION ${PAUSE_FUNCTION}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.baseline_id IS NULL AND NEW.baseline_id IS NOT NULL THEN
          PERFORM pg_advisory_xact_lock(${PAUSE_PAGE_TRANSITION_LOCK});
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER ${PAUSE_TRIGGER} BEFORE UPDATE ON pages
      FOR EACH ROW EXECUTE FUNCTION ${PAUSE_FUNCTION}()`);
  }

  async function removePageTransitionPause(): Promise<void> {
    await query(`DROP TRIGGER IF EXISTS ${PAUSE_TRIGGER} ON pages;
      DROP FUNCTION IF EXISTS ${PAUSE_FUNCTION}()`);
  }

  async function expectAdvisoryWait(where: string, params: unknown[]): Promise<void> {
    await expect.poll(async () => (await query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_locks
          WHERE locktype = 'advisory' AND NOT granted AND ${where}
       ) AS waiting`,
      params,
    )).rows[0]!.waiting).toBe(true);
  }

  it('requires the activating administrator to have explicitly disabled Confluence', async () => {
    await setPageBaselineCreationEnabled(adminId, false);
    await query(
      'UPDATE user_settings SET confluence_enabled = TRUE WHERE user_id = $1',
      [adminId],
    );
    await expect(setPageBaselineCreationEnabled(adminId, true)).rejects.toMatchObject({
      statusCode: 409,
      reason: 'confluence_integration_enabled',
    });
    await expect(setPageBaselineCreationEnabled(adminId, false)).resolves.toMatchObject({
      creationEnabled: false,
    });

    await query('DELETE FROM user_settings WHERE user_id = $1', [adminId]);
    await expect(setPageBaselineCreationEnabled(adminId, true)).rejects.toMatchObject({
      statusCode: 409,
      reason: 'confluence_integration_enabled',
    });
    expect((await query('SELECT creation_enabled FROM page_baseline_feature_state')).rows)
      .toEqual([{ creation_enabled: false }]);
  });
  it('propagates integration-mode read failures instead of treating them as standalone mode', async () => {
    const blocker = await getPool().connect();
    const reader = await getPool().connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE user_settings IN ACCESS EXCLUSIVE MODE');
      await reader.query('BEGIN');
      await reader.query(`SET LOCAL statement_timeout = '100ms'`);
      await expect(pageBaselineEligibilityDenialReason(reader, {
        actorId: adminId,
        pageSource: 'standalone',
        lockSettings: false,
      })).rejects.toMatchObject({ code: '57014' });
    } finally {
      await reader.query('ROLLBACK').catch(() => undefined);
      await blocker.query('ROLLBACK').catch(() => undefined);
      reader.release();
      blocker.release();
    }
  });

  it('advertises and enforces standalone-source plus explicit-off eligibility', async () => {
    const pageId = await seedPage('ELIGIBILITY');
    await query(
      `UPDATE pages SET confluence_id = 'historical-id-on-local-source' WHERE id = $1`,
      [pageId],
    );
    await expect(lifecycle(pageId)).resolves.toMatchObject({
      canFreeze: true,
      freezeDeniedReason: null,
    });
    await expect(previewPageBaseline(pageId, adminId)).resolves.toMatchObject({ pageId });
    await query(
      'UPDATE user_settings SET confluence_enabled = TRUE WHERE user_id = $1',
      [adminId],
    );
    await expect(lifecycle(pageId)).resolves.toMatchObject({
      canFreeze: false,
      freezeDeniedReason: 'confluence_integration_enabled',
      canApprove: false,
      approveDeniedReason: 'confluence_integration_enabled',
    });
    await expect(previewPageBaseline(pageId, adminId)).rejects.toMatchObject({
      statusCode: 409,
      reason: 'confluence_integration_enabled',
    });

    await query('DELETE FROM user_settings WHERE user_id = $1', [adminId]);
    await expect(lifecycle(pageId)).resolves.toMatchObject({
      canFreeze: false,
      freezeDeniedReason: 'confluence_integration_enabled',
    });
    await expect(previewPageBaseline(pageId, adminId)).rejects.toMatchObject({
      reason: 'confluence_integration_enabled',
    });

    await query(
      'INSERT INTO user_settings (user_id, confluence_enabled) VALUES ($1, FALSE)',
      [adminId],
    );
    await query(
      `UPDATE pages
          SET source = 'confluence', confluence_id = 'previously-synced-eligibility'
        WHERE id = $1`,
      [pageId],
    );
    await expect(lifecycle(pageId)).resolves.toMatchObject({
      canFreeze: false,
      freezeDeniedReason: 'standalone_article_required',
      canApprove: false,
      approveDeniedReason: 'standalone_article_required',
    });
    await expect(previewPageBaseline(pageId, adminId)).rejects.toMatchObject({
      statusCode: 409,
      reason: 'standalone_article_required',
    });
  });

  it('rejects a preview after either actor mode or authoritative page source changes', async () => {
    const pageId = await seedPage('STALE-ELIGIBILITY');
    const prepared = await previewPageBaseline(pageId, adminId);

    await query(
      'UPDATE user_settings SET confluence_enabled = TRUE WHERE user_id = $1',
      [adminId],
    );
    await expect(publish(pageId, prepared)).rejects.toMatchObject({
      statusCode: 409,
      reason: 'confluence_integration_enabled',
    });

    await query(
      'UPDATE user_settings SET confluence_enabled = FALSE WHERE user_id = $1',
      [adminId],
    );
    await query(
      `UPDATE pages
          SET source = 'confluence', confluence_id = 'previously-synced-stale'
        WHERE id = $1`,
      [pageId],
    );
    await expect(publish(pageId, prepared)).rejects.toMatchObject({
      statusCode: 409,
      reason: 'standalone_article_required',
    });
    expect((await query(
      `SELECT status FROM page_baselines WHERE id = $1`,
      [prepared.baselineId],
    )).rows).toEqual([{ status: 'prepared' }]);
  });

  it('holds explicit-off mode through publication and preserves evidence and thaw after re-enable', async () => {
    const pageId = await seedPage('MODE-FENCE');
    const prepared = await previewPageBaseline(pageId, adminId);
    const blocker = await getPool().connect();
    let freezing: Promise<PageLifecycleState> | undefined;
    let enabling: Promise<unknown> | undefined;
    try {
      await installPageTransitionPause();
      await blocker.query('SELECT pg_advisory_lock($1)', [PAUSE_PAGE_TRANSITION_LOCK]);
      freezing = publish(pageId, prepared);
      await expectAdvisoryWait('objid = $1', [PAUSE_PAGE_TRANSITION_LOCK]);

      enabling = query(
        'UPDATE user_settings SET confluence_enabled = TRUE WHERE user_id = $1',
        [adminId],
      );
      await expect.poll(async () => (await query<{ waiting: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_stat_activity
            WHERE query LIKE 'UPDATE user_settings SET confluence_enabled = TRUE%'
              AND cardinality(pg_blocking_pids(pid)) > 0
         ) AS waiting`,
      )).rows[0]!.waiting).toBe(true);

      await blocker.query('SELECT pg_advisory_unlock($1)', [PAUSE_PAGE_TRANSITION_LOCK]);
      const frozen = await freezing;
      await enabling;
      expect(frozen).toMatchObject({ isFrozen: true, baselineId: prepared.baselineId });
      await expect(lifecycle(pageId)).resolves.toMatchObject({
        isFrozen: true,
        canUnfreeze: true,
        unfreezeDeniedReason: null,
        canApprove: false,
        approveDeniedReason: 'confluence_integration_enabled',
      });
      await expect(getPageBaselineEvidence(prepared.baselineId, adminId)).resolves.toMatchObject({
        baselineId: prepared.baselineId,
        provenance: 'manual_assertion',
      });

      const thawed = await unfreezePage(pageId, adminId, {
        reason: 'Explicit thaw remains available after Confluence is re-enabled',
        expectedBaselineId: prepared.baselineId,
        expectedLifecycleRevision: frozen.lifecycleRevision,
      });
      expect(thawed).toMatchObject({
        isFrozen: false,
        canFreeze: false,
        freezeDeniedReason: 'confluence_integration_enabled',
      });
      expect((await query(
        `SELECT status, provenance FROM page_baselines WHERE id = $1`,
        [prepared.baselineId],
      )).rows).toEqual([{ status: 'published', provenance: 'manual_assertion' }]);
      expect((await query(
        `SELECT action FROM page_baseline_history
          WHERE baseline_id = $1 ORDER BY created_at, id`,
        [prepared.baselineId],
      )).rows).toEqual([{ action: 'freeze' }, { action: 'thaw' }]);
    } finally {
      await blocker.query('SELECT pg_advisory_unlock_all()').catch(() => undefined);
      await Promise.allSettled([freezing, enabling].filter((value) => value !== undefined));
      blocker.release();
      await removePageTransitionPause();
    }
  });

  it.each(['absent', 'disabled'] as const)(
    'does not let an %s marker enable commit between the final marker read and manual publication',
    async (initialMarker) => {
      const spaceKey = `GOV-FREEZE-${initialMarker}`;
      const pageId = await seedPage(spaceKey);
      if (initialMarker === 'disabled') {
        await setPageGovernancePolicy({ actorId: adminId, spaceKey, enabled: false });
      }
      const prepared = await previewPageBaseline(pageId, adminId);
      const blocker = await getPool().connect();
      let freezing: Promise<PageLifecycleState> | undefined;
      let enabling: Promise<PolicyResult> | undefined;
      try {
        await installPageTransitionPause();
        await blocker.query('SELECT pg_advisory_lock($1)', [PAUSE_PAGE_TRANSITION_LOCK]);
        freezing = publish(pageId, prepared);
        await expectAdvisoryWait('objid = $1', [PAUSE_PAGE_TRANSITION_LOCK]);

        enabling = setPageGovernancePolicy({ actorId: adminId, spaceKey, enabled: true });
        await expectAdvisoryWait(
          "classid = $1 AND mode = 'ExclusiveLock'",
          [PAGE_GOVERNANCE_POLICY_LOCK_KEY],
        );

        const beforeRelease = await query<{ governance_enabled: boolean; policy_revision: string }>(
          `SELECT governance_enabled, policy_revision::text
             FROM page_governance_policies WHERE space_key = $1`,
          [spaceKey],
        );
        expect(beforeRelease.rows).toEqual(initialMarker === 'absent'
          ? []
          : [{ governance_enabled: false, policy_revision: '1' }]);

        await blocker.query('SELECT pg_advisory_unlock($1)', [PAUSE_PAGE_TRANSITION_LOCK]);
        const frozen = await freezing;
        const policy = await enabling;
        expect(frozen).toMatchObject({ isFrozen: true, provenance: 'manual_assertion' });
        expect(policy).toEqual({
          enabled: true,
          policyRevision: initialMarker === 'absent' ? '1' : '2',
        });
        expect((await query(
          `SELECT p.freeze_provenance, g.governance_enabled
             FROM pages p JOIN page_governance_policies g ON g.space_key = p.space_key
            WHERE p.id = $1`,
          [pageId],
        )).rows).toEqual([{ freeze_provenance: 'manual_assertion', governance_enabled: true }]);
      } finally {
        await blocker.query('SELECT pg_advisory_unlock_all()').catch(() => undefined);
        await Promise.allSettled([freezing, enabling].filter((value) => value !== undefined));
        blocker.release();
        await removePageTransitionPause();
      }
    },
  );


  it('keeps authorized audited thaw available after policy enablement without an EE hook', async () => {
    const spaceKey = 'GOV-THAW-AFTER-ENABLE';
    const pageId = await seedPage(spaceKey);
    const frozen = await publish(pageId, await previewPageBaseline(pageId, adminId));
    await setPageGovernancePolicy({ actorId: adminId, spaceKey, enabled: true });

    const client = await getPool().connect();
    try {
      expect(await getPageLifecycleState(client, pageId, adminId)).toMatchObject({
        canUnfreeze: true,
        unfreezeDeniedReason: null,
      });
    } finally {
      client.release();
    }
    await expect(unfreezePage(pageId, adminId, {
      reason: 'Reopen the old manual baseline under the new governance policy',
      expectedBaselineId: frozen.baselineId!,
      expectedLifecycleRevision: frozen.lifecycleRevision,
    })).resolves.toMatchObject({ isFrozen: false });
    expect((await query(
      `SELECT action, provenance FROM page_baseline_history
        WHERE original_page_id = $1 ORDER BY created_at, id`,
      [pageId],
    )).rows).toEqual([
      { action: 'freeze', provenance: 'manual_assertion' },
      { action: 'thaw', provenance: 'manual_assertion' },
    ]);
    expect((await query(
      `SELECT status, provenance FROM page_baselines WHERE id = $1`,
      [frozen.baselineId],
    )).rows).toEqual([{ status: 'published', provenance: 'manual_assertion' }]);
    expect((await query(
      `SELECT action FROM audit_log WHERE action = 'PAGE_THAWED' AND user_id = $1`,
      [adminId],
    )).rows).toEqual([{ action: 'PAGE_THAWED' }]);
  });

  it('blocks activation while an unknown writer protocol remains active', async () => {
    await setPageBaselineCreationEnabled(adminId, false);
    registerPageBaselineEnforcementReadiness();
    await query(`INSERT INTO page_writer_runtimes (runtime_id, deployment_identity)
      VALUES ('legacy-writer', '{}'::jsonb)`);

    expect(await getPageBaselineActivationState(adminId)).toMatchObject({
      creationEnabled: false,
      deploymentReady: false,
      blockers: ['incompatible_page_writer_runtime'],
    });
    await expect(setPageBaselineCreationEnabled(adminId, true)).rejects.toMatchObject({
      statusCode: 409,
      reason: 'deployment_not_ready',
    });
    expect((await query(`SELECT creation_enabled FROM page_baseline_feature_state`)).rows)
      .toEqual([{ creation_enabled: false }]);
  });

  it('cannot activate across an incompatible registration that has not committed yet', async () => {
    await setPageBaselineCreationEnabled(adminId, false);
    registerPageBaselineEnforcementReadiness();
    const legacy = await getPool().connect();
    let activation: Promise<unknown> | undefined;
    try {
      await legacy.query('BEGIN');
      const connection = await legacy.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const pid = connection.rows[0]!.pid;
      await legacy.query(`INSERT INTO page_writer_runtimes (runtime_id, deployment_identity)
        VALUES ('registering-legacy-writer', '{}'::jsonb)`);
      activation = setPageBaselineCreationEnabled(adminId, true).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await expect.poll(async () => (await query<{ waiting: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_stat_activity
            WHERE $1 = ANY(pg_blocking_pids(pid))
              AND query LIKE '%page_baseline_feature_state%'
         ) AS waiting`,
        [pid],
      )).rows[0]!.waiting).toBe(true);
      await legacy.query('COMMIT');
      await expect(activation).resolves.toMatchObject({
        error: { statusCode: 409, reason: 'deployment_not_ready' },
      });
      expect((await query(`SELECT creation_enabled FROM page_baseline_feature_state`)).rows)
        .toEqual([{ creation_enabled: false }]);
    } finally {
      await legacy.query('ROLLBACK').catch(() => undefined);
      legacy.release();
      await activation;
    }
  });

  it('refuses an old writer after evidence is published even when thawed and creation is disabled', async () => {
    registerPageBaselineEnforcementReadiness();
    const pageId = await seedPage('ROLLOUT-EVIDENCE');
    const frozen = await publish(pageId, await previewPageBaseline(pageId, adminId));
    await unfreezePage(pageId, adminId, {
      reason: 'Return to editing without retiring the published evidence',
      expectedBaselineId: frozen.baselineId!,
      expectedLifecycleRevision: frozen.lifecycleRevision,
    });
    await setPageBaselineCreationEnabled(adminId, false);

    await expect(query(`INSERT INTO page_writer_runtimes (runtime_id, deployment_identity)
      VALUES ('rollback-writer', '{}'::jsonb)`))
      .rejects.toMatchObject({ code: '55000' });
    expect(await getPageBaselineActivationState(adminId)).toMatchObject({
      creationEnabled: false,
      deploymentReady: true,
      blockers: [],
    });
  });
});
