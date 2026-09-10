import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  readLastConfluenceSpace,
  rememberConfluenceSpace,
  forgetLastConfluenceSpace,
} from './last-confluence-space';

const KEY = 'compendiq:last-confluence-space';

describe('last-confluence-space', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when nothing has been remembered', () => {
    expect(readLastConfluenceSpace()).toBeNull();
  });

  it('round-trips a space key', () => {
    rememberConfluenceSpace('DEV');
    expect(readLastConfluenceSpace()).toBe('DEV');
  });

  it('overwrites the previous key', () => {
    rememberConfluenceSpace('DEV');
    rememberConfluenceSpace('OPS');
    expect(readLastConfluenceSpace()).toBe('OPS');
  });

  it('forgets on request, so the next user in the tab starts clean', () => {
    rememberConfluenceSpace('DEV');
    forgetLastConfluenceSpace();
    expect(readLastConfluenceSpace()).toBeNull();
  });

  // The whole module is a convenience. Private browsing, a full quota or a
  // hardened storage policy must degrade to "no memory", never to a thrown
  // error that takes the New Page form down with it.
  describe('when localStorage is unavailable', () => {
    it('reads as null instead of throwing', () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new DOMException('denied', 'SecurityError');
      });

      expect(() => readLastConfluenceSpace()).not.toThrow();
      expect(readLastConfluenceSpace()).toBeNull();
    });

    it('swallows a failed write', () => {
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new DOMException('quota', 'QuotaExceededError');
      });

      expect(() => rememberConfluenceSpace('DEV')).not.toThrow();
    });

    it('swallows a failed clear', () => {
      vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
        throw new DOMException('denied', 'SecurityError');
      });

      expect(() => forgetLastConfluenceSpace()).not.toThrow();
    });
  });

  it('stores under a stable, namespaced key', () => {
    rememberConfluenceSpace('DEV');
    expect(localStorage.getItem(KEY)).toBe('DEV');
  });
});
