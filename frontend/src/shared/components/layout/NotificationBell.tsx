import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as Popover from '@radix-ui/react-popover';
import { Bell } from 'lucide-react';
import { apiFetch } from '../../lib/api';
import { NotificationDropdown, type Notification } from './NotificationDropdown';
import { cn } from '../../lib/cn';

const NOTIFICATION_TYPES = new Set<Notification['type']>([
  'comment',
  'mention',
  'verification_due',
  'sync_complete',
  'general',
]);

interface NotificationListResponse {
  items: Notification[];
  total: number;
}

/** GET /notifications answers `{ items, total }`, never a bare array. */
function toNotificationList(data: unknown): Notification[] {
  const raw = Array.isArray(data)
    ? data
    : data && typeof data === 'object' && Array.isArray((data as { items?: unknown }).items)
      ? (data as { items: unknown[] }).items
      : [];

  return raw.map((row) => {
    const n = (row ?? {}) as Record<string, unknown>;
    const type = typeof n.type === 'string' && NOTIFICATION_TYPES.has(n.type as Notification['type'])
      ? (n.type as Notification['type'])
      : 'general';
    return {
      id: String(n.id ?? ''),
      type,
      title: typeof n.title === 'string' ? n.title : '',
      body: typeof n.body === 'string' ? n.body : '',
      read: Boolean(n.read ?? n.isRead),
      link: typeof n.link === 'string' ? n.link : undefined,
      createdAt: n.createdAt instanceof Date
        ? n.createdAt.toISOString()
        : typeof n.createdAt === 'string'
          ? n.createdAt
          : new Date(0).toISOString(),
    };
  });
}

function useNotifications() {
  return useQuery({
    queryKey: ['notifications'],
    queryFn: () => apiFetch<unknown>('/notifications'),
    refetchInterval: 60_000, // poll every 60s
    refetchOnWindowFocus: true,
    select: toNotificationList,
  });
}

function patchCachedList(
  old: unknown,
  mapItem: (n: Notification) => Notification,
): NotificationListResponse | Notification[] | undefined {
  if (Array.isArray(old)) return old.map((row) => mapItem(toNotificationList([row])[0]!));
  if (old && typeof old === 'object' && Array.isArray((old as NotificationListResponse).items)) {
    const envelope = old as NotificationListResponse;
    return {
      ...envelope,
      items: toNotificationList(envelope.items).map(mapItem),
    };
  }
  return undefined;
}

function useMarkNotificationRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (notificationId: string) =>
      apiFetch(`/notifications/${notificationId}/read`, { method: 'POST' }),
    onMutate: async (notificationId) => {
      await queryClient.cancelQueries({ queryKey: ['notifications'] });
      const previous = queryClient.getQueryData(['notifications']);
      queryClient.setQueryData(['notifications'], (old) =>
        patchCachedList(old, (n) => (n.id === notificationId ? { ...n, read: true } : n)),
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
      apiFetch('/notifications/read-all', { method: 'POST' }),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ['notifications'] });
      const previous = queryClient.getQueryData(['notifications']);
      queryClient.setQueryData(['notifications'], (old) =>
        patchCachedList(old, (n) => ({ ...n, read: true })),
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
  // The panel is a Radix Popover (not a DropdownMenu): its rich, scrollable,
  // multi-action content is a popover, not a WAI-ARIA command menu. A menu would
  // trap keyboard focus to registered Items (roving focus + Tab preventDefault),
  // leaving the plain-button notifications and "Mark all as read" unreachable by
  // keyboard (#879, WCAG 2.1.1). A Popover keeps every inner button focusable,
  // but plain buttons no longer auto-dismiss, so we control open state and close
  // it explicitly on the actions that used to be menu Items.
  const [open, setOpen] = useState(false);
  const { data: notifications } = useNotifications();
  const markRead = useMarkNotificationRead();
  const markAllRead = useMarkAllRead();

  const unreadCount = useMemo(
    () => (Array.isArray(notifications) ? notifications.filter((n) => !n.read).length : 0),
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
      setOpen(false);
    },
    [markRead, navigate],
  );

  const handleMarkAllRead = useCallback(() => {
    markAllRead.mutate();
  }, [markAllRead]);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="nm-icon-button relative"
          aria-label={
            unreadCount > 0
              ? `Notifications, ${unreadCount} unread`
              : 'Notifications'
          }
          data-testid="notification-bell"
        >
          <Bell size={18} />
          {unreadCount > 0 && (
            <span
              className={cn(
                'absolute -right-0.5 -top-0.5 flex items-center justify-center rounded-full bg-action text-[11px] font-bold text-action-foreground',
                unreadCount > 9 ? 'h-4.5 min-w-4.5 px-1' : 'h-4 w-4',
              )}
              data-testid="notification-badge"
            >
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          className="z-50 w-[360px] nm-card-elevated"
        >
          {/* Title bar */}
          <div className="border-b border-border px-3 py-2.5">
            <span className="text-sm font-semibold">Notifications</span>
          </div>

          {/* Content */}
          <NotificationDropdown
            notifications={notifications ?? []}
            onClickNotification={handleClickNotification}
            onMarkAllRead={handleMarkAllRead}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
