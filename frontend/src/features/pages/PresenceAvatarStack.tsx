import { useMemo } from 'react';
import { m } from 'framer-motion';
import { Pencil } from 'lucide-react';
import { cn } from '../../shared/lib/cn';
import type { PresenceViewer } from './use-presence';

interface PresenceAvatarStackProps {
  viewers: PresenceViewer[];
  maxVisible?: number;
  className?: string;
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return (parts[0] ?? '').slice(0, 2).toUpperCase();
  return `${(parts[0] ?? '')[0] ?? ''}${(parts[1] ?? '')[0] ?? ''}`.toUpperCase();
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function PresenceAvatarStack({
  viewers,
  maxVisible = 3,
  className,
}: PresenceAvatarStackProps) {
  const reduce = useMemo(prefersReducedMotion, []);
  const visible = viewers.slice(0, maxVisible);
  const overflow = Math.max(0, viewers.length - visible.length);

  if (viewers.length === 0) return null;

  const animation = reduce
    ? { initial: false, animate: {}, exit: {} }
    : {
        initial: { opacity: 0, scale: 0.85 },
        animate: { opacity: 1, scale: 1 },
        exit: { opacity: 0, scale: 0.85 },
      };

  return (
    <div
      data-testid="presence-avatar-stack"
      className={cn(
        'inline-flex items-center gap-1 rounded-full bg-card/80 backdrop-blur-md border border-white/10 px-2 py-1 shadow-sm',
        className,
      )}
    >
      <div className="flex items-center">
        {visible.map((viewer, idx) => (
          <m.span
            key={viewer.userId}
            {...animation}
            transition={reduce ? { duration: 0 } : { delay: idx * 0.05, duration: 0.18 }}
            title={`${viewer.name} (${viewer.role})${viewer.isEditing ? ' — editing' : ''}`}
            data-testid="presence-avatar"
            data-user-id={viewer.userId}
            data-is-editing={viewer.isEditing ? 'true' : 'false'}
            className={cn(
              'relative flex h-7 w-7 items-center justify-center rounded-full border-2 border-card text-[10px] font-semibold text-foreground',
              'bg-gradient-to-br from-primary/30 to-primary/10',
              idx > 0 && '-ml-2',
            )}
            style={{ zIndex: visible.length - idx }}
          >
            {viewer.avatarUrl ? (
              <img
                src={viewer.avatarUrl}
                alt=""
                className="h-full w-full rounded-full object-cover"
                aria-hidden="true"
              />
            ) : (
              <span aria-hidden="true">{initialsOf(viewer.name)}</span>
            )}
            <span className="sr-only">{viewer.name}</span>
            {viewer.isEditing && (
              <span
                data-testid="presence-editing-badge"
                aria-label="editing"
                className="absolute -bottom-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-primary text-primary-foreground ring-2 ring-card"
              >
                <Pencil size={8} strokeWidth={2.5} />
              </span>
            )}
          </m.span>
        ))}
      </div>
      {overflow > 0 && (
        <span
          data-testid="presence-overflow"
          className="ml-1 inline-flex h-6 items-center justify-center rounded-full bg-muted px-2 text-[10px] font-medium text-muted-foreground"
        >
          +{overflow}
        </span>
      )}
    </div>
  );
}
