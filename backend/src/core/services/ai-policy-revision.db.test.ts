import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool } from '../db/postgres.js';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../test-db-helper.js';
import { exactAiPolicyRevision, safeAiPolicyRevision } from './ai-policy-revision.js';
import { admitFreshConfluencePublication } from './ai-policy-ingestion.js';

const available = await isDbAvailable();
describe.skipIf(!available)('exact policy revision and fresh upstream floor', () => {
  beforeAll(async () => { await setupTestDb(); await truncateAllTables(); });
  afterAll(async () => { await teardownTestDb(); });
  it('does not round PostgreSQL bigint tokens', async () => {
    const client = await getPool().connect();
    try {
      const result = await client.query('SELECT 9007199254740993::bigint AS revision');
      expect(exactAiPolicyRevision(result.rows[0]!.revision)).toBe(9007199254740993n);
      expect(safeAiPolicyRevision(result.rows[0]!.revision)).toBeNull();
      for (const invalid of [undefined, null, '', '1.0', '1e3', -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        expect(exactAiPolicyRevision(invalid)).toBeNull();
      }
      expect(safeAiPolicyRevision('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER);
    } finally { client.release(); }
  });
  it('never publishes an ingestion candidate looser than its upstream labels', async () => {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await expect(admitFreshConfluencePublication(client, {
        confluenceId: 'upstream-floor', resolvedPolicy: 'all', labels: ['ordinary', 'no-ai'],
      })).rejects.toMatchObject({ reason: 'ai_policy_enforcement_unavailable' });
      await expect(admitFreshConfluencePublication(client, {
        confluenceId: 'ordinary', resolvedPolicy: 'all', labels: ['ordinary'],
      })).resolves.toEqual({ policy: 'all', labels: ['ordinary', 'all-ai'] });
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
});
