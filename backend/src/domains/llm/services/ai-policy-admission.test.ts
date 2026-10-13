import { describe, expect, it } from 'vitest';
import { decideAiPolicyAdmission, decodeProviderMetadata, type ProviderMetadataRow } from './ai-policy-admission.js';

const USER = '11111111-1111-4111-8111-111111111111';
const AT = new Date('2026-01-01T00:00:00Z');

function row(over: Partial<ProviderMetadataRow> = {}): ProviderMetadataRow {
  return {
    locality: 'local',
    locality_config_revision: '3',
    config_revision: '3',
    locality_declared_by: USER,
    locality_declared_at: AT,
    ...over,
  };
}

describe('decodeProviderMetadata', () => {
  it('a local declaration by an existing admin at the current revision is local', () => {
    expect(decodeProviderMetadata(row())).toEqual({
      configRevision: 3,
      effectiveLocality: 'local',
      declaredBy: USER,
      declaredAt: AT,
    });
  });

  it('a stale declaration (endpoint edited) is external', () => {
    expect(decodeProviderMetadata(row({ config_revision: '4' }))?.effectiveLocality).toBe('external');
  });

  it('a declaration whose admin was deleted (declarer NULL) is external', () => {
    const decoded = decodeProviderMetadata(row({ locality_declared_by: null }));
    expect(decoded).not.toBeNull();
    expect(decoded!.effectiveLocality).toBe('external');
    expect(decoded!.declaredBy).toBeNull();
  });

  it('an undeclared provider is external', () => {
    expect(
      decodeProviderMetadata(row({ locality: 'external', locality_config_revision: null, locality_declared_by: null, locality_declared_at: null })),
    ).toEqual({ configRevision: 3, effectiveLocality: 'external', declaredBy: null, declaredAt: null });
  });

  it('a missing row is unprovable (null), never external by default', () => {
    expect(decodeProviderMetadata(undefined)).toBeNull();
    expect(decodeProviderMetadata(null)).toBeNull();
  });

  it('invalid metadata is unprovable: bad revision, unknown locality, local without its declaration columns', () => {
    expect(decodeProviderMetadata(row({ config_revision: 'abc' }))).toBeNull();
    expect(decodeProviderMetadata(row({ config_revision: '-1' }))).toBeNull();
    expect(decodeProviderMetadata(row({ config_revision: null }))).toBeNull();
    expect(decodeProviderMetadata(row({ locality: 'onprem' }))).toBeNull();
    expect(decodeProviderMetadata(row({ locality_config_revision: null }))).toBeNull();
    expect(decodeProviderMetadata(row({ locality_declared_at: null }))).toBeNull();
    expect(decodeProviderMetadata(row({ locality_declared_at: 'not a date' }))).toBeNull();
  });
});

describe('decideAiPolicyAdmission', () => {
  const local = decodeProviderMetadata(row())!;
  const external = decodeProviderMetadata(row({ config_revision: '4' }))!;
  const orphaned = decodeProviderMetadata(row({ locality_declared_by: null }))!;

  it('none blocks every provider', () => {
    expect(decideAiPolicyAdmission('none', local)).toBe('policy_none');
    expect(decideAiPolicyAdmission('none', external)).toBe('policy_none');
  });

  it('local_only admits only an effective-local provider', () => {
    expect(decideAiPolicyAdmission('local_only', local)).toBe('admit');
    expect(decideAiPolicyAdmission('local_only', external)).toBe('provider_not_local');
    expect(decideAiPolicyAdmission('local_only', orphaned)).toBe('provider_not_local');
  });

  it('all admits external providers', () => {
    expect(decideAiPolicyAdmission('all', external)).toBe('admit');
    expect(decideAiPolicyAdmission('all', orphaned)).toBe('admit');
  });
});
