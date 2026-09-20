import type { PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '../db/postgres.js';
import { isDbAvailable, setupTestDb, teardownTestDb } from '../../test-db-helper.js';
import {
  _resetPageBaselineGovernanceForTests,
  getPageBaselineDeploymentReadiness,
  setPageBaselineReadinessProvider,
} from './page-baseline-governance.js';

const dbAvailable = await isDbAvailable();
let client: PoolClient;

beforeAll(async () => { await setupTestDb(); });
beforeEach(async () => { client = await getPool().connect(); });
afterAll(async () => { await teardownTestDb(); });

afterEach(() => {
  _resetPageBaselineGovernanceForTests();
  client?.release();
});

describe.skipIf(!dbAvailable)('page baseline deployment readiness', () => {
  it('fails closed until protected-writer enforcement explicitly registers', async () => {
    await expect(getPageBaselineDeploymentReadiness(client)).resolves.toEqual({
      ready: false,
      blockers: ['protected_writer_enforcement_not_registered'],
    });
  });

  it('cannot report ready while its provider reports any blocker', async () => {
    setPageBaselineReadinessProvider(async () => ({
      ready: true,
      blockers: ['writer-a', '', 'writer-a', 'writer-b'],
    }));

    await expect(getPageBaselineDeploymentReadiness(client)).resolves.toEqual({
      ready: false,
      blockers: ['writer-a', 'writer-b'],
    });
  });

  it('fails closed without leaking a readiness provider failure', async () => {
    setPageBaselineReadinessProvider(async () => {
      throw new Error('private deployment topology');
    });

    await expect(getPageBaselineDeploymentReadiness(client)).resolves.toEqual({
      ready: false,
      blockers: ['deployment_readiness_unavailable'],
    });
  });
});
