import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CompendiqLogo } from './CompendiqLogo';

describe('CompendiqLogo', () => {
  it('renders an SVG with role="img" and accessible name', () => {
    render(<CompendiqLogo />);
    const svg = screen.getByRole('img', { name: 'Compendiq' });
    expect(svg).toBeInTheDocument();
    expect(svg.tagName.toLowerCase()).toBe('svg');
  });

  it('defaults to 24px size', () => {
    render(<CompendiqLogo />);
    const svg = screen.getByRole('img', { name: 'Compendiq' });
    expect(svg.getAttribute('width')).toBe('24');
    expect(svg.getAttribute('height')).toBe('24');
  });

  it('respects custom size prop', () => {
    render(<CompendiqLogo size={64} />);
    const svg = screen.getByRole('img', { name: 'Compendiq' });
    expect(svg.getAttribute('width')).toBe('64');
    expect(svg.getAttribute('height')).toBe('64');
  });

  it('passes className through to SVG element', () => {
    render(<CompendiqLogo className="text-primary" />);
    const svg = screen.getByRole('img', { name: 'Compendiq' });
    expect(svg.classList.contains('text-primary')).toBe(true);
  });

  it('renders 7 node circles plus glow and specular (9 circles total)', () => {
    const { container } = render(<CompendiqLogo />);
    const circles = container.querySelectorAll('circle');
    // 7 nodes + 1 glow behind center + 1 specular highlight = 9
    expect(circles.length).toBe(9);
  });

  it('renders 6 radial connection lines', () => {
    const { container } = render(<CompendiqLogo />);
    const lines = container.querySelectorAll('line');
    expect(lines.length).toBe(6);
  });

  it('includes CSS animation when animated prop is true', () => {
    const { container } = render(<CompendiqLogo animated />);
    const style = container.querySelector('style');
    expect(style).not.toBeNull();
    expect(style!.textContent).toContain('am-pulse');
    // Glow circle should have animation class
    const glowCircle = container.querySelector('.am-glow');
    expect(glowCircle).not.toBeNull();
  });

  it('omits CSS animation when animated prop is false', () => {
    const { container } = render(<CompendiqLogo />);
    expect(container.querySelector('style')).toBeNull();
    expect(container.querySelector('.am-glow')).toBeNull();
  });

  it('includes prefers-reduced-motion media query in animation', () => {
    const { container } = render(<CompendiqLogo animated />);
    const style = container.querySelector('style');
    expect(style!.textContent).toContain('prefers-reduced-motion');
  });
});
