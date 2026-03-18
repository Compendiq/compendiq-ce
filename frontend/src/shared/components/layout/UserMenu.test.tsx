import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { UserMenu } from './UserMenu';

const mockLogoutApi = vi.fn().mockResolvedValue(undefined);
const mockNavigate = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock('../../../stores/auth-store', () => ({
  useAuthStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      user: { username: 'testuser' },
    }),
}));

const mockOpenShortcuts = vi.fn();
vi.mock('../../../stores/keyboard-shortcuts-store', () => ({
  useKeyboardShortcutsStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      open: mockOpenShortcuts,
    }),
}));

vi.mock('../../lib/api', () => ({
  logoutApi: (...args: unknown[]) => mockLogoutApi(...args),
}));

function renderUserMenu() {
  return render(
    <MemoryRouter>
      <UserMenu />
    </MemoryRouter>,
  );
}

describe('UserMenu', () => {
  beforeEach(() => {
    mockLogoutApi.mockClear();
    mockNavigate.mockClear();
    mockOpenShortcuts.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the user avatar and username', () => {
    renderUserMenu();
    expect(screen.getByText('T')).toBeInTheDocument();
    expect(screen.getByText('testuser')).toBeInTheDocument();
  });

  it('renders a trigger button with menu role', () => {
    renderUserMenu();
    const trigger = screen.getByRole('button');
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
  });

  it('trigger starts in closed state', () => {
    renderUserMenu();
    const trigger = screen.getByRole('button');
    expect(trigger).toHaveAttribute('data-state', 'closed');
  });

  it('opens dropdown on pointer interaction', async () => {
    renderUserMenu();
    const trigger = screen.getByRole('button');
    fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' });
    await vi.waitFor(() => {
      expect(trigger).toHaveAttribute('data-state', 'open');
    });
  });

  it('shows Settings item in dropdown', async () => {
    renderUserMenu();
    const trigger = screen.getByRole('button');
    fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' });
    await vi.waitFor(() => {
      expect(screen.getByText('Settings')).toBeInTheDocument();
    });
  });

  it('navigates to /settings when Settings is selected', async () => {
    renderUserMenu();
    const trigger = screen.getByRole('button');
    fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' });
    await vi.waitFor(() => {
      expect(trigger).toHaveAttribute('data-state', 'open');
    });

    fireEvent.click(screen.getByText('Settings'));
    await vi.waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/settings');
    });
  });

  it('shows Keyboard Shortcuts item in dropdown', async () => {
    renderUserMenu();
    const trigger = screen.getByRole('button');
    fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' });
    await vi.waitFor(() => {
      expect(screen.getByText('Keyboard Shortcuts')).toBeInTheDocument();
    });
  });

  it('opens keyboard shortcuts modal when Keyboard Shortcuts is selected', async () => {
    renderUserMenu();
    const trigger = screen.getByRole('button');
    fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' });
    await vi.waitFor(() => {
      expect(trigger).toHaveAttribute('data-state', 'open');
    });

    fireEvent.click(screen.getByText('Keyboard Shortcuts'));
    await vi.waitFor(() => {
      expect(mockOpenShortcuts).toHaveBeenCalled();
    });
  });

  it('calls logoutApi when Sign out is selected', async () => {
    renderUserMenu();
    const trigger = screen.getByRole('button');
    fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' });

    await vi.waitFor(() => {
      expect(trigger).toHaveAttribute('data-state', 'open');
    });

    const signOut = screen.getByText('Sign out');
    fireEvent.click(signOut);

    await vi.waitFor(() => {
      expect(mockLogoutApi).toHaveBeenCalled();
    });
  });
});
