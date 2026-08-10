import { useEffect, useState, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { m, AnimatePresence } from 'framer-motion';
import { AlertTriangle, X, Wifi, WifiOff, Server } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useAuthStore } from '../../../stores/auth-store';
import {
  AI_MODELS_SETTINGS_LABEL,
  AI_MODELS_SETTINGS_PATH,
} from '../../lib/routes';

interface HealthStatus {
  status: string;
  llmProvider?: string;
  services?: {
    postgres?: boolean;
    redis?: boolean;
    llm?: boolean;
  };
}

interface ServiceAlert {
  id: string;
  service: string;
  label: string;
  icon: typeof AlertTriangle;
  colorClass: string;
  bgClass: string;
  link?: { to: string; label: string };
}

const HEALTH_CHECK_INTERVAL = 30_000;

export function ServiceStatus() {
  const [alerts, setAlerts] = useState<ServiceAlert[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const checkHealth = useCallback(async () => {
    try {
      // /api/health/ready only checks postgres+redis — stable even when LLM is down
      const res = await fetch('/api/health/ready');
      if (!res.ok) {
        setAlerts([{
          id: 'api',
          service: 'api',
          label: 'API server is unreachable',
          icon: WifiOff,
          colorClass: 'text-destructive',
          bgClass: 'border-destructive/40 bg-destructive/10',
        }]);
        return;
      }

      // Separately fetch full health for LLM/redis status (best-effort, ignore
      // errors). #1052: /api/health returns per-service detail only to an
      // authenticated admin, so attach the token. Non-admins get a coarse
      // `{ status }` with no `services`, so no alert is derived — acceptable,
      // since these alerts are operator-facing.
      const newAlerts: ServiceAlert[] = [];
      try {
        const { accessToken } = useAuthStore.getState();
        const fullRes = await fetch('/api/health', {
          headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
          credentials: 'include',
        });
        if (fullRes.ok) {
          const data: HealthStatus = await fullRes.json();
          if (data.services?.llm === false) {
            const label = data.llmProvider
              ? `LLM provider "${data.llmProvider}" is unreachable`
              : 'LLM provider is unreachable';
            newAlerts.push({
              // id stays 'ollama' for dismissal-state compatibility
              id: 'ollama',
              service: 'LLM provider',
              label,
              icon: Server,
              colorClass: 'text-warning',
              bgClass: 'border-warning/40 bg-warning/10',
              // Label and path come from routes.ts so this operator-facing
              // CTA cannot drift from the rail again — it used to say "Check
              // LLM settings", naming a panel no rail item carries.
              link: {
                to: AI_MODELS_SETTINGS_PATH,
                label: `Check ${AI_MODELS_SETTINGS_LABEL} settings`,
              },
            });
          }
          if (data.services?.redis === false) {
            newAlerts.push({
              id: 'redis',
              service: 'redis',
              label: 'Redis is unavailable',
              icon: AlertTriangle,
              colorClass: 'text-warning',
              bgClass: 'border-warning/40 bg-warning/10',
            });
          }
        }
      } catch {
        // full health check failed — don't show LLM alert, API is still up
      }

      setAlerts(newAlerts);

      // Auto-dismiss recovered services
      if (newAlerts.length === 0) {
        setDismissed(new Set());
      }
    } catch {
      setAlerts([{
        id: 'network',
        service: 'network',
        label: 'Network connection lost',
        icon: Wifi,
        colorClass: 'text-destructive',
        bgClass: 'border-destructive/40 bg-destructive/10',
      }]);
    }
  }, []);

  useEffect(() => {
    checkHealth();
    intervalRef.current = setInterval(checkHealth, HEALTH_CHECK_INTERVAL);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [checkHealth]);

  const dismissAlert = (id: string) => {
    setDismissed((prev) => new Set([...prev, id]));
  };

  const visibleAlerts = alerts.filter((a) => !dismissed.has(a.id));

  if (visibleAlerts.length === 0) return null;

  return (
    <div className="space-y-2" role="status" aria-live="polite">
      <AnimatePresence mode="sync">
        {visibleAlerts.map((alert) => {
          const Icon = alert.icon;
          return (
            <m.div
              key={alert.id}
              initial={{ opacity: 0, height: 0, marginBottom: 0 }}
              animate={{ opacity: 1, height: 'auto', marginBottom: 8 }}
              exit={{ opacity: 0, height: 0, marginBottom: 0 }}
              transition={{ duration: 0.2 }}
              // One signal, not three. The icon, the label AND the link were all
              // amber, so a persistent operator condition rendered as the
              // loudest thing on every screen at 14px against 13px everywhere
              // else. Now the STATUS COLOUR marks the condition (icon + border)
              // and nothing else: the label is ordinary foreground text, and the
              // action takes the accent, because teal is what "operable" means
              // in this system. Three colours, three distinct jobs.
              //
              // `flex-wrap` + `gap-y`: at 390px the label and its link used to
              // collide with the dismiss button.
              className={cn(
                'flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-3 py-1.5',
                alert.bgClass,
              )}
            >
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
                <Icon size={14} className={cn('shrink-0', alert.colorClass)} />
                <span className="text-[13px] font-medium text-foreground">
                  {alert.label}
                </span>
                {alert.link && (
                  <Link
                    to={alert.link.to}
                    className="text-[13px] font-medium text-primary-ink underline underline-offset-2"
                  >
                    {alert.link.label}
                  </Link>
                )}
              </div>
              <button
                onClick={() => dismissAlert(alert.id)}
                className="nm-icon-button size-6 shrink-0"
                aria-label={`Dismiss ${alert.service} alert`}
              >
                <X size={14} />
              </button>
            </m.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
