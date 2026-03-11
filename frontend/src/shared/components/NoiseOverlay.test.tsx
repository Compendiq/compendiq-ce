import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NoiseOverlay } from './NoiseOverlay';
import { useUiStore } from '../../stores/ui-store';

describe('NoiseOverlay', () => {
  beforeEach(() => {
    useUiStore.setState({ reduceEffects: false });
  });

  it('renders the noise overlay when effects are enabled', () => {
    render(<NoiseOverlay />);
    expect(screen.getByTestId('noise-overlay')).toBeInTheDocument();
  });

  it('contains an SVG with feTurbulence filter', () => {
    render(<NoiseOverlay />);
    const overlay = screen.getByTestId('noise-overlay');
    const svg = overlay.querySelector('svg');
    expect(svg).toBeTruthy();
    const turbulence = overlay.querySelector('feTurbulence');
    expect(turbulence).toBeTruthy();
  });

  it('is hidden from accessibility tree', () => {
    render(<NoiseOverlay />);
    const el = screen.getByTestId('noise-overlay');
    expect(el.getAttribute('aria-hidden')).toBe('true');
  });

  it('does not intercept pointer events', () => {
    render(<NoiseOverlay />);
    const el = screen.getByTestId('noise-overlay');
    expect(el.className).toContain('pointer-events-none');
  });

  it('has low opacity (0.15) for subtlety', () => {
    render(<NoiseOverlay />);
    const el = screen.getByTestId('noise-overlay');
    expect(el.className).toContain('opacity-15');
  });

  it('renders nothing when reduceEffects is true', () => {
    useUiStore.setState({ reduceEffects: true });
    render(<NoiseOverlay />);
    expect(screen.queryByTestId('noise-overlay')).not.toBeInTheDocument();
  });
});
