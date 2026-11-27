/**
 * #1954 (coordinator decision D24, review B-R4-B1): an AI Improve prompt with
 * sub-pages holds exactly the Markdown it held at slice A, for the parent (layout
 * tokens) and for every child (converted without options). Slice A's prompt was
 * captured over a real PostgreSQL by backend/scripts/capture-improve-parity-1954.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setupTestDb, teardownTestDb, truncateAllTables, isDbAvailable } from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import { assembleContextIfNeeded } from '../../../routes/llm/_helpers.js';
import { IMPROVE_PARITY_ASSEMBLED_AT_A, IMPROVE_PARITY_AT_A } from '../../../core/services/__fixtures__/improve-parity-1954-a.js';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('AI Improve prompt with sub-pages: linked code as at slice A (#1954, D24)', () => {
  let caller: string;

  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => {
    await truncateAllTables();
    const user = await query<{ id: string }>(
      "INSERT INTO users (username, email, password_hash, role) VALUES ('parity-1954', 'parity@test', 'x', 'user') RETURNING id",
    );
    caller = user.rows[0]!.id;
  });

  async function insertPage(title: string, parentId: string | null, html: string): Promise<number> {
    const page = await query<{ id: number }>(
      `INSERT INTO pages (title, source, visibility, space_key, confluence_id, parent_id,
                          body_text, body_storage, body_html, embedding_dirty, created_by_user_id)
       VALUES ($1, 'standalone', 'shared', NULL, NULL, $2, $1, '', $3, FALSE, $4) RETURNING id`,
      [title, parentId, html, caller],
    );
    return page.rows[0]!.id;
  }

  it('assembles the parent and every child into the same Markdown as slice A', async () => {
    const htmlOf = (name: string): string => IMPROVE_PARITY_AT_A[name]!.html;
    const { parent: parentCase, children } = IMPROVE_PARITY_ASSEMBLED_AT_A;
    const parent = await insertPage('Parent', null, htmlOf(parentCase));
    for (const [index, name] of children.entries()) {
      await insertPage(`Child ${String(index + 1).padStart(2, '0')} ${name}`, String(parent), htmlOf(name));
    }

    // As the Improve route asks for it: media protected, layout tokens for the parent only.
    const assembled = await assembleContextIfNeeded(caller, String(parent), htmlOf(parentCase), true, {
      protectMedia: true, layoutTokens: true,
    });
    expect(assembled.markdown).toBe(IMPROVE_PARITY_ASSEMBLED_AT_A.markdown);
    expect(assembled.multiPageSuffix).toBe(IMPROVE_PARITY_ASSEMBLED_AT_A.multiPageSuffix);
  });
});
