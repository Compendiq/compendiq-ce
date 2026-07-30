import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VisionBadge } from './VisionBadge';

describe('VisionBadge', () => {
  it('labels a vision-capable model', () => {
    render(<VisionBadge vision={true} />);
    expect(screen.getByTestId('vision-badge')).toHaveTextContent(/vision/i);
  });

  it('labels a text-only model', () => {
    render(<VisionBadge vision={false} />);
    expect(screen.getByTestId('vision-badge')).toHaveTextContent(/text.only/i);
  });

  it('labels an unconfirmed model distinctly from a text-only one', () => {
    render(<VisionBadge vision={null} />);
    const badge = screen.getByTestId('vision-badge');
    expect(badge).toHaveTextContent(/unconfirmed|checking/i);
    expect(badge).not.toHaveTextContent(/text.only/i);
  });

  it('carries an explanatory title, since the app has no Tooltip primitive', () => {
    render(<VisionBadge vision={null} />);
    expect(screen.getByTestId('vision-badge')).toHaveAttribute('title', expect.any(String));
  });

  /** ADR-010: amber is reserved for warning/attention. A verdict is not a warning. */
  it('does not use the amber warning colour', () => {
    render(<VisionBadge vision={false} />);
    expect(screen.getByTestId('vision-badge').className).not.toMatch(/warning|amber/);
  });
});
