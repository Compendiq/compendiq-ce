import { describe, expect, it } from 'vitest';
import { asRevision, decideAiPolicyAdmission, decodeProviderMetadata, type ProviderMetadataRow } from './ai-policy-admission.js';

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
    expect(decodeProviderMetadata(row({ locality_declared_at: new Date(NaN) }))).toBeNull();
    expect(decodeProviderMetadata(row({ locality_declared_by: '' }))).toBeNull();
  });

  it('an OMITTED declaration column (undefined) is unprovable, while SQL NULL is a value', () => {
    // Omitted: a SELECT that forgot the column must never read as "NULL declaration".
    expect(decodeProviderMetadata(row({ locality_declared_by: undefined }))).toBeNull();
    expect(decodeProviderMetadata(row({ locality_declared_at: undefined }))).toBeNull();
    expect(decodeProviderMetadata(row({ locality_config_revision: undefined }))).toBeNull();
    expect(decodeProviderMetadata(
      row({ locality: 'external', locality_declared_by: undefined, locality_declared_at: undefined, locality_config_revision: undefined }),
    )).toBeNull();
    // SQL NULL on an external row: legitimate, undeclared.
    expect(decodeProviderMetadata(
      row({ locality: 'external', locality_declared_by: null, locality_declared_at: null, locality_config_revision: null }),
    )).toMatchObject({ effectiveLocality: 'external', declaredBy: null, declaredAt: null });
    // SQL NULL declarer on a local row: actor deleted → effective external, still decodable.
    expect(decodeProviderMetadata(row({ locality_declared_by: null })))
      .toMatchObject({ effectiveLocality: 'external', declaredBy: null, declaredAt: AT, configRevision: 3 });
  });

  it('distinct real bigint revisions never compare equal after decoding', () => {
    const big = '9007199254740991'; // MAX_SAFE_INTEGER
    expect(decodeProviderMetadata(row({ config_revision: big, locality_config_revision: big }))?.effectiveLocality).toBe('local');
    expect(decodeProviderMetadata(row({ config_revision: '123456789012345', locality_config_revision: '123456789012344' }))?.effectiveLocality)
      .toBe('external');
    // Beyond the safe range the row is unprovable rather than rounded into equality.
    expect(decodeProviderMetadata(row({ config_revision: '9007199254740993', locality_config_revision: '9007199254740992' }))).toBeNull();
  });
});

describe('asRevision', () => {
  it('accepts non-negative safe integers as numbers or decimal strings', () => {
    expect(asRevision(0)).toBe(0);
    expect(asRevision(7)).toBe(7);
    expect(asRevision('0')).toBe(0);
    expect(asRevision('007')).toBe(7);
    expect(asRevision('42')).toBe(42);
    expect(asRevision(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(asRevision('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('rejects non-finite, negative, fractional and unsafe numbers', () => {
    expect(asRevision(Number.NaN)).toBeNull();
    expect(asRevision(Number.POSITIVE_INFINITY)).toBeNull();
    expect(asRevision(Number.NEGATIVE_INFINITY)).toBeNull();
    expect(asRevision(-1)).toBeNull();
    expect(asRevision(1.5)).toBeNull();
    expect(asRevision(2 ** 53)).toBeNull();
    expect(asRevision(Number.MAX_SAFE_INTEGER + 2)).toBeNull();
  });

  it('rejects digit strings that would only decode by rounding (2^53, 2^53+1, 400 digits)', () => {
    expect(asRevision('9007199254740992')).toBeNull();
    expect(asRevision('9007199254740993')).toBeNull();
    expect(asRevision('18446744073709551615')).toBeNull();
    expect(asRevision('1'.repeat(400))).toBeNull();
    expect(asRevision('9'.repeat(400))).toBeNull();
    // Leading zeros do not smuggle an unsafe value past the length check.
    expect(asRevision('0009007199254740993')).toBeNull();
    expect(asRevision('0009007199254740991')).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('rejects every other shape', () => {
    for (const v of ['', ' 1', '1 ', '-1', '+1', '1.0', '1e3', '0x10', 'abc', null, undefined, true, {}, [], 1n]) {
      expect(asRevision(v), String(v)).toBeNull();
    }
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
