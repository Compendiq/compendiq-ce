import { describe, it, expect } from 'vitest';
import { tagChipLabel } from './tag-utils';

describe('tagChipLabel', () => {
  it('names the action when there are no tags', () => {
    expect(tagChipLabel(0)).toBe('Add tags');
  });

  it('reports the count once there is a value', () => {
    expect(tagChipLabel(1)).toBe('1 tag');
    expect(tagChipLabel(3)).toBe('3 tags');
  });
});
