import { describe, it, expect } from 'vitest';
import {
  SETTINGS_NAV,
  legacyTabMap,
  canSeeItem,
  firstVisiblePath,
  type AccessContext,
  type SettingsNavItem,
} from './settings-nav';

function ctx(partial: Partial<AccessContext> = {}): AccessContext {
  return {
    isAdmin: false,
    isEnterprise: false,
    hasFeature: () => false,
    ...partial,
  };
}

describe('legacyTabMap', () => {
  it('maps every group/item with a non-null legacyTabId to /settings/<group>/<item>', () => {
    for (const group of SETTINGS_NAV) {
      for (const item of group.items) {
        if (item.legacyTabId !== null) {
          expect(legacyTabMap[item.legacyTabId]).toBe(`/settings/${group.id}/${item.id}`);
        }
      }
    }
  });

  it('maps `confluence` to /settings/personal/confluence (default legacyTabId === id)', () => {
    expect(legacyTabMap['confluence']).toBe('/settings/personal/confluence');
  });

  it('maps `ollama` to /settings/ai/llm (the one divergent legacy id)', () => {
    expect(legacyTabMap['ollama']).toBe('/settings/ai/llm');
  });
});

describe('canSeeItem', () => {
  const vanillaItem: SettingsNavItem = { id: 'confluence', label: 'Confluence', legacyTabId: 'confluence' };
  const adminItem: SettingsNavItem = { id: 'labels', label: 'Labels', legacyTabId: 'labels', adminOnly: true };
  const enterpriseItem: SettingsNavItem = {
    id: 'llm-policy',
    label: 'LLM Policy',
    legacyTabId: 'llm-policy',
    adminOnly: true,
    enterpriseOnly: true,
    requiresFeature: 'org_llm_policy',
  };

  it('returns true for a vanilla item with a default-user context', () => {
    expect(canSeeItem(vanillaItem, ctx())).toBe(true);
  });

  it('returns false for adminOnly when isAdmin is false', () => {
    expect(canSeeItem(adminItem, ctx({ isAdmin: false }))).toBe(false);
  });

  it('returns true for adminOnly when isAdmin is true', () => {
    expect(canSeeItem(adminItem, ctx({ isAdmin: true }))).toBe(true);
  });

  it('returns false for an enterprise-gated item when isEnterprise is false (even with feature flag true)', () => {
    // Enterprise check short-circuits before the feature check — that's the
    // documented ordering on canSeeItem. Regression guards it.
    expect(
      canSeeItem(enterpriseItem, ctx({ isAdmin: true, isEnterprise: false, hasFeature: () => true })),
    ).toBe(false);
  });

  it('returns true when admin + enterprise + feature flag all present', () => {
    expect(
      canSeeItem(enterpriseItem, ctx({ isAdmin: true, isEnterprise: true, hasFeature: () => true })),
    ).toBe(true);
  });

  it('returns false when the requiresFeature check fails', () => {
    expect(
      canSeeItem(enterpriseItem, ctx({ isAdmin: true, isEnterprise: true, hasFeature: () => false })),
    ).toBe(false);
  });
});

describe('firstVisiblePath', () => {
  it('returns /settings/personal/confluence for a vanilla user (first item in first group)', () => {
    expect(firstVisiblePath(ctx())).toBe('/settings/personal/confluence');
  });
});
