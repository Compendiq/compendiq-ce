import { describe, it, expect, beforeEach } from 'vitest';
import { migrateStorageKey } from './migrate-storage-key';

describe('migrateStorageKey', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('copies old key to new key and removes old key', () => {
    localStorage.setItem('kb-theme', '{"state":{"theme":"obsidian-violet"}}');

    migrateStorageKey('kb-theme', 'atlasmind-theme');

    expect(localStorage.getItem('atlasmind-theme')).toBe('{"state":{"theme":"obsidian-violet"}}');
    expect(localStorage.getItem('kb-theme')).toBeNull();
  });

  it('does nothing if new key already exists', () => {
    localStorage.setItem('kb-theme', '{"state":{"theme":"old"}}');
    localStorage.setItem('atlasmind-theme', '{"state":{"theme":"new"}}');

    migrateStorageKey('kb-theme', 'atlasmind-theme');

    // New key preserved, old key untouched
    expect(localStorage.getItem('atlasmind-theme')).toBe('{"state":{"theme":"new"}}');
    expect(localStorage.getItem('kb-theme')).toBe('{"state":{"theme":"old"}}');
  });

  it('does nothing if neither key exists', () => {
    migrateStorageKey('kb-theme', 'atlasmind-theme');

    expect(localStorage.getItem('atlasmind-theme')).toBeNull();
    expect(localStorage.getItem('kb-theme')).toBeNull();
  });

  it('does nothing if only new key exists', () => {
    localStorage.setItem('atlasmind-theme', '{"state":{"theme":"current"}}');

    migrateStorageKey('kb-theme', 'atlasmind-theme');

    expect(localStorage.getItem('atlasmind-theme')).toBe('{"state":{"theme":"current"}}');
  });
});
