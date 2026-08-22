import { useMemo } from 'react';
import { m } from 'framer-motion';
import { Bell, MessageSquare, AtSign, AlertTriangle, CheckCircle2, Inbox } from 'lucide-react';
import { cn } from '../../lib/cn';

export interface Notification {
  id: string;
  type: 'comment' | 'mention' | 'verification_due' | 'sync_complete' | 'general';
  title: string;
  body: string;
  read: boolean;
  link?: string;
  createdAt: string;
}

interface NotificationDropdownProps {
  notifications: Notification[];
  onClickNotification: (notification: Notification) => void;
  onMarkAllRead: () => void;
}

const typeIcons: Record<Notification['type'], typeof Bell> = {
  comment: MessageSquare,
  mention: AtSign,
  verification_due: AlertTriangle,
  sync_complete: CheckCircle2,
  general: Bell,
};

const typeColors: Record<Notification['type'], string> = {
  comment: 'text-info',
  mention: 'text-status-ai',
  verification_due: 'text-warning',
  sync_complete: 'text-success',
  general: 'text-muted-foreground',
};

function groupByDate(notifications: Notification[]) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const groups: { label: string; items: Notification[] }[] = [
    { label: 'Today', items: [] },
    { label: 'Yesterday', items: [] },
    { label: 'Older', items: [] },
  ];

  for (const n of notifications) {
    const date = new Date(n.createdAt);
    date.setHours(0, 0, 0, 0);
    if (date.getTime() >= today.getTime()) {
      groups[0]!.items.push(n);
    } else if (date.getTime() >= yesterday.getTime()) {
      groups[1]!.items.push(n);
    } else {
      groups[2]!.items.push(n);
    }
  }

  return groups.filter((g) => g.items.length > 0);
}

function formatTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  return date.toLocaleDateString();
}

export function NotificationDropdown({
  notifications,
  onClickNotification,
  onMarkAllRead,
}: NotificationDropdownProps) {
  const groups = useMemo(() => groupByDate(notifications), [notifications]);
  const hasUnread = notifications.some((n) => !n.read);

  if (notifications.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-10 text-center" data-testid="notification-empty">
        <Inbox size={32} className="mb-3 text-muted-foreground" />
        <p className="text-sm font-medium">No notifications</p>
        <p className="mt-1 text-xs text-muted-foreground">New activity will show up here.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col" data-testid="notification-dropdown">
      {/* Header with mark all read */}
      {hasUnread && (
        <div className="flex items-center justify-end border-b border-border px-3 py-2">
          <button
            onClick={onMarkAllRead}
            className="text-xs text-action hover:text-action/80 transition-colors"
            data-testid="mark-all-read"
          >
            Mark all as read
          </button>
        </div>
      )}

      {/* Grouped notification list */}
      <div className="max-h-[400px] overflow-y-auto">
        {groups.map((group) => (
          <div key={group.label}>
            <div className="sticky top-0 bg-card px-3 py-1.5 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
              {group.label}
            </div>
            {group.items.map((notification, i) => {
              const Icon = typeIcons[notification.type] ?? Bell;
              const color = typeColors[notification.type] ?? 'text-muted-foreground';
              return (
                <m.button
                  key={notification.id}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: i * 0.03 }}
                  onClick={() => onClickNotification(notification)}
                  className={cn(
                    'flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-foreground/5',
                    !notification.read && 'bg-action/5',
                  )}
                  data-testid={`notification-item-${notification.id}`}
                >
                  <div className={cn('mt-0.5 shrink-0', color)}>
                    <Icon size={16} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className={cn('text-sm', !notification.read && 'font-medium')}>
                        {notification.title}
                      </span>
                      {!notification.read && (
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-action" />
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground line-clamp-1">
                      {notification.body}
                    </p>
                    <span className="mt-0.5 text-[11px] text-muted-foreground/70">
                      {formatTime(notification.createdAt)}
                    </span>
                  </div>
                </m.button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
