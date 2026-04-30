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

// Mutable across tests so we can flip role between non-admin and admin.
let mockUser: { username: string; role?: 'user' | 'admin' } | null = {
  username: 'testuser',
};
vi.mock('../../../stores/auth-store', () => ({
  useAuthStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      user: mockUser,
    }),
}));

const mockOpenShortcuts = vi.fn();
vi.mock('../../../stores/keyboard-shortcuts-store', () => ({
  useKeyboardShortcutsStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      open: mockOpenShortcuts,
    }),
}));

const mockSetSingleKeyShortcutsEnabled = vi.fn();
let mockSingleKeyShortcutsEnabled = true;
vi.mock('../../../stores/ui-store', () => ({
  useUiStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      singleKeyShortcutsEnabled: mockSingleKeyShortcutsEnabled,
      setSingleKeyShortcutsEnabled: mockSetSingleKeyShortcutsEnabled,
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
    mockSetSingleKeyShortcutsEnabled.mockClear();
    mockSingleKeyShortcutsEnabled = true;
    // Default to a non-admin signed-in user; admin tests opt in.
    mockUser = { username: 'testuser' };
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

  it('shows single-key shortcuts toggle in dropdown', async () => {
    renderUserMenu();
    const trigger = screen.getByRole('button');
    fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' });
    await vi.waitFor(() => {
      expect(screen.getByText('Single-key shortcuts')).toBeInTheDocument();
    });
  });

  it('renders single-key toggle as a switch element', async () => {
    renderUserMenu();
    const trigger = screen.getByRole('button');
    fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' });
    await vi.waitFor(() => {
      expect(screen.getByRole('switch', { name: /single-key shortcuts/i })).toBeInTheDocument();
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

  // /admin/analytics is mounted at App.tsx:165 but no UI links to it.
  // The admin-only Analytics item in this menu is the discoverability fix —
  // these tests pin the gating so a future refactor doesn't regress it back
  // to URL-only access.
  it('does NOT show the Analytics item for a non-admin user', async () => {
    mockUser = { username: 'testuser', role: 'user' };
    renderUserMenu();
    const trigger = screen.getByRole('button');
    fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' });

    await vi.waitFor(() => {
      expect(trigger).toHaveAttribute('data-state', 'open');
    });
    // Settings is always visible — pin that the menu is fully open.
    expect(screen.getByText('Settings')).toBeInTheDocument();
    expect(screen.queryByText('Analytics')).not.toBeInTheDocument();
  });

  it('shows the Analytics item for an admin user', async () => {
    mockUser = { username: 'adminuser', role: 'admin' };
    renderUserMenu();
    const trigger = screen.getByRole('button');
    fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' });

    await vi.waitFor(() => {
      expect(screen.getByText('Analytics')).toBeInTheDocument();
    });
  });

  it('navigates to /admin/analytics when Analytics is selected by an admin', async () => {
    mockUser = { username: 'adminuser', role: 'admin' };
    renderUserMenu();
    const trigger = screen.getByRole('button');
    fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' });

    await vi.waitFor(() => {
      expect(trigger).toHaveAttribute('data-state', 'open');
    });

    fireEvent.click(screen.getByText('Analytics'));
    await vi.waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/admin/analytics');
    });
  });
});
