import { describe, it, expect, beforeEach } from 'vitest';
import { migrateStorageKey } from './migrate-storage-key';

describe('migrateStorageKey', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('copies old key to new key and removes old key', () => {
    localStorage.setItem('kb-theme', '{"state":{"theme":"graphite-honey"}}');

    migrateStorageKey('kb-theme', 'compendiq-theme');

    expect(localStorage.getItem('compendiq-theme')).toBe('{"state":{"theme":"graphite-honey"}}');
    expect(localStorage.getItem('kb-theme')).toBeNull();
  });

  it('does nothing if new key already exists', () => {
    localStorage.setItem('kb-theme', '{"state":{"theme":"old"}}');
    localStorage.setItem('compendiq-theme', '{"state":{"theme":"new"}}');

    migrateStorageKey('kb-theme', 'compendiq-theme');

    // New key preserved, old key untouched
    expect(localStorage.getItem('compendiq-theme')).toBe('{"state":{"theme":"new"}}');
    expect(localStorage.getItem('kb-theme')).toBe('{"state":{"theme":"old"}}');
  });

  it('does nothing if neither key exists', () => {
    migrateStorageKey('kb-theme', 'compendiq-theme');

    expect(localStorage.getItem('compendiq-theme')).toBeNull();
    expect(localStorage.getItem('kb-theme')).toBeNull();
  });

  it('does nothing if only new key exists', () => {
    localStorage.setItem('compendiq-theme', '{"state":{"theme":"current"}}');

    migrateStorageKey('kb-theme', 'compendiq-theme');

    expect(localStorage.getItem('compendiq-theme')).toBe('{"state":{"theme":"current"}}');
  });
});
