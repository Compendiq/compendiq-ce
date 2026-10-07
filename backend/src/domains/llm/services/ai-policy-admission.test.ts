import { describe, expect, it } from 'vitest';
import { decideAiPolicyAdmission } from './ai-policy-admission.js';

describe('decideAiPolicyAdmission', () => {
  const local = { locality: 'local', localityConfigRevision: 3, configRevision: 3 };

  it('none blocks every provider', () => {
    expect(decideAiPolicyAdmission('none', local)).toBe('policy_none');
  });

  it('local_only admits a provider declared local at the current revision', () => {
    expect(decideAiPolicyAdmission('local_only', local)).toBe('admit');
  });

  it('a stale declaration (endpoint edited) is not local', () => {
    expect(decideAiPolicyAdmission('local_only', { ...local, configRevision: 4 })).toBe('provider_not_local');
  });

  it('unknown locality never authorizes local_only', () => {
    expect(decideAiPolicyAdmission('local_only', { locality: 'external', localityConfigRevision: null, configRevision: 1 }))
      .toBe('provider_not_local');
    expect(decideAiPolicyAdmission('local_only', { locality: 'local', localityConfigRevision: null, configRevision: 1 }))
      .toBe('provider_not_local');
  });

  it('all admits external providers', () => {
    expect(decideAiPolicyAdmission('all', { locality: 'external', localityConfigRevision: null, configRevision: 1 })).toBe('admit');
  });
});
