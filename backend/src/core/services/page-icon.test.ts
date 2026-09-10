import { describe, it, expect } from 'vitest';
import { toPageIcon } from './page-icon.js';

describe('toPageIcon', () => {
  it('returns null when either half is missing', () => {
    expect(toPageIcon(null, '🚀')).toBeNull();
    expect(toPageIcon('emoji', null)).toBeNull();
    expect(toPageIcon(undefined, undefined)).toBeNull();
  });

  it('returns null for an unknown kind', () => {
    expect(toPageIcon('sticker', 'x')).toBeNull();
  });

  it('returns a typed mark when both halves are present', () => {
    expect(toPageIcon('emoji', '🚀')).toEqual({ kind: 'emoji', value: '🚀' });
    expect(toPageIcon('lucide', 'rocket')).toEqual({ kind: 'lucide', value: 'rocket' });
    expect(toPageIcon('image', 'abc')).toEqual({ kind: 'image', value: 'abc' });
    expect(toPageIcon('brand', 'docker')).toEqual({ kind: 'brand', value: 'docker' });
  });
});
