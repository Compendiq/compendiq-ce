import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as Switch from '@radix-ui/react-switch';
import { toast } from 'sonner';
import { Bell, MessageSquare, AtSign, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { apiFetch } from '../../shared/lib/api';

interface NotificationPrefs {
  comment: boolean;
  mention: boolean;
  verification_due: boolean;
  sync_complete: boolean;
  general: boolean;
}

const DEFAULT_PREFS: NotificationPrefs = {
  comment: true,
  mention: true,
  verification_due: true,
  sync_complete: true,
  general: true,
};

function useNotificationPrefs() {
  return useQuery<NotificationPrefs>({
    queryKey: ['notification-prefs'],
    queryFn: async () => {
      try {
        return await apiFetch<NotificationPrefs>('/notifications/preferences');
      } catch {
        return DEFAULT_PREFS;
      }
    },
  });
}

function useUpdateNotificationPrefs() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (prefs: Partial<NotificationPrefs>) =>
      apiFetch('/notifications/preferences', {
        method: 'PUT',
        body: JSON.stringify(prefs),
      }),
    onMutate: async (newPrefs) => {
      await queryClient.cancelQueries({ queryKey: ['notification-prefs'] });
      const previous = queryClient.getQueryData<NotificationPrefs>(['notification-prefs']);
      queryClient.setQueryData<NotificationPrefs>(['notification-prefs'], (old) => ({
        ...(old ?? DEFAULT_PREFS),
        ...newPrefs,
      }));
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(['notification-prefs'], context.previous);
      }
      toast.error('Failed to update notification preferences');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['notification-prefs'] });
    },
    onSuccess: () => {
      toast.success('Notification preferences updated');
    },
  });
}

const NOTIFICATION_TYPES: {
  key: keyof NotificationPrefs;
  label: string;
  description: string;
  icon: typeof Bell;
}[] = [
  {
    key: 'comment',
    label: 'Comments',
    description: 'When someone comments on your pages',
    icon: MessageSquare,
  },
  {
    key: 'mention',
    label: 'Mentions',
    description: 'When someone mentions you in a comment',
    icon: AtSign,
  },
  {
    key: 'verification_due',
    label: 'Verification Due',
    description: 'When a page needs re-verification',
    icon: AlertTriangle,
  },
  {
    key: 'sync_complete',
    label: 'Sync Complete',
    description: 'When a Confluence sync finishes',
    icon: CheckCircle2,
  },
  {
    key: 'general',
    label: 'General',
    description: 'System announcements and updates',
    icon: Bell,
  },
];

export function NotificationPreferences() {
  const { data: prefs, isLoading } = useNotificationPrefs();
  const updatePrefs = useUpdateNotificationPrefs();

  const currentPrefs = prefs ?? DEFAULT_PREFS;

  const handleToggle = (key: keyof NotificationPrefs, checked: boolean) => {
    updatePrefs.mutate({ [key]: checked });
  };

  return (
    <div className="space-y-4" data-testid="notification-preferences">
      <div>
        <h3 className="text-sm font-semibold">Notification Preferences</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Choose which notifications you want to receive in-app
        </p>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 rounded-lg border border-border/30 bg-foreground/[0.02] p-3">
              <div className="skeleton h-8 w-8 rounded-lg" />
              <div className="flex-1 space-y-1.5">
                <div className="skeleton h-3 w-24" />
                <div className="skeleton h-2.5 w-48" />
              </div>
              <div className="skeleton h-5 w-9 rounded-full" />
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          {NOTIFICATION_TYPES.map(({ key, label, description, icon: Icon }) => (
            <div
              key={key}
              className="flex items-center gap-3 rounded-lg border border-border/30 bg-foreground/[0.02] p-3"
              data-testid={`pref-${key}`}
            >
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-foreground/5 text-muted-foreground">
                <Icon size={16} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{label}</p>
                <p className="text-xs text-muted-foreground">{description}</p>
              </div>
              <Switch.Root
                checked={currentPrefs[key]}
                onCheckedChange={(checked) => handleToggle(key, checked)}
                className="relative h-5 w-9 shrink-0 rounded-full bg-foreground/10 transition-colors data-[state=checked]:bg-primary outline-none"
                data-testid={`pref-toggle-${key}`}
              >
                <Switch.Thumb className="block h-4 w-4 translate-x-0.5 rounded-full bg-white transition-transform data-[state=checked]:translate-x-4" />
              </Switch.Root>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
