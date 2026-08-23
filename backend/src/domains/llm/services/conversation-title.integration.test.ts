import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { query } from '../../../core/db/postgres.js';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../../../test-db-helper.js';
import { persistGeneratedConversationTitle } from './conversation-title.js';

const dbAvailable = await isDbAvailable();
const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';

describe.skipIf(!dbAvailable)('persistGeneratedConversationTitle (#1361)', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => {
    await truncateAllTables();
    await query(
      `INSERT INTO users (id, username, email, role, password_hash) VALUES
         ($1, 'title_owner', 'title-owner@test.local', 'user', 'x'),
         ($2, 'other_owner', 'other-owner@test.local', 'user', 'x')`,
      [USER_ID, OTHER_USER_ID],
    );
  });

  async function insertConversation(titleSource: 'question' | 'user'): Promise<string> {
    const inserted = await query<{ id: string }>(
      `INSERT INTO llm_conversations
         (user_id, model, title, title_source, messages, updated_at)
       VALUES ($1, 'chat-model', $2, $3, '[]'::jsonb, '2026-08-23T10:00:00.000Z')
       RETURNING id`,
      [USER_ID, titleSource === 'user' ? 'Manual title' : 'Question fallback', titleSource],
    );
    return inserted.rows[0]!.id;
  }

  it('updates only the owner question fallback and does not bump updated_at', async () => {
    const id = await insertConversation('question');

    expect(await persistGeneratedConversationTitle(id, USER_ID, 'Generated title')).toBe(true);
    const saved = await query<{ title: string; title_source: string; updated_at: Date }>(
      'SELECT title, title_source, updated_at FROM llm_conversations WHERE id = $1',
      [id],
    );
    expect(saved.rows[0]).toMatchObject({ title: 'Generated title', title_source: 'generated' });
    expect(saved.rows[0]!.updated_at.toISOString()).toBe('2026-08-23T10:00:00.000Z');
  });

  it('leaves a manual rename and another user\'s row untouched', async () => {
    const id = await insertConversation('user');

    expect(await persistGeneratedConversationTitle(id, USER_ID, 'Late generated title')).toBe(false);
    expect(await persistGeneratedConversationTitle(id, OTHER_USER_ID, 'Foreign generated title')).toBe(false);
    const saved = await query<{ title: string; title_source: string }>(
      'SELECT title, title_source FROM llm_conversations WHERE id = $1',
      [id],
    );
    expect(saved.rows[0]).toEqual({ title: 'Manual title', title_source: 'user' });
  });
});
