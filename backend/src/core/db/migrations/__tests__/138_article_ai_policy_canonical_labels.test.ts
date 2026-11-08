import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { setupTestDb, teardownTestDb, isDbAvailable } from '../../../../test-db-helper.js';
import { query } from '../../postgres.js';
import { applyCanonicalAiPolicyLabel } from '@compendiq/contracts';

const available = await isDbAvailable();
const sql = fs.readFileSync(new URL('../138_article_ai_policy_canonical_labels.sql', import.meta.url), 'utf8');
const oldSql = fs.readFileSync(new URL('../136_article_ai_policy_labels.sql', import.meta.url), 'utf8');

describe.skipIf(!available)('138 canonical policy helper', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });

  it('matches contracts for fresh, upgraded and repeated helper installation', async () => {
    for (const install of [sql, oldSql + sql, sql]) {
      await query(install);
      for (const policy of ['all', 'local_only', 'none'] as const) {
        for (const labels of [[], ['ordinary'], ['ordinary', 'ai:none', 'ai:all', 'local_only']]) {
          const result = await query('SELECT ai_policy_apply_label($1, $2) AS labels', [labels, policy]);
          expect(result.rows[0].labels).toEqual(applyCanonicalAiPolicyLabel(labels, policy));
        }
      }
    }
  });
});
