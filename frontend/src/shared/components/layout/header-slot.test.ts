import { describe, it, expect } from 'vitest';
import { routeHeaderTitle } from './header-slot-utils';

describe('routeHeaderTitle', () => {
  it('names the tool routes', () => {
    expect(routeHeaderTitle('/')).toBe('Pages');
    expect(routeHeaderTitle('/pages')).toBe('Pages');
    expect(routeHeaderTitle('/ai')).toBe('AI');
    expect(routeHeaderTitle('/graph')).toBe('Graph');
    expect(routeHeaderTitle('/settings/ai-models/providers')).toBe('Settings');
    expect(routeHeaderTitle('/trash')).toBe('Trash');
  });

  it('leaves document surfaces to their own headings', () => {
    expect(routeHeaderTitle('/pages/abc')).toBeNull();
    expect(routeHeaderTitle('/pages/new')).toBeNull();
  });
});
