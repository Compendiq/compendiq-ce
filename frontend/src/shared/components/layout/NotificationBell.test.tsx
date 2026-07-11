import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NotificationBell } from './NotificationBell';
import type { Notification } from './NotificationDropdown';

// Mock framer-motion
vi.mock('framer-motion', () => ({
  m: {
    button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
  },
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

const mockNotifications: Notification[] = [
  {
    id: 'n-1',
    type: 'comment',
    title: 'New comment',
    body: 'Someone commented',
    read: false,
    link: '/pages/p-1',
    createdAt: new Date().toISOString(),
  },
  {
    id: 'n-2',
    type: 'mention',
    title: 'Mention',
    body: 'You were mentioned',
    read: true,
    createdAt: new Date().toISOString(),
  },
];

let mockApiFetch: ReturnType<typeof vi.fn>;

vi.mock('../../lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

function renderBell() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <NotificationBell />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// Opens the notification panel. Fires both pointerDown and click so it works
// regardless of the underlying Radix primitive (a menu opens on pointerDown, a
// popover opens on click) — the switch from DropdownMenu to Popover is the fix.
function openPanel() {
  const trigger = screen.getByTestId('notification-bell');
  fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' });
  fireEvent.click(trigger);
}

describe('NotificationBell', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockApiFetch = vi.fn().mockResolvedValue(mockNotifications);
  });

  it('renders the bell button', () => {
    renderBell();
    expect(screen.getByTestId('notification-bell')).toBeInTheDocument();
  });

  it('shows unread count badge', async () => {
    renderBell();
    await vi.waitFor(() => {
      expect(screen.getByTestId('notification-badge')).toHaveTextContent('1');
    });
  });

  it('does not show badge when no unread notifications', async () => {
    mockApiFetch = vi.fn().mockResolvedValue(
      mockNotifications.map((n) => ({ ...n, read: true })),
    );
    renderBell();
    // Wait for query to settle, then check badge absence
    await vi.waitFor(() => {
      expect(screen.queryByTestId('notification-badge')).not.toBeInTheDocument();
    });
  });

  it('opens dropdown on pointer interaction', async () => {
    renderBell();
    openPanel();
    await vi.waitFor(() => {
      expect(screen.getByText('Notifications')).toBeInTheDocument();
    });
  });

  it('has correct aria-label', () => {
    renderBell();
    expect(screen.getByTestId('notification-bell')).toHaveAttribute('aria-label', 'Notifications');
  });

  // Regression for #879: the panel must not be a WAI-ARIA menu. Radix
  // DropdownMenu.Content (role="menu") restricts keyboard focus to registered
  // DropdownMenu.Items via a roving-focus collection and preventDefaults Tab,
  // so the plain-button notification items and "Mark all as read" control were
  // unreachable by keyboard (WCAG 2.1.1 failure). A Popover imposes no such
  // trap: every inner button is an ordinary, focusable control.
  it('exposes notification actions as keyboard-reachable buttons, not a role="menu" trap', async () => {
    renderBell();
    openPanel();

    // Panel content renders once the notifications query resolves.
    const firstItem = await screen.findByTestId('notification-item-n-1');

    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.querySelector('[role="menuitem"]')).toBeNull();

    // Each action control is an ordinary focusable button.
    firstItem.focus();
    expect(document.activeElement).toBe(firstItem);

    const markAll = screen.getByTestId('mark-all-read');
    markAll.focus();
    expect(document.activeElement).toBe(markAll);

    const settings = screen.getByTestId('notification-settings');
    settings.focus();
    expect(document.activeElement).toBe(settings);
  });

  it('navigates and dismisses the panel when a notification is clicked', async () => {
    renderBell();
    openPanel();

    const item = await screen.findByTestId('notification-item-n-1');
    fireEvent.click(item);

    expect(mockNavigate).toHaveBeenCalledWith('/pages/p-1');

    // Unlike DropdownMenu.Items, plain buttons inside a Popover do not
    // auto-dismiss, so the component must close the panel explicitly.
    await vi.waitFor(() => {
      expect(screen.queryByText('Notifications')).not.toBeInTheDocument();
    });
  });
});
