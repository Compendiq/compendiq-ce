import { useCallback, useState } from 'react';
import { m, AnimatePresence, useReducedMotion } from 'framer-motion';
import { useIsDockWideLayout, useIsMobileLayout } from '../../../shared/hooks/use-media-query';
import { useAiDockStore } from '../../../stores/ai-dock-store';
import { useUiStore } from '../../../stores/ui-store';
import { cn } from '../../../shared/lib/cn';
import { AiDockSheet } from './AiDockSheet';
import { DockPanel } from './DockPanel';

// Same spring the article right pane uses, so the two panels on the same edge
// of the screen move with one physics rather than two.
const dockSpring = { type: 'spring' as const, stiffness: 400, damping: 30 };

/**
 * Ceiling on the dock's width below the wide breakpoint. The stored width is a
 * preference set with room to spare; honoring a 640px dock on a 1040px viewport
 * would leave the article a measure it cannot be read at. The rail is already
 * gone by this point — this is the rest of "the assistant takes the pane, the
 * editor keeps enough to work in".
 */
const NARROW_MAX_WIDTH = 380;

/**
 * The docked AI assistant (#1126).
 *
 * Two containers around one panel. At `md` and up it is a column: mounted as a
 * sibling of `ArticleRightPane` in `AppLayout`, i.e. as a third column in the
 * same flex row rather than an overlay. That is deliberate — an overlay reads
 * as bolted onto the right edge, a column reads as part of the app.
 *
 * Below `md` there is no right side to dock into, so the same panel arrives as
 * a bottom sheet over the article (`AiDockSheet`), mirroring the way the left
 * sidebar already becomes a slide-over there.
 */
export function AiDock() {
  const mobile = useIsMobileLayout();
  return mobile ? <AiDockSheet /> : <AiDockColumn />;
}

/**
 * The wide form: a third column in `AppLayout`'s flex row.
 *
 * It takes the same `bg-background` / `border-l border-border` chassis as the
 * right pane and aligns its `h-10` header with the pane's "Properties" header,
 * so rail and dock read as one continuous piece of chrome.
 *
 * Rendering is split so the AI provider is not woken on every article route:
 * only `DockPanel` consumes `AiContext`, and it only mounts while the dock is
 * open. `AnimatePresence` keeps it mounted for the exit animation, after which
 * the consumer count drops and the provider goes inert again.
 */
function AiDockColumn() {
  const open = useAiDockStore((s) => s.open);
  const closeDock = useAiDockStore((s) => s.closeDock);
  const wide = useIsDockWideLayout();
  const width = useUiStore((s) => s.aiDockWidth);
  const setWidth = useUiStore((s) => s.setAiDockWidth);
  const reduceEffects = useReducedMotion();
  const [isResizing, setIsResizing] = useState(false);
  const effectiveWidth = wide ? width : Math.min(width, NARROW_MAX_WIDTH);

  // Third instance of the resize recipe used by ArticleRightPane and
  // SidebarTreeView — dragging left widens, because the panel grows leftward.
  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsResizing(true);
      const startX = e.clientX;
      const startWidth = width;

      function onMouseMove(ev: MouseEvent) {
        setWidth(startWidth - (ev.clientX - startX));
      }
      function onMouseUp() {
        setIsResizing(false);
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      }
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    },
    [width, setWidth],
  );

  return (
    <AnimatePresence>
      {open && (
        <m.aside
          key="ai-dock"
          initial={reduceEffects ? false : { width: 0, opacity: 0 }}
          animate={{ width: effectiveWidth, opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={reduceEffects || isResizing ? { duration: 0 } : dockSpring}
          className={cn(
            'relative flex shrink-0 flex-col overflow-hidden border-l border-border bg-background',
            isResizing && 'select-none',
          )}
          aria-label="AI assistant"
          data-testid="ai-dock"
        >
          <DockPanel onClose={closeDock} />

          {wide && (
            <div
              role="separator"
              aria-label="Resize AI assistant"
              aria-orientation="vertical"
              onMouseDown={handleResizeStart}
              className={cn(
                'absolute left-0 top-2 bottom-2 w-1 cursor-col-resize rounded-full transition-colors hover:bg-action/40',
                isResizing && 'bg-action/60',
              )}
            />
          )}
        </m.aside>
      )}
    </AnimatePresence>
  );
}
