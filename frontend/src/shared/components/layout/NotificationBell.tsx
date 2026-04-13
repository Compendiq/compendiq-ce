import { useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Bell, Settings } from 'lucide-react';
import { apiFetch } from '../../lib/api';
import { NotificationDropdown, type Notification } from './NotificationDropdown';
import { cn } from '../../lib/cn';

function useNotifications() {
  return useQuery<Notification[]>({
    queryKey: ['notifications'],
    queryFn: () => apiFetch('/notifications'),
    refetchInterval: 60_000, // poll every 60s
    refetchOnWindowFocus: true,
  });
}

function useMarkNotificationRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (notificationId: string) =>
      apiFetch(`/notifications/${notificationId}/read`, { method: 'PUT' }),
    onMutate: async (notificationId) => {
      await queryClient.cancelQueries({ queryKey: ['notifications'] });
      const previous = queryClient.getQueryData<Notification[]>(['notifications']);
      queryClient.setQueryData<Notification[]>(['notifications'], (old) =>
        old?.map((n) => (n.id === notificationId ? { ...n, read: true } : n)),
      );
      return { previous };
    },
    onError: (_err, _id, context) => {
      if (context?.previous) {
        queryClient.setQueryData(['notifications'], context.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}

function useMarkAllRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch('/notifications/read-all', { method: 'PUT' }),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ['notifications'] });
      const previous = queryClient.getQueryData<Notification[]>(['notifications']);
      queryClient.setQueryData<Notification[]>(['notifications'], (old) =>
        old?.map((n) => ({ ...n, read: true })),
      );
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(['notifications'], context.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}

export function NotificationBell() {
  const navigate = useNavigate();
  const { data: notifications } = useNotifications();
  const markRead = useMarkNotificationRead();
  const markAllRead = useMarkAllRead();

  const unreadCount = useMemo(
    () => notifications?.filter((n) => !n.read).length ?? 0,
    [notifications],
  );

  const handleClickNotification = useCallback(
    (notification: Notification) => {
      if (!notification.read) {
        markRead.mutate(notification.id);
      }
      if (notification.link) {
        navigate(notification.link);
      }
    },
    [markRead, navigate],
  );

  const handleMarkAllRead = useCallback(() => {
    markAllRead.mutate();
  }, [markAllRead]);

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          className="relative flex items-center justify-center rounded-md p-1.5 text-muted-foreground hover:bg-foreground/5 hover:text-foreground transition-colors outline-none"
          aria-label="Notifications"
          data-testid="notification-bell"
        >
          <Bell size={18} />
          {unreadCount > 0 && (
            <span
              className={cn(
                'absolute -right-0.5 -top-0.5 flex items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground',
                unreadCount > 9 ? 'h-4.5 min-w-4.5 px-1' : 'h-4 w-4',
              )}
              data-testid="notification-badge"
            >
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={8}
          className="glass-card w-[360px] rounded-xl border border-border/50 shadow-2xl backdrop-blur-xl"
        >
          {/* Title bar */}
          <div className="flex items-center justify-between border-b border-border/30 px-3 py-2.5">
            <span className="text-sm font-semibold">Notifications</span>
            <DropdownMenu.Item asChild>
              <button
                onClick={() => navigate('/settings')}
                className="rounded-md p-1 text-muted-foreground outline-none hover:bg-foreground/5 hover:text-foreground transition-colors"
                aria-label="Notification settings"
                data-testid="notification-settings"
              >
                <Settings size={14} />
              </button>
            </DropdownMenu.Item>
          </div>

          {/* Content */}
          <NotificationDropdown
            notifications={notifications ?? []}
            onClickNotification={handleClickNotification}
            onMarkAllRead={handleMarkAllRead}
          />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
