import { describe, it, expect } from 'vitest';
import { PAGE_LUCIDE_ICONS } from '@compendiq/contracts';
import { getPageLucideIcon } from './page-lucide-icons';

describe('page lucide catalogue', () => {
  it('resolves every catalogue id to a glyph', () => {
    const missing = PAGE_LUCIDE_ICONS.filter((item) => !getPageLucideIcon(item.value)).map(
      (item) => item.value,
    );
    expect(missing).toEqual([]);
  });

  it('has an expanded icon count covering 600+ icons', () => {
    expect(PAGE_LUCIDE_ICONS.length).toBeGreaterThanOrEqual(600);
  });

  it('resolves newly expanded icons', () => {
    expect(getPageLucideIcon('arrow-right')).toBeTruthy();
    expect(getPageLucideIcon('monitor-smartphone')).toBeTruthy();
    expect(getPageLucideIcon('shield-x')).toBeTruthy();
    expect(getPageLucideIcon('pencil')).toBeTruthy();
  });
});
