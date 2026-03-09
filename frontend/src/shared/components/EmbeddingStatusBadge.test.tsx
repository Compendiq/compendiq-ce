import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EmbeddingStatusBadge } from './EmbeddingStatusBadge';

describe('EmbeddingStatusBadge', () => {
  it('renders "Pending" when embeddingDirty is true', () => {
    render(<EmbeddingStatusBadge embeddingDirty={true} />);
    expect(screen.getByText('Pending')).toBeInTheDocument();
  });

  it('renders "Embedded" when embeddingDirty is false', () => {
    render(<EmbeddingStatusBadge embeddingDirty={false} />);
    expect(screen.getByText('Embedded')).toBeInTheDocument();
  });

  it('applies yellow color classes for pending state', () => {
    render(<EmbeddingStatusBadge embeddingDirty={true} />);
    const badge = screen.getByText('Pending');
    expect(badge.className).toContain('text-yellow-400');
    expect(badge.className).toContain('bg-yellow-400/15');
  });

  it('applies green color classes for embedded state', () => {
    render(<EmbeddingStatusBadge embeddingDirty={false} />);
    const badge = screen.getByText('Embedded');
    expect(badge.className).toContain('text-emerald-400');
    expect(badge.className).toContain('bg-emerald-400/15');
  });

  it('shows tooltip for pending state', () => {
    render(<EmbeddingStatusBadge embeddingDirty={true} />);
    const badge = screen.getByText('Pending');
    expect(badge.getAttribute('title')).toContain('Needs embedding');
  });

  it('shows tooltip for embedded state', () => {
    render(<EmbeddingStatusBadge embeddingDirty={false} />);
    const badge = screen.getByText('Embedded');
    expect(badge.getAttribute('title')).toContain('indexed for AI search');
  });

  it('applies custom className', () => {
    render(<EmbeddingStatusBadge embeddingDirty={false} className="custom-class" />);
    const badge = screen.getByText('Embedded');
    expect(badge.className).toContain('custom-class');
  });
});
