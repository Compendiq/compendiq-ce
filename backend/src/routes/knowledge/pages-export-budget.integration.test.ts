import type { FastifyInstance } from 'fastify';
import { extractText } from 'unpdf';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { query } from '../../core/db/postgres.js';
import { generateAccessToken } from '../../core/plugins/auth.js';
import { MAX_PDF_CODE_ROWS } from '../../core/services/pdf-code-budget.js';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../test-db-helper.js';
import { insertStandalonePage, insertUser } from './pages.test-helpers.js';

const available = await isDbAvailable();

describe.skipIf(!available)('PDF export row admission (#1962)', () => {
  let app: FastifyInstance;
  let owner: string;
  let stranger: string;
  let headers: { authorization: string };

  beforeAll(async () => {
    await setupTestDb();
    await truncateAllTables();
    app = await buildApp();
    await app.ready();
    owner = await insertUser('pdf-owner');
    stranger = await insertUser('pdf-stranger');
    headers = { authorization: `Bearer ${await generateAccessToken({ sub: owner, username: 'pdf-owner', role: 'user' })}` };
  });

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  async function page(title: string, rows: number, user: string) {
    const id = await insertStandalonePage(title, 'private', user, '_standalone');
    await query('UPDATE pages SET body_html = $2 WHERE id = $1', [id, `<pre>${'a\n'.repeat(rows)}</pre>`]);
    return id;
  }
  const single = (id: number) => app.inject({ method: 'POST', url: `/api/pages/${id}/export/pdf`, headers });
  const batch = (pageIds: number[]) => app.inject({ method: 'POST', url: '/api/pages/export/pdf', headers, payload: { pageIds } });

  it('rejects all bytes on overflow, and charges only visible records in the current request', async () => {
    const full = await page('At limit', MAX_PDF_CODE_ROWS, owner);
    const extra = await page('Another page', 1, owner);
    const over = await page('Visible secret marker', MAX_PDF_CODE_ROWS + 1, owner);
    const hidden = await page('Hidden secret marker', MAX_PDF_CODE_ROWS + 1, stranger);
    const missing = 2147483647;

    for (const response of [await single(over), await batch([extra, full])]) {
      expect(response.statusCode).toBe(413);
      expect(response.headers['content-type']).toContain('application/json');
      expect(response.headers['content-disposition']).toBeUndefined();
      expect(response.json().message).toMatch(/shorten.*code blocks|fewer articles/i);
      expect(response.body).not.toMatch(/secret marker|At limit|Another page|%PDF/i);
    }
    const denied = await single(hidden);
    expect(denied.statusCode).toBe(404);
    expect(denied.json()).toEqual((await single(missing)).json());
    expect((await batch([hidden, missing])).statusCode).toBe(404);

    // No budget left over from the rejected request, no charge for exclusions.
    const allowed = await batch([full, hidden, missing]);
    expect(allowed.statusCode).toBe(200);
    expect(allowed.headers['content-type']).toBe('application/pdf');
    const { text } = await extractText(new Uint8Array(allowed.rawPayload), { mergePages: true });
    expect(text).toContain('At limit');
    expect(text).not.toContain('Hidden secret marker');
    expect((await single(extra)).rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
