/**
 * Sub-page LLM context must not pull a restricted descendant's title or body
 * into the prompt of a caller without a page ACE (real PostgreSQL).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { query } from '../../../core/db/postgres.js';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../../test-db-helper.js';
import {
  restrictedLeaks,
  seedRestrictionFixture,
  type RestrictionFixture,
} from '../../../routes/knowledge/page-restriction.test-helpers.js';
import { assembleSubPageContext, fetchSubPages, hasSubPages } from './subpage-context.js';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('sub-page context — page restrictions', () => {
  let fx: RestrictionFixture;

  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => {
    await truncateAllTables();
    await teardownTestDb();
  });
  beforeEach(async () => {
    await truncateAllTables();
    fx = await seedRestrictionFixture();
  });

  it('omits a restricted child from R and keeps it for the group ACE holder and the administrator', async () => {
    const readerContext = await assembleSubPageContext(fx.readerId, 'c-open-root', '<p>root</p>', 'Open Root');
    expect(restrictedLeaks(readerContext.markdown)).toEqual([]);
    expect(readerContext.includedPages).toEqual(['Open Root']);
    expect(await hasSubPages(fx.readerId, 'c-open-root')).toBe(false);

    for (const userId of [fx.groupReaderId, fx.adminId]) {
      const context = await assembleSubPageContext(userId, 'c-open-root', '<p>root</p>', 'Open Root');
      expect(context.includedPages).toEqual(['Open Root', 'Hushed Leaf']);
      expect(context.markdown).toContain('hushleafbody');
      expect(await hasSubPages(userId, 'c-open-root')).toBe(true);
    }
  });

  it('drops the child on the next call once the group ACE is revoked', async () => {
    expect((await fetchSubPages(fx.groupReaderId, 'c-open-root')).map((page) => page.title)).toEqual(['Hushed Leaf']);
    await query('DELETE FROM access_control_entries WHERE id = ANY($1::int[])', [fx.groupAceIds]);
    expect(await fetchSubPages(fx.groupReaderId, 'c-open-root')).toEqual([]);
  });
});
