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

  it('keeps a catalogue text colour on lucide and brand marks', () => {
    expect(toPageIcon('lucide', 'rocket', '#3b82f6')).toEqual({
      kind: 'lucide',
      value: 'rocket',
      color: '#3b82f6',
    });
    expect(toPageIcon('brand', 'strava', '#ef4444')).toEqual({
      kind: 'brand',
      value: 'strava',
      color: '#ef4444',
    });
  });

  it('drops colour on emoji and image marks, and on unknown hex', () => {
    expect(toPageIcon('emoji', '🚀', '#3b82f6')).toEqual({ kind: 'emoji', value: '🚀' });
    expect(toPageIcon('image', 'abc', '#3b82f6')).toEqual({ kind: 'image', value: 'abc' });
    expect(toPageIcon('lucide', 'rocket', '#ffffff')).toEqual({ kind: 'lucide', value: 'rocket' });
  });
});
