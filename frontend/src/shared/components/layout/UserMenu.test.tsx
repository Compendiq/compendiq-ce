import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { UserMenu } from './UserMenu';

const mockLogoutApi = vi.fn().mockResolvedValue(undefined);
const mockApiFetch = vi.fn();
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

vi.mock('../../lib/api', () => ({
  logoutApi: (...args: unknown[]) => mockLogoutApi(...args),
  // #1402: "Getting Started Guide" reopens the checklist through
  // `PUT /settings`. Network boundary only.
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function renderUserMenu() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <UserMenu />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('UserMenu', () => {
  beforeEach(() => {
    mockLogoutApi.mockClear();
    mockApiFetch.mockReset();
    mockApiFetch.mockResolvedValue({});
    mockNavigate.mockClear();
    mockOpenShortcuts.mockClear();
    // Default to a non-admin signed-in user; admin tests opt in.
    mockUser = { username: 'testuser' };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders an avatar-only trigger named for the signed-in user', () => {
    renderUserMenu();
    expect(screen.getByText('T')).toBeInTheDocument();
    const trigger = screen.getByRole('button', { name: 'testuser menu' });
    expect(trigger).toBeInTheDocument();
    // Username lives in the menu, not beside the avatar.
    expect(trigger).not.toHaveTextContent('testuser');
  });

  it('renders a trigger button with menu role', () => {
    renderUserMenu();
    const trigger = screen.getByRole('button', { name: 'testuser menu' });
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


  /**
   * #1402: the checklist is dismissible, so it needs a way back. The User Menu
   * is where "Keyboard Shortcuts" already lives, and it is the only always-
   * available surface on every route.
   */
  describe('Getting Started Guide', () => {
    async function openMenu() {
      renderUserMenu();
      const trigger = screen.getByRole('button', { name: 'testuser menu' });
      fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' });
      await vi.waitFor(() => expect(trigger).toHaveAttribute('data-state', 'open'));
    }

    it('offers the item between Keyboard Shortcuts and Sign out', async () => {
      await openMenu();
      const labels = screen.getAllByRole('menuitem').map((item) => item.textContent?.trim());
      expect(labels).toContain('Getting Started Guide');
      expect(labels.indexOf('Getting Started Guide')).toBeGreaterThan(
        labels.findIndex((l) => l?.startsWith('Keyboard Shortcuts')),
      );
      expect(labels.indexOf('Getting Started Guide')).toBeLessThan(labels.indexOf('Sign out'));
    });

    it('reopens the checklist and takes the user to the overview it lives on', async () => {
      await openMenu();
      fireEvent.click(screen.getByText('Getting Started Guide'));

      await waitFor(() =>
        expect(mockApiFetch).toHaveBeenCalledWith('/settings', {
          method: 'PUT',
          body: JSON.stringify({ onboardingState: { dismissed: false } }),
        }),
      );
      expect(mockNavigate).toHaveBeenCalledWith('/');
    });
  });

  it('asks before signing out, and only then calls logoutApi', async () => {
    renderUserMenu();
    const trigger = screen.getByRole('button');
    fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' });

    await vi.waitFor(() => {
      expect(trigger).toHaveAttribute('data-state', 'open');
    });

    fireEvent.click(screen.getByText('Sign out'));
    expect(mockLogoutApi).not.toHaveBeenCalled();

    const dialog = await screen.findByTestId('confirm-dialog');
    expect(dialog).toHaveTextContent('Sign out?');
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));

    await vi.waitFor(() => {
      expect(mockLogoutApi).toHaveBeenCalled();
    });
  });

  it('does not sign out when the confirm is cancelled', async () => {
    renderUserMenu();
    const trigger = screen.getByRole('button');
    fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' });
    await vi.waitFor(() => {
      expect(trigger).toHaveAttribute('data-state', 'open');
    });
    fireEvent.click(screen.getByText('Sign out'));
    await screen.findByTestId('confirm-dialog');
    fireEvent.click(screen.getByTestId('confirm-dialog-cancel'));
    expect(mockLogoutApi).not.toHaveBeenCalled();
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

  // Radix applies data-[highlighted] to the roving-focus menu item during
  // keyboard navigation. With only hover:* styles and outline-none, keyboard
  // users get no visible highlight (issue #962). Assert every menu item carries
  // a data-[highlighted] style so the focused item is always visible.
  it('every menu item has a data-[highlighted] style for keyboard focus visibility', async () => {
    mockUser = { username: 'adminuser', role: 'admin' };
    renderUserMenu();
    const trigger = screen.getByRole('button');
    fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' });

    await vi.waitFor(() => {
      expect(trigger).toHaveAttribute('data-state', 'open');
    });

    const items = screen.getAllByRole('menuitem');
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.className).toMatch(/data-\[highlighted\]:/);
    }
  });

  // Identity, not an action: Steel is reserved for actions. Neutral chip, never
  // amber (AI) and never the filled accent.
  it('user avatar is a neutral chip, not an accent or amber mark', () => {
    mockUser = { username: 'simon', role: 'user' };
    renderUserMenu();
    const avatar = screen.getByTestId('user-avatar-initial');
    expect(avatar.className).not.toMatch(/text-primary|bg-primary/);
    expect(avatar.className).not.toMatch(/bg-action|text-action/);
    expect(avatar.className).toMatch(/bg-muted/);
    expect(avatar.className).toMatch(/text-foreground/);
  });
});
