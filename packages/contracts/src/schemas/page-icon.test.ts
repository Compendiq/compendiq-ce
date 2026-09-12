import { describe, it, expect } from 'vitest';
import {
  PAGE_LUCIDE_ICON_IDS,
  PAGE_BRAND_ICON_IDS,
  UpdatePageIconSchema,
  PageIconSchema,
  isPageLucideIconId,
  isPageBrandIconId,
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

  it('accepts a lucide mark with a text-palette colour', () => {
    expect(PageIconSchema.parse({ kind: 'lucide', value: 'rocket', color: '#3b82f6' })).toEqual({
      kind: 'lucide',
      value: 'rocket',
      color: '#3b82f6',
    });
    expect(PageIconSchema.parse({ kind: 'lucide', value: 'rocket', color: '#6366f1' })).toEqual({
      kind: 'lucide',
      value: 'rocket',
      color: '#6366f1',
    });
  });

  it('accepts a lucide mark with filled option', () => {
    expect(
      PageIconSchema.parse({ kind: 'lucide', value: 'camera', color: '#6366f1', filled: true }),
    ).toEqual({
      kind: 'lucide',
      value: 'camera',
      color: '#6366f1',
      filled: true,
    });
    expect(
      UpdatePageIconSchema.parse({
        icon: { kind: 'lucide', value: 'camera', filled: true },
      }).icon,
    ).toEqual({
      kind: 'lucide',
      value: 'camera',
      filled: true,
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
    expect(PAGE_LUCIDE_ICON_IDS.length).toBeGreaterThanOrEqual(600);
  });

  it('includes newly expanded navigation, devices, and creation icons', () => {
    expect(isPageLucideIconId('arrow-right')).toBe(true);
    expect(isPageLucideIconId('arrow-up-right')).toBe(true);
    expect(isPageLucideIconId('monitor-smartphone')).toBe(true);
    expect(isPageLucideIconId('shield-x')).toBe(true);
    expect(isPageLucideIconId('chart-column')).toBe(true);
    expect(isPageLucideIconId('send')).toBe(true);
    expect(isPageLucideIconId('pencil')).toBe(true);
  });

  it('includes sports and outdoor marks', () => {
    expect(isPageLucideIconId('footprints')).toBe(true);
    expect(isPageLucideIconId('life-buoy')).toBe(true);
    expect(isPageLucideIconId('sailboat')).toBe(true);
    expect(isPageLucideIconId('volleyball')).toBe(true);
    expect(isPageLucideIconId('bike')).toBe(true);
    expect(isPageLucideIconId('mountain-snow')).toBe(true);
  });
});

describe('brand marks', () => {
  it('accepts catalogue logos including major IT companies', () => {
    for (const slug of ['docker', 'microsoft', 'ibm', 'apple', 'google', 'amazon', 'oracle', 'sap', 'cisco', 'intel', 'nvidia']) {
      expect(UpdatePageIconSchema.parse({ icon: { kind: 'brand', value: slug } }).icon).toEqual({
        kind: 'brand',
        value: slug,
      });
      expect(isPageBrandIconId(slug)).toBe(true);
    }
  });

  it('covers an extensive IT company and tech brand catalogue', () => {
    expect(PAGE_BRAND_ICON_IDS.length).toBeGreaterThanOrEqual(200);
  });

  it('includes sports and outdoor logos', () => {
    for (const slug of ['strava', 'garmin', 'adidas', 'nike', 'komoot', 'alltrails']) {
      expect(isPageBrandIconId(slug)).toBe(true);
    }
  });

  it('rejects an unknown icon colour on PATCH', () => {
    expect(() =>
      UpdatePageIconSchema.parse({
        icon: { kind: 'lucide', value: 'rocket', color: '#ffffff' },
      }),
    ).toThrow();
  });

  it('rejects an unknown logo slug', () => {
    expect(() =>
      UpdatePageIconSchema.parse({ icon: { kind: 'brand', value: 'not-a-logo' } }),
    ).toThrow();
  });
});
