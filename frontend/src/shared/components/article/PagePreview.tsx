import { useState, useRef, useEffect, useCallback } from 'react';
import { m, AnimatePresence } from 'framer-motion';
import { FileText } from 'lucide-react';
import { usePage } from '../../hooks/use-pages';
import { FreshnessBadge } from '../badges/FreshnessBadge';
import { cn } from '../../lib/cn';

interface PagePreviewProps {
  pageId: string;
  children: React.ReactNode;
  className?: string;
}

export function PagePreview({ pageId, children, className }: PagePreviewProps) {
  const [isHovering, setIsHovering] = useState(false);
  const [position, setPosition] = useState<'above' | 'below'>('below');
  const triggerRef = useRef<HTMLSpanElement>(null);
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { data: page, isLoading } = usePage(isHovering ? pageId : undefined);

  const calculatePosition = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    setPosition(spaceBelow < 200 && spaceAbove > spaceBelow ? 'above' : 'below');
  }, []);

  const handleMouseEnter = () => {
    hoverTimeoutRef.current = setTimeout(() => {
      calculatePosition();
      setIsHovering(true);
    }, 300);
  };

  const handleMouseLeave = () => {
    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    setIsHovering(false);
  };

  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    };
  }, []);

  const bodyPreview = page?.bodyText?.slice(0, 200) || '';

  return (
    <span
      ref={triggerRef}
      className={cn('relative inline', className)}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {children}

      <AnimatePresence>
        {isHovering && (
          <m.div
            initial={{ opacity: 0, y: position === 'below' ? -4 : 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className={cn(
              'absolute left-0 z-50 w-72',
              position === 'below' ? 'top-full mt-2' : 'bottom-full mb-2',
            )}
            data-testid="page-preview-card"
          >
            <div className="nm-card overflow-hidden p-3 shadow-xl">
              {isLoading ? (
                <div className="space-y-2">
                  <div className="h-4 w-3/4 animate-pulse rounded bg-foreground/10" />
                  <div className="h-3 w-full animate-pulse rounded bg-foreground/10" />
                  <div className="h-3 w-2/3 animate-pulse rounded bg-foreground/10" />
                </div>
              ) : page ? (
                <>
                  <div className="mb-2 flex items-start gap-2">
                    <FileText size={14} className="mt-0.5 shrink-0 text-action" />
                    <h4 className="text-sm font-medium leading-tight">{page.title}</h4>
                  </div>
                  {bodyPreview && (
                    <p className="mb-2 text-xs leading-relaxed text-muted-foreground line-clamp-3">
                      {bodyPreview}{bodyPreview.length >= 200 ? '...' : ''}
                    </p>
                  )}
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-[#ececea] px-1.5 py-0.5 text-[10px] text-[#4a4a48] dark:bg-[#2a2925] dark:text-[#c5bea9]">
                      {page.spaceKey}
                    </span>
                    {page.lastModifiedAt && (
                      <FreshnessBadge lastModified={page.lastModifiedAt} />
                    )}
                  </div>
                </>
              ) : (
                <p className="text-xs text-muted-foreground">Page not found</p>
              )}
            </div>
          </m.div>
        )}
      </AnimatePresence>
    </span>
  );
}
