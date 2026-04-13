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
    const trigger = screen.getByTestId('notification-bell');
    fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' });
    await vi.waitFor(() => {
      expect(screen.getByText('Notifications')).toBeInTheDocument();
    });
  });

  it('has correct aria-label', () => {
    renderBell();
    expect(screen.getByTestId('notification-bell')).toHaveAttribute('aria-label', 'Notifications');
  });
});
