import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getPool, query } from '../../../core/db/postgres.js';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../../test-db-helper.js';
import { createProvider } from './llm-provider-service.js';
import { publishCurrentAiPolicyBlock } from './ai-policy-admission.js';

const available = await isDbAvailable();
describe.skipIf(!available)('early denial publication uses current locked state', () => {
  beforeAll(async () => { await setupTestDb(); await truncateAllTables(); });
  afterAll(async () => { await teardownTestDb(); });

  it('discards a denial overtaken by content edit or relaxation and holds the provider through publication', async () => {
    // Seed an already restricted row; this is not a rollout activation.
    const provider = await createProvider({ name: randomUUID(), baseUrl: 'http://block.test/v1', authType: 'none', verifySsl: true });
    const inserted = await query<{ id: number; content_revision: string }>(
      `INSERT INTO pages (title, source, version, visibility, ai_policy)
       VALUES ('existing', 'standalone', 1, 'shared', 'local_only') RETURNING id, content_revision::text`,
    );
    const page = inserted.rows[0]!;
    const input = { pageId: page.id, providerId: provider.id, contentRevision: page.content_revision, reason: 'provider_not_local' as const };
    let publications = 0;
    const publish = async () => { publications++; return true; };
    await query('UPDATE pages SET content_revision = content_revision + 1 WHERE id = $1', [page.id]);
    expect(await publishCurrentAiPolicyBlock(input, publish)).toBe(false);
    input.contentRevision = String(Number(input.contentRevision) + 1);
    await query("UPDATE pages SET ai_policy = 'all' WHERE id = $1", [page.id]);
    expect(await publishCurrentAiPolicyBlock(input, publish)).toBe(false);
    expect(publications).toBe(0);

    // A second pre-existing restricted article exercises serialization.
    const other = await query<{ id: number; content_revision: string }>(
      `INSERT INTO pages (title, source, version, visibility, ai_policy)
       VALUES ('restricted', 'standalone', 1, 'shared', 'local_only') RETURNING id, content_revision::text`,
    );
    const writer = await getPool().connect();
    let release = () => {};
    const hold = new Promise<void>((resolve) => { release = resolve; });
    let entered = false;
    const publication = publishCurrentAiPolicyBlock({ ...input, pageId: other.rows[0]!.id, contentRevision: other.rows[0]!.content_revision }, async (client) => {
      entered = true;
      await hold;
      await client.query('SELECT 1');
      return true;
    });
    try {
      await vi.waitFor(() => expect(entered).toBe(true));
      const pid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const edit = writer.query("UPDATE llm_providers SET base_url = 'http://new.test/v1' WHERE id = $1", [provider.id]);
      await vi.waitFor(async () => {
        const state = await query('SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1', [pid]);
        expect(state.rows[0]?.wait_event_type).toBe('Lock');
      });
      release();
      expect(await publication).toBe(true);
      await edit;
    } finally {
      release();
      await publication;
      writer.release();
    }
  });
});
