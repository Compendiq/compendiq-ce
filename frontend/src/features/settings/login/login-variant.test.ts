import { describe, expect, it } from 'vitest';
import {
  configuredLoginVariant,
  isLoginVariantPickerEnabled,
  parseLoginVariant,
  resolveLoginVariant,
} from './login-variant';

describe('login variant configuration', () => {
  it('accepts only supported variants', () => {
    expect(parseLoginVariant('local-loop')).toBe('local-loop');
    expect(parseLoginVariant('change-desk')).toBe('change-desk');
    expect(parseLoginVariant('other')).toBeNull();
  });

  it('uses Local Loop when the build setting is absent or invalid', () => {
    expect(configuredLoginVariant(undefined)).toBe('local-loop');
    expect(configuredLoginVariant('other')).toBe('local-loop');
  });

  it('lets a valid query override the configured default', () => {
    expect(resolveLoginVariant(new URLSearchParams('loginVariant=change-desk'), 'local-loop')).toBe('change-desk');
    expect(resolveLoginVariant(new URLSearchParams('loginVariant=other'), 'change-desk')).toBe('change-desk');
  });

  it('enables the picker only for an explicit true value', () => {
    expect(isLoginVariantPickerEnabled('true')).toBe(true);
    expect(isLoginVariantPickerEnabled(true)).toBe(true);
    expect(isLoginVariantPickerEnabled('false')).toBe(false);
    expect(isLoginVariantPickerEnabled(undefined)).toBe(false);
  });
});
