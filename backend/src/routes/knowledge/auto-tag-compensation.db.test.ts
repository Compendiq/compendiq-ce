import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../test-db-helper.js';
import { query } from '../../core/db/postgres.js';
import { encryptPat } from '../../core/utils/crypto.js';

const available = await isDbAvailable();
describe.skipIf(!available)('acknowledged generated label compensation', () => {
  beforeAll(setupTestDb);
  afterAll(teardownTestDb);
  it.each(['model', 'configuration', 'conflict', 'interrupted'])('recovers an obsolete %s effect without replaying AI output', async (mode) => {
    await truncateAllTables();
    vi.resetModules();
    const writer = await import('../../core/services/page-write-admission.js');
    const tagger = await import('../../domains/knowledge/services/auto-tagger.js');
    let labels = ['human', 'all-ai'];
    let obsolete = true;
    let providerId = '';
    const server = createServer(async (request, response) => {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      response.setHeader('content-type', 'application/json');
      if (request.url === '/v1/chat/completions') {
        response.end(JSON.stringify({ choices: [{ message: { content: '["architecture"]' } }] }));
      } else if (request.method === 'GET') {
        response.end(JSON.stringify({ results: labels.map((name) => ({ name })), size: labels.length, limit: 200 }));
      } else if (request.method === 'DELETE') {
        const url = new URL(request.url!, 'http://localhost');
        const label = url.searchParams.get('name') ?? decodeURIComponent(url.pathname.split('/').pop()!);
        labels = labels.filter((name) => name !== label);
        response.end('{}');
      } else {
        for (const label of JSON.parse(raw) as { name: string }[]) if (!labels.includes(label.name)) labels.push(label.name);
        if (obsolete) {
          obsolete = false;
          if (mode === 'configuration') await query("UPDATE llm_providers SET base_url = base_url || '/' WHERE id = $1", [providerId]);
          else await query("UPDATE llm_usecase_assignments SET model = 'replacement' WHERE usecase = 'auto_tag'");
        }
        response.end('{}');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const actor = (await query(`INSERT INTO users (username, email, password_hash, role)
        VALUES ('compensator', 'compensator@test.invalid', 'x', 'admin') RETURNING id`)).rows[0].id as string;
      await query(`INSERT INTO spaces (space_key, space_name) VALUES ('REPAIR', 'Repair')`);
      await query(`INSERT INTO user_settings (user_id, confluence_url, confluence_pat, confluence_enabled)
        VALUES ($1, $2, $3, TRUE)`, [actor, origin, encryptPat('fixture')]);
      providerId = (await query(`INSERT INTO llm_providers (name, base_url, auth_type, default_model, is_default)
        VALUES ('compensation', $1, 'none', 'original', TRUE) RETURNING id`, [`${origin}/v1`])).rows[0].id;
      await query(`INSERT INTO llm_usecase_assignments (usecase, provider_id, model) VALUES ('auto_tag', $1, 'original')`, [providerId]);
      const page = (await query(`INSERT INTO pages (confluence_id, space_key, title, body_html, body_text, source, labels)
        VALUES ('remote-repair', 'REPAIR', 'Authored', '<p>Authored quasar</p>', 'Authored quasar', 'confluence', ARRAY['human','all-ai']) RETURNING id`)).rows[0].id as number;
      const before = (await query('SELECT body_html, body_text, tsv::text, ai_policy FROM pages WHERE id = $1', [page])).rows[0];
      await expect(tagger.autoTagPage(actor, String(page), undefined, (tags, articleStage) =>
        tagger.applyLabelChanges(actor, String(page), { add: tags, articleStage }).then(() => {}))).rejects.toThrow();
      expect(labels).toContain('architecture');
      const intent = (await query("SELECT * FROM page_write_intents WHERE status = 'pending'")).rows[0];
      expect(intent.remote_effects_completed_at).not.toBeNull();
      const originalReceipt = intent.remote_terminal_result;
      const ack = await writer.quiescePageWriterRuntime({ actorId: actor, reason: 'Retire obsolete generated label writer' });
      await writer.fencePageWriterRuntime({ runtimeId: ack.runtimeId, mode: 'owner_ack', acknowledgmentId: ack.acknowledgmentId,
        actorId: actor, reason: 'Recover obsolete generated label publication' });
      vi.resetModules();
      const recovery = await import('../../core/services/page-write-admission.js');
      const reconciler = await import('../../domains/confluence/services/ordinary-page-write-reconciler.js');
      reconciler.registerOrdinaryPageWriteReconcilers();
      const authorization = { actorId: actor, reason: 'Compensate exact acknowledged generated label effect' };
      if (mode === 'conflict') {
        labels.push('concurrent-human');
        await expect(recovery.reconcilePageWriteIntent(intent.id, authorization)).rejects.toMatchObject({ reason: 'intent_terminal_evidence_mismatch' });
        expect(labels).toContain('concurrent-human');
        expect(labels).toContain('architecture');
        expect((await query('SELECT status FROM page_write_intents WHERE id = $1', [intent.id])).rows[0].status).toBe('pending');
        return;
      }
      if (mode === 'interrupted') {
        await query(`CREATE FUNCTION refuse_compensation_settlement() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN IF NEW.status = 'reconciled_not_applied' THEN RAISE EXCEPTION 'interrupted settlement'; END IF; RETURN NEW; END $$`);
        await query('CREATE TRIGGER refuse_compensation_settlement BEFORE UPDATE ON page_write_intents FOR EACH ROW EXECUTE FUNCTION refuse_compensation_settlement()');
        try {
          await expect(recovery.reconcilePageWriteIntent(intent.id, authorization)).rejects.toThrow('interrupted settlement');
          expect(labels.sort()).toEqual(['all-ai', 'human']);
          expect((await query('SELECT completed_at FROM page_generated_label_compensations WHERE intent_id = $1', [intent.id])).rows[0].completed_at).not.toBeNull();
          await expect(recovery.withPageWriteTransaction([page], async () => {})).rejects.toMatchObject({ reason: 'page_write_busy' });
        } finally {
          await query('DROP TRIGGER refuse_compensation_settlement ON page_write_intents');
          await query('DROP FUNCTION refuse_compensation_settlement()');
        }
      }
      await expect(recovery.reconcilePageWriteIntent(intent.id, authorization)).resolves.toMatchObject({ status: 'reconciled_not_applied' });
      expect(labels.sort()).toEqual(['all-ai', 'human']);
      expect((await query('SELECT labels FROM pages WHERE id = $1', [page])).rows[0].labels.sort()).toEqual(labels);
      expect((await query('SELECT body_html, body_text, tsv::text, ai_policy FROM pages WHERE id = $1', [page])).rows[0]).toEqual(before);
      const journal = (await query('SELECT * FROM page_generated_label_compensations WHERE intent_id = $1', [intent.id])).rows[0];
      expect(journal).toMatchObject({ next_step: 1, in_flight: false });
      expect(journal.completed_at).not.toBeNull();
      expect((await query('SELECT remote_terminal_result FROM page_write_intents WHERE id = $1', [intent.id])).rows[0].remote_terminal_result).toEqual(originalReceipt);
      await expect(recovery.reconcilePageWriteIntent(intent.id, authorization)).rejects.toMatchObject({ statusCode: 409 });
      const fresh = await import('../../domains/knowledge/services/auto-tagger.js');
      await fresh.autoTagPage(actor, String(page), undefined, (tags, articleStage) =>
        fresh.applyLabelChanges(actor, String(page), { add: tags, articleStage }).then(() => {}));
      expect(labels).toContain('architecture');
      expect((await query("SELECT * FROM page_write_intents WHERE status = 'pending'")).rows).toHaveLength(0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
