import { useEffect, useState, useCallback, useRef } from 'react';
import { m, AnimatePresence } from 'framer-motion';
import { AlertTriangle, X, Wifi, WifiOff, Server } from 'lucide-react';
import { cn } from '../../lib/cn';

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
          bgClass: 'bg-destructive/15 border-destructive/30',
        }]);
        return;
      }

      // Separately fetch full health for LLM status (best-effort, ignore errors)
      const newAlerts: ServiceAlert[] = [];
      try {
        const fullRes = await fetch('/api/health');
        if (fullRes.ok) {
          const data: HealthStatus = await fullRes.json();
          if (data.services?.llm === false) {
            const label = data.llmProvider === 'openai'
              ? 'LLM server is unreachable'
              : 'Ollama server is down';
            newAlerts.push({
              id: 'ollama',
              service: 'ollama',
              label,
              icon: Server,
              colorClass: 'text-warning',
              bgClass: 'bg-warning/15 border-warning/30',
            });
          }
          if (data.services?.redis === false) {
            newAlerts.push({
              id: 'redis',
              service: 'redis',
              label: 'Redis is unavailable',
              icon: AlertTriangle,
              colorClass: 'text-warning',
              bgClass: 'bg-warning/15 border-warning/30',
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
        bgClass: 'bg-destructive/15 border-destructive/30',
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
              className={cn(
                'flex items-center justify-between rounded-lg border px-4 py-2.5',
                alert.bgClass,
              )}
            >
              <div className="flex items-center gap-2">
                <Icon size={16} className={alert.colorClass} />
                <span className={cn('text-sm font-medium', alert.colorClass)}>
                  {alert.label}
                </span>
              </div>
              <button
                onClick={() => dismissAlert(alert.id)}
                className="rounded p-1 text-muted-foreground hover:bg-foreground/5"
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
