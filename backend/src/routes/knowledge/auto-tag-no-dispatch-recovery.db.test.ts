import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../test-db-helper.js';
import { query } from '../../core/db/postgres.js';
import {
  reservePageWriteIntent, runPageWriteIntentEffect, quiescePageWriterRuntime,
  fencePageWriterRuntime,
} from '../../core/services/page-write-admission.js';

const available = await isDbAvailable();
describe.skipIf(!available)('generated labels never dispatched recovery', () => {
  beforeAll(async () => { await setupTestDb(); await truncateAllTables(); });
  afterAll(async () => { await teardownTestDb(); });

  it('settles without publishing generated output or restoring historical labels', async () => {
    const actor = (await query<{ id: string }>(`INSERT INTO users
      (username, email, password_hash, role) VALUES ('recovery', 'recovery@test.invalid', 'x', 'admin')
      RETURNING id`)).rows[0]!.id;
    const page = (await query<{ id: number }>(`INSERT INTO pages
      (confluence_id, title, body_html, body_text, source, labels, ai_policy)
      VALUES ('never-sent', 'Authored', '<p>Authored</p>', 'Authored', 'confluence',
        ARRAY['human','no-ai'], 'none') RETURNING id`)).rows[0]!.id;
    const before = (await query('SELECT labels, ai_policy, ai_policy_revision, body_html, body_text, content_revision FROM pages WHERE id=$1', [page])).rows[0];
    const intent = await reservePageWriteIntent({ pageIds: [page], kind: 'page.labels', actorId: actor,
      effect: { effectClass: 'remote', pageId: page, confluenceId: 'never-sent',
        priorLabels: ['historical'], targetLabels: ['historical', 'architecture'],
        // No AI authority can be recovered from this legacy descriptor. That
        // is irrelevant to proving that no generated output was dispatched.
        autoTagStage: {} } });
    await expect(runPageWriteIntentEffect(intent, { kind: 'local' }, async () => {
      throw new Error('Stopped before remote dispatch');
    })).rejects.toThrow('Stopped before remote dispatch');
    const ack = await quiescePageWriterRuntime({ actorId: actor, reason: 'Drain the stopped writer for recovery' });
    await fencePageWriterRuntime({ runtimeId: ack.runtimeId, mode: 'owner_ack',
      acknowledgmentId: ack.acknowledgmentId, actorId: actor, reason: 'Recover the safely drained writer' });

    // A new module graph supplies a genuinely distinct writer epoch, not
    // fabricated journal markers or a substituted persistence implementation.
    vi.resetModules();
    const recovery = await import('../../core/services/page-write-admission.js');
    const reconcilers = await import('../../domains/confluence/services/ordinary-page-write-reconciler.js');
    reconcilers.registerOrdinaryPageWriteReconcilers();
    await expect(recovery.reconcilePageWriteIntent(intent.id, {
      actorId: actor, reason: 'Settle the generated labels that never left the server',
    })).resolves.toEqual({ intentId: intent.id, status: 'reconciled_not_applied' });
    const stored = (await query('SELECT status, settlement_proof FROM page_write_intents WHERE id=$1', [intent.id])).rows[0];
    expect(stored).toMatchObject({ status: 'reconciled_not_applied',
      settlement_proof: { kind: 'remote_effect_not_started' } });
    expect((await query('SELECT labels, ai_policy, ai_policy_revision, body_html, body_text, content_revision FROM pages WHERE id=$1', [page])).rows[0]).toEqual(before);
    await expect(recovery.withPageWriteTransaction([page], async () => 'fresh write admitted')).resolves.toBe('fresh write admitted');
    await expect(recovery.reconcilePageWriteIntent(intent.id, {
      actorId: actor, reason: 'Repeated settlement must not replay historical labels',
    })).rejects.toMatchObject({ statusCode: 409 });
  });
});
