import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AiPolicyChip, LocalityChip, WorkerStatusBadge } from './AiPolicyChips';

describe('AiPolicyChip', () => {
  it.each([
    ['all', /all ai allowed/i],
    ['local_only', /local ai only/i],
    ['none', /no ai allowed/i],
  ] as const)('renders %s as words plus a glyph', (policy, label) => {
    render(<AiPolicyChip policy={policy} />);
    const chip = screen.getByTestId('ai-policy-chip');
    expect(chip).toHaveTextContent(label);
    expect(chip.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  });

  it('compact header form keeps an accessible name without a second tab stop', () => {
    render(<AiPolicyChip policy="none" compact />);
    const chip = screen.getByTestId('ai-policy-chip-compact');
    expect(chip).toHaveTextContent(/no ai allowed/i);
    expect(chip.querySelector('svg')).not.toBeNull();
    expect(chip).not.toHaveAttribute('tabindex');
  });

  /** ADR-010: a category is neither a Steel control nor a status hue. */
  it('wears neither the Steel accent nor a status hue', () => {
    render(<AiPolicyChip policy="local_only" />);
    expect(screen.getByTestId('ai-policy-chip').className).not.toMatch(/primary|success|warning|amber|destructive|status-/);
  });
});

describe('LocalityChip', () => {
  it('never says verified', () => {
    const { rerender } = render(<LocalityChip locality="local" />);
    const chip = screen.getByTestId('locality-chip');
    expect(chip).toHaveTextContent(/declared local/i);
    expect(chip.textContent).not.toMatch(/verified|secure/i);
    expect(chip.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    rerender(<LocalityChip locality={null} />);
    expect(screen.getByTestId('locality-chip')).toHaveTextContent(/not declared/i);
  });
});

describe('WorkerStatusBadge', () => {
  it('renders policy_blocked distinctly from success and failure', () => {
    const { rerender } = render(<WorkerStatusBadge status="policy_blocked" reason="policy_none" />);
    expect(screen.getByTestId('worker-status-badge')).toHaveAttribute('data-tone', 'policy');
    rerender(<WorkerStatusBadge status="completed" />);
    expect(screen.getByTestId('worker-status-badge')).toHaveAttribute('data-tone', 'success');
    rerender(<WorkerStatusBadge status="failed" />);
    expect(screen.getByTestId('worker-status-badge')).toHaveAttribute('data-tone', 'failure');
    rerender(<WorkerStatusBadge status="recovering" />);
    expect(screen.getByTestId('worker-status-badge')).toHaveAttribute('data-tone', 'recovering');
  });

  it('exposes the block reason as visible text wired by aria-describedby, not a title alone', () => {
    render(<WorkerStatusBadge status="policy_blocked" reason="provider_not_local" id="embed" />);
    const badge = screen.getByTestId('worker-status-badge');
    const reason = screen.getByTestId('worker-status-reason');
    expect(reason).toHaveTextContent(/not declared local/i);
    expect(badge).toHaveAttribute('aria-describedby', reason.id);
    expect(badge).not.toHaveAttribute('title');
  });

  it('renders no reason for a non-policy status', () => {
    render(<WorkerStatusBadge status="completed" reason="policy_none" />);
    expect(screen.queryByTestId('worker-status-reason')).toBeNull();
  });
});
