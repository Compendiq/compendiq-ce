import { describe, expect, it } from 'vitest';

describe('IntersectionObserver test double', () => {
  it('rejects construction without the required callback', () => {
    const ObserverWithoutCallback = IntersectionObserver as unknown as new () => IntersectionObserver;

    expect(() => new ObserverWithoutCallback()).toThrow(TypeError);
    expect(() => new IntersectionObserver(() => {})).not.toThrow();
  });
});
