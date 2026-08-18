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
});
