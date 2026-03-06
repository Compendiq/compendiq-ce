import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { UserMenu } from './UserMenu';

const mockClearAuth = vi.fn();

vi.mock('../../stores/auth-store', () => ({
  useAuthStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      user: { username: 'testuser' },
      clearAuth: mockClearAuth,
    }),
}));

describe('UserMenu', () => {
  beforeEach(() => {
    mockClearAuth.mockClear();
  });

  it('renders the user avatar and username', () => {
    render(<UserMenu />);
    expect(screen.getByText('T')).toBeInTheDocument();
    expect(screen.getByText('testuser')).toBeInTheDocument();
  });

  it('renders a trigger button with menu role', () => {
    render(<UserMenu />);
    const trigger = screen.getByRole('button');
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
  });

  it('trigger starts in closed state', () => {
    render(<UserMenu />);
    const trigger = screen.getByRole('button');
    expect(trigger).toHaveAttribute('data-state', 'closed');
  });

  it('opens dropdown on pointer interaction', async () => {
    render(<UserMenu />);
    const trigger = screen.getByRole('button');
    fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' });
    // Radix opens async on pointer events
    await vi.waitFor(() => {
      expect(trigger).toHaveAttribute('data-state', 'open');
    });
  });
});
