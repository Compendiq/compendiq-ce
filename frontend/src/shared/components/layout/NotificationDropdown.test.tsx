import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NotificationDropdown, type Notification } from './NotificationDropdown';

// Mock framer-motion
vi.mock('framer-motion', () => ({
  m: {
    button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
  },
}));

const now = new Date();
const yesterday = new Date(now);
yesterday.setDate(yesterday.getDate() - 1);
const older = new Date(now);
older.setDate(older.getDate() - 5);

const mockNotifications: Notification[] = [
  {
    id: 'n-1',
    type: 'comment',
    title: 'New comment on "API Guide"',
    body: 'Alice left a comment on your page',
    read: false,
    link: '/pages/p-1',
    createdAt: now.toISOString(),
  },
  {
    id: 'n-2',
    type: 'mention',
    title: 'You were mentioned',
    body: 'Bob mentioned you in a comment',
    read: true,
    link: '/pages/p-2',
    createdAt: yesterday.toISOString(),
  },
  {
    id: 'n-3',
    type: 'sync_complete',
    title: 'Sync completed',
    body: '25 pages updated from Confluence',
    read: true,
    createdAt: older.toISOString(),
  },
];

describe('NotificationDropdown', () => {
  it('renders empty state when no notifications', () => {
    render(
      <NotificationDropdown
        notifications={[]}
        onClickNotification={vi.fn()}
        onMarkAllRead={vi.fn()}
      />,
    );
    expect(screen.getByTestId('notification-empty')).toBeInTheDocument();
    expect(screen.getByText('All caught up!')).toBeInTheDocument();
  });

  it('renders notification items', () => {
    render(
      <NotificationDropdown
        notifications={mockNotifications}
        onClickNotification={vi.fn()}
        onMarkAllRead={vi.fn()}
      />,
    );
    expect(screen.getByTestId('notification-item-n-1')).toBeInTheDocument();
    expect(screen.getByTestId('notification-item-n-2')).toBeInTheDocument();
    expect(screen.getByTestId('notification-item-n-3')).toBeInTheDocument();
  });

  it('renders notification titles and bodies', () => {
    render(
      <NotificationDropdown
        notifications={mockNotifications}
        onClickNotification={vi.fn()}
        onMarkAllRead={vi.fn()}
      />,
    );
    expect(screen.getByText('New comment on "API Guide"')).toBeInTheDocument();
    expect(screen.getByText('Alice left a comment on your page')).toBeInTheDocument();
  });

  it('groups notifications by date', () => {
    render(
      <NotificationDropdown
        notifications={mockNotifications}
        onClickNotification={vi.fn()}
        onMarkAllRead={vi.fn()}
      />,
    );
    expect(screen.getByText('Today')).toBeInTheDocument();
    expect(screen.getByText('Yesterday')).toBeInTheDocument();
    expect(screen.getByText('Older')).toBeInTheDocument();
  });

  it('shows mark all as read button when there are unread notifications', () => {
    render(
      <NotificationDropdown
        notifications={mockNotifications}
        onClickNotification={vi.fn()}
        onMarkAllRead={vi.fn()}
      />,
    );
    expect(screen.getByTestId('mark-all-read')).toBeInTheDocument();
  });

  it('does not show mark all as read when all are read', () => {
    const allRead = mockNotifications.map((n) => ({ ...n, read: true }));
    render(
      <NotificationDropdown
        notifications={allRead}
        onClickNotification={vi.fn()}
        onMarkAllRead={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('mark-all-read')).not.toBeInTheDocument();
  });

  it('calls onMarkAllRead when button is clicked', () => {
    const onMarkAllRead = vi.fn();
    render(
      <NotificationDropdown
        notifications={mockNotifications}
        onClickNotification={vi.fn()}
        onMarkAllRead={onMarkAllRead}
      />,
    );
    fireEvent.click(screen.getByTestId('mark-all-read'));
    expect(onMarkAllRead).toHaveBeenCalledOnce();
  });

  it('calls onClickNotification when a notification is clicked', () => {
    const onClick = vi.fn();
    render(
      <NotificationDropdown
        notifications={mockNotifications}
        onClickNotification={onClick}
        onMarkAllRead={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('notification-item-n-1'));
    expect(onClick).toHaveBeenCalledWith(mockNotifications[0]);
  });

  it('shows unread indicator dot for unread notifications', () => {
    render(
      <NotificationDropdown
        notifications={mockNotifications}
        onClickNotification={vi.fn()}
        onMarkAllRead={vi.fn()}
      />,
    );
    // n-1 is unread, it should have the bold font
    const unreadTitle = screen.getByText('New comment on "API Guide"');
    expect(unreadTitle).toHaveClass('font-medium');
  });
});
