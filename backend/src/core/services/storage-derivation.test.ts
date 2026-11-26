import { describe, expect, it } from 'vitest';
import {
  NO_STORAGE_DERIVATION_FEATURES,
  assertStorageDerivationFeatures,
  decodeStorageDerivationFeatures,
  encodeStorageDerivationFeatures,
  storageDerivationRegistry,
} from './storage-derivation.js';

// What the registry looks like once three sibling features have shipped, in
// the order they happened to merge (not alphabetical).
const shipped = storageDerivationRegistry(['nested-tasks', 'cell-align', 'link-kinds']);

describe('storage-derivation features (#1953)', () => {
  it('records a set as its names in ascending order, whatever order it was built in', () => {
    expect(shipped.encode(new Set(['nested-tasks', 'link-kinds', 'cell-align'] as const)))
      .toEqual(['cell-align', 'link-kinds', 'nested-tasks']);
    expect(shipped.encode(new Set(['link-kinds'] as const))).toEqual(['link-kinds']);
  });

  it('records nothing for the empty set', () => {
    expect(shipped.encode(shipped.none)).toBeUndefined();
    expect(encodeStorageDerivationFeatures(NO_STORAGE_DERIVATION_FEATURES)).toBeUndefined();
  });

  it('reads a partial subset back as exactly that subset, never as every registered feature', () => {
    const decoded = shipped.decode(['link-kinds']);
    expect(decoded).toEqual({ ok: true, features: new Set(['link-kinds']) });
    if (!decoded.ok) throw new Error('unreachable');
    expect(shipped.has(decoded.features, 'link-kinds')).toBe(true);
    expect(shipped.has(decoded.features, 'nested-tasks')).toBe(false);
    expect(shipped.has(decoded.features, 'cell-align')).toBe(false);
  });

  it('round-trips every subset of the registered features', () => {
    const names = [...shipped.all];
    for (let mask = 1; mask < 2 ** names.length; mask += 1) {
      const subset = new Set(names.filter((_, index) => (mask >> index) & 1));
      expect(shipped.decode(shipped.encode(subset))).toEqual({ ok: true, features: subset });
    }
  });

  it('runs every gated step for a writer that states no set, and none for the empty set', () => {
    for (const feature of shipped.all) {
      expect(shipped.has(undefined, feature)).toBe(true);
      expect(shipped.has(shipped.all, feature)).toBe(true);
      expect(shipped.has(shipped.none, feature)).toBe(false);
    }
  });

  it.each([
    ['a string', 'link-kinds'],
    ['null', null],
    ['an object', { 0: 'link-kinds', length: 1 }],
    // The empty set records no key, so an empty list is not something encode wrote.
    ['an empty list', []],
    ['an unsorted list', ['link-kinds', 'cell-align']],
    ['a repeated name', ['cell-align', 'cell-align']],
    ['a non-string member', ['cell-align', 7]],
    ['a nested list', [['cell-align']]],
    ['an upper-case name', ['Cell-align']],
    ['a name starting with a digit', ['1-cell']],
    ['an empty name', ['']],
    ['a name of 33 characters', [`a${'b'.repeat(32)}`]],
    ['a name with a space', ['cell align']],
    ['17 names', Array.from({ length: 17 }, (_, index) => `f${String(index).padStart(2, '0')}`)],
  ])('refuses %s as malformed', (_label, value) => {
    expect(shipped.decode(value)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('reports a well-formed name it does not register as unknown, also beside registered ones', () => {
    expect(shipped.decode(['carrier-reconcile'])).toEqual({ ok: false, reason: 'unknown' });
    expect(shipped.decode(['cell-align', 'zz-later-feature'])).toEqual({ ok: false, reason: 'unknown' });
    expect(decodeStorageDerivationFeatures(['never-registered-feature'])).toEqual({ ok: false, reason: 'unknown' });
  });

  it('refuses to derive with a set that names an unregistered feature', () => {
    expect(() => shipped.assert(new Set(['cell-align', 'link-kinds']))).not.toThrow();
    expect(() => shipped.assert(new Set(['cell-align', 'carrier-reconcile']))).toThrow(/unregistered feature/);
    expect(() => assertStorageDerivationFeatures(new Set(['never-registered-feature']))).toThrow(
      /unregistered feature/,
    );
  });

  it.each([
    ['an invalid name', ['Cell-Align']],
    ['a repeated name', ['cell-align', 'cell-align']],
    ['more than 16 names', Array.from({ length: 17 }, (_, index) => `feature-${index}`)],
  ])('rejects a registration with %s', (_label, names) => {
    expect(() => storageDerivationRegistry(names)).toThrow(/Invalid storage-derivation feature registration/);
  });
});
