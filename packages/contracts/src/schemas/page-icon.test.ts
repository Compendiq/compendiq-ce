import { describe, it, expect } from 'vitest';
import {
  PAGE_LUCIDE_ICON_IDS,
  UpdatePageIconSchema,
  PageIconSchema,
  isPageLucideIconId,
} from './page-icon.js';

describe('PageIconSchema', () => {
  it('accepts an emoji mark', () => {
    expect(PageIconSchema.parse({ kind: 'emoji', value: '🚀' })).toEqual({
      kind: 'emoji',
      value: '🚀',
    });
  });

  it('accepts a lucide mark', () => {
    expect(PageIconSchema.parse({ kind: 'lucide', value: 'rocket' })).toEqual({
      kind: 'lucide',
      value: 'rocket',
    });
  });

  it('accepts a brand mark', () => {
    expect(PageIconSchema.parse({ kind: 'brand', value: 'docker' })).toEqual({
      kind: 'brand',
      value: 'docker',
    });
  });
});

describe('UpdatePageIconSchema', () => {
  it('accepts null to clear the mark', () => {
    expect(UpdatePageIconSchema.parse({ icon: null })).toEqual({ icon: null });
  });

  it('accepts a catalogue lucide id', () => {
    expect(UpdatePageIconSchema.parse({ icon: { kind: 'lucide', value: 'book' } }).icon).toEqual({
      kind: 'lucide',
      value: 'book',
    });
  });

  it('rejects an unknown lucide id', () => {
    expect(() =>
      UpdatePageIconSchema.parse({ icon: { kind: 'lucide', value: 'globe' } }),
    ).toThrow();
  });

  it('rejects image on PATCH — that is POST /icon-image', () => {
    expect(() =>
      UpdatePageIconSchema.parse({ icon: { kind: 'image', value: 'abc' } }),
    ).toThrow();
  });

  it('rejects control characters in an emoji', () => {
    expect(() =>
      UpdatePageIconSchema.parse({ icon: { kind: 'emoji', value: 'a<script>' } }),
    ).toThrow();
  });
});

describe('PAGE_LUCIDE_ICON_IDS', () => {
  it('does not include space-chrome glyphs', () => {
    expect(PAGE_LUCIDE_ICON_IDS).not.toContain('globe');
    expect(PAGE_LUCIDE_ICON_IDS).not.toContain('hard-drive');
  });

  it('isPageLucideIconId matches the catalogue', () => {
    expect(isPageLucideIconId('rocket')).toBe(true);
    expect(isPageLucideIconId('globe')).toBe(false);
    expect(isPageLucideIconId('workflow')).toBe(true);
    expect(isPageLucideIconId('kanban')).toBe(true);
  });

  it('covers a broad page-mark set, not a short starter list', () => {
    expect(PAGE_LUCIDE_ICON_IDS.length).toBeGreaterThanOrEqual(290);
  });
});

describe('brand marks', () => {
  it('accepts a catalogue logo', () => {
    expect(UpdatePageIconSchema.parse({ icon: { kind: 'brand', value: 'docker' } }).icon).toEqual({
      kind: 'brand',
      value: 'docker',
    });
  });

  it('rejects an unknown logo slug', () => {
    expect(() =>
      UpdatePageIconSchema.parse({ icon: { kind: 'brand', value: 'not-a-logo' } }),
    ).toThrow();
  });
});
