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

  // Some input environments (software KVMs, remote/streamed desktop sessions,
  // certain mouse/trackpad drivers) deliver a legacy `click` but never a
  // `pointerdown`. Radix's trigger opens ONLY on pointerdown, so the menu was
  // unreachable by mouse for those users even though every plain onClick button
  // still worked. The trigger must therefore also open on a plain click.
  it('opens the dropdown on a plain click when no pointerdown precedes it', async () => {
    renderUserMenu();
    const trigger = screen.getByRole('button');
    fireEvent.click(trigger);
    await vi.waitFor(() => {
      expect(trigger).toHaveAttribute('data-state', 'open');
    });
  });

  // Guard the normal-input path: when both pointerdown and the compatibility
  // click fire for the same press, the click must NOT toggle the menu closed
  // again (which a naive onClick-toggle would do).
  it('stays open when pointerdown is immediately followed by a click (normal input)', async () => {
    renderUserMenu();
    const trigger = screen.getByRole('button');
    fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' });
    fireEvent.click(trigger);
    await vi.waitFor(() => {
      expect(trigger).toHaveAttribute('data-state', 'open');
    });
    expect(trigger).toHaveAttribute('data-state', 'open');
  });

  // With the click-to-open fallback, the menu can be opened by input that never
  // emits `pointerdown`. Radix's built-in dismiss is ALSO pointerdown-based
  // (onPointerDownOutside), so those users can't dismiss by clicking away. The
  // menu must therefore also close on a plain outside click (Escape already
  // works via keydown).
  it('closes on a plain outside click when no pointerdown fires', async () => {
    renderUserMenu();
    const trigger = screen.getByRole('button');
    fireEvent.click(trigger);
    await vi.waitFor(() => {
      expect(trigger).toHaveAttribute('data-state', 'open');
    });
    fireEvent.click(document.body);
    await vi.waitFor(() => {
      expect(trigger).toHaveAttribute('data-state', 'closed');
    });
  });

  // A click INSIDE the open menu must not be treated as "outside" and dismiss it
  // prematurely — item selection handles closing on its own.
  it('does not dismiss when the click lands inside the menu', async () => {
    renderUserMenu();
    const trigger = screen.getByRole('button');
    fireEvent.click(trigger);
    await vi.waitFor(() => {
      expect(screen.getByText('Single-key shortcuts')).toBeInTheDocument();
    });
    // The single-key toggle calls preventDefault to keep the menu open.
    fireEvent.click(screen.getByText('Single-key shortcuts'));
    expect(trigger).toHaveAttribute('data-state', 'open');
  });

  // Keyboard must still open the menu with the controlled open state. Radix opens
  // on Enter/Space keydown and preventDefaults it, which suppresses the button's
  // synthesized click in real browsers, so the click-to-open fallback never fires
  // for keyboard users. (jsdom does not synthesize that click, so this guards the
  // controlled wiring; the no-double-toggle behavior was verified in a browser.)
  it('opens the dropdown on Enter keydown (keyboard)', async () => {
    renderUserMenu();
    const trigger = screen.getByRole('button');
    fireEvent.keyDown(trigger, { key: 'Enter' });
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

  // Task 5 — avatar initial bubble is brand chrome (not an AI affordance), so
  // it must route to ink-action and not amber. The Playwright contrast spec in
  // Task 6 will catch the colour combo at run-time; this guards the contract
  // at the unit level so a future regression can't quietly re-amber it.
  it('user avatar uses ink-action, not amber (avatar is brand chrome, not AI)', () => {
    mockUser = { username: 'simon', role: 'user' };
    renderUserMenu();
    const avatar = screen.getByTestId('user-avatar-initial');
    expect(avatar.className).not.toMatch(/text-primary|bg-primary/);
    expect(avatar.className).toMatch(/bg-action/);
    expect(avatar.className).toMatch(/text-action-foreground/);
  });
});
