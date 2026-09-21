import { afterEach, describe, expect, it } from 'vitest';
import {
  _resetPageBaselineGovernanceForTests,
  getPageBaselineDeploymentReadiness,
  setPageBaselineReadinessProvider,
} from './page-baseline-governance.js';

afterEach(() => {
  _resetPageBaselineGovernanceForTests();
});

describe('page baseline deployment readiness', () => {
  it('fails closed until protected-writer enforcement explicitly registers', async () => {
    await expect(getPageBaselineDeploymentReadiness()).resolves.toEqual({
      ready: false,
      blockers: ['protected_writer_enforcement_not_registered'],
    });
  });

  it('cannot report ready while its provider reports any blocker', async () => {
    setPageBaselineReadinessProvider(async () => ({
      ready: true,
      blockers: ['writer-a', '', 'writer-a', 'writer-b'],
    }));

    await expect(getPageBaselineDeploymentReadiness()).resolves.toEqual({
      ready: false,
      blockers: ['writer-a', 'writer-b'],
    });
  });

  it('fails closed without leaking a readiness provider failure', async () => {
    setPageBaselineReadinessProvider(async () => {
      throw new Error('private deployment topology');
    });

    await expect(getPageBaselineDeploymentReadiness()).resolves.toEqual({
      ready: false,
      blockers: ['deployment_readiness_unavailable'],
    });
  });
});
