import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { SkillsIcon } from './SkillsIcon';

describe('SkillsIcon', () => {
  it('renders SVG with default props', () => {
    const { container } = render(<SkillsIcon />);
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
    expect(svg?.getAttribute('width')).toBe('16');
    expect(svg?.getAttribute('height')).toBe('16');
    expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
  });

  it('accepts custom size and className', () => {
    const { container } = render(<SkillsIcon size={24} className="custom-icon" />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('width')).toBe('24');
    expect(svg?.getAttribute('height')).toBe('24');
    expect(svg?.getAttribute('class')).toContain('custom-icon');
  });
});
