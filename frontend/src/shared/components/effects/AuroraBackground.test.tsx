import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AuroraBackground } from './AuroraBackground';
import { useUiStore } from '../../../stores/ui-store';

describe('AuroraBackground', () => {
  beforeEach(() => {
    // Reset store to default (reduceEffects = false in test env since
    // matchMedia is not available)
    useUiStore.setState({ reduceEffects: false });
  });

  it('renders the aurora background container', () => {
    render(<AuroraBackground />);
    expect(screen.getByTestId('aurora-background')).toBeInTheDocument();
  });

  it('renders three aurora blobs when effects are enabled', () => {
    render(<AuroraBackground />);
    const container = screen.getByTestId('aurora-background');
    expect(container.querySelector('.aurora-blob-indigo')).toBeTruthy();
    expect(container.querySelector('.aurora-blob-cyan')).toBeTruthy();
    expect(container.querySelector('.aurora-blob-rose')).toBeTruthy();
  });

  it('is hidden from accessibility tree', () => {
    render(<AuroraBackground />);
    const el = screen.getByTestId('aurora-background');
    expect(el.getAttribute('aria-hidden')).toBe('true');
  });

  it('does not intercept pointer events', () => {
    render(<AuroraBackground />);
    const el = screen.getByTestId('aurora-background');
    expect(el.className).toContain('pointer-events-none');
  });

  it('renders static mesh-gradient fallback when reduceEffects is true', () => {
    useUiStore.setState({ reduceEffects: true });
    render(<AuroraBackground />);
    const el = screen.getByTestId('aurora-background');
    expect(el.className).toContain('mesh-gradient');
    // Should NOT have animated blobs
    expect(el.querySelector('.aurora-blob-indigo')).toBeNull();
    expect(el.querySelector('.aurora-blob-cyan')).toBeNull();
    expect(el.querySelector('.aurora-blob-rose')).toBeNull();
  });
});
