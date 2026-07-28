import { useCallback, useEffect, useRef, useState } from 'react';
import { m, AnimatePresence, useReducedMotion } from 'framer-motion';
import { useAiDockStore } from '../../../stores/ai-dock-store';
import { cn } from '../../../shared/lib/cn';
import { DockPanel } from './DockPanel';

// Same spring the left slide-over uses (AppLayout), so the two things that
// enter over the article from an edge on a phone move with one physics.
const sheetSpring = { type: 'spring' as const, stiffness: 400, damping: 35 };

/**
 * Detents, as a fraction of the viewport.
 *
 * `rest` is the height at which the composer, the chips and two or three turns
 * are all visible while the top of the article stays in view behind the scrim —
 * the point of docking the assistant at all is that the document does not leave
 * the screen. `full` is what you drag to once the answer is the thing you are
 * reading.
 */
const REST_RATIO = 0.52;
const FULL_RATIO = 0.92;

/** Below this the chips and the composer stop fitting together. */
const MIN_HEIGHT = 260;
/** Never quite cover the app header, so the sheet reads as over the page. */
const TOP_INSET = 56;
/** How far below `rest` the sheet can be dragged before it lets go. */
const DISMISS_RATIO = 0.6;
/**
 * How far past the dismiss threshold the drag can still travel. Without some
 * overshoot the sheet stops exactly at the threshold and the gesture can never
 * cross it — the dismiss would be unreachable by dragging.
 */
const DISMISS_OVERSHOOT = 40;
/** Travel below which a press is a tap, not a drag. */
const DRAG_SLOP = 4;

type Detent = 'rest' | 'full';

function viewportHeight(): number {
  return typeof window === 'undefined' ? 0 : window.innerHeight;
}

function detentHeight(detent: Detent, vh: number): number {
  const ceiling = Math.max(MIN_HEIGHT, vh - TOP_INSET);
  const target = Math.round(vh * (detent === 'full' ? FULL_RATIO : REST_RATIO));
  return Math.min(ceiling, Math.max(MIN_HEIGHT, target));
}

/**
 * The assistant below `md`, where there is no right pane to dock into (#1126).
 *
 * The contents are `DockPanel`, unchanged — only the container differs. Where
 * the wide form is a column the article shrinks around, this one is a sheet
 * over the article, because at 390px there is no "beside".
 *
 * That makes it modal in a way the dock deliberately is not: it occludes the
 * document rather than sitting next to it, so it takes a backdrop, `aria-modal`
 * and a real Tab trap — the same treatment the mobile navigation slide-over
 * already gets in `AppLayout`. The dock's reasoning ("Tab must reach the
 * article") does not survive the article being behind a scrim.
 */
export function AiDockSheet() {
  const open = useAiDockStore((s) => s.open);
  const closeDock = useAiDockStore((s) => s.closeDock);
  const reduceEffects = useReducedMotion();

  return (
    <AnimatePresence>
      {open && (
        <>
          <m.div
            key="ai-dock-sheet-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduceEffects ? 0 : 0.2 }}
            className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px]"
            onClick={closeDock}
            aria-hidden="true"
            data-testid="ai-dock-sheet-backdrop"
          />
          <SheetSurface key="ai-dock-sheet" onClose={closeDock} reduceEffects={Boolean(reduceEffects)} />
        </>
      )}
    </AnimatePresence>
  );
}

/**
 * Mounted only while the sheet is open, so the detent resets to `rest` on every
 * open and the Tab trap exists exactly as long as the dialog does.
 */
function SheetSurface({ onClose, reduceEffects }: { onClose: () => void; reduceEffects: boolean }) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const [detent, setDetent] = useState<Detent>('rest');
  const [vh, setVh] = useState(viewportHeight);
  // Non-null only mid-gesture: the finger owns the height until it lifts, then
  // the nearest detent takes it back.
  const [dragHeight, setDragHeight] = useState<number | null>(null);

  const height = dragHeight ?? detentHeight(detent, vh);

  // The gesture reads these at pointerdown, and a drag outlives any render, so
  // they are held in refs rather than closed over. Synced in an effect — the
  // same latest-ref idiom `DockPanel` uses for `runChip` — which is current by
  // the time any pointer event can arrive.
  const heightRef = useRef(height);
  const vhRef = useRef(vh);
  useEffect(() => {
    heightRef.current = height;
    vhRef.current = vh;
  }, [height, vh]);
  // A drag ends with a `click` on the grabber, which must not then also toggle
  // the detent the drag just chose.
  const suppressClickRef = useRef(false);

  // Detents are fractions of the viewport, so the browser chrome collapsing, a
  // rotation, or the on-screen keyboard opening all resize the sheet rather
  // than leaving it at a height the viewport no longer has.
  useEffect(() => {
    const onResize = () => setVh(viewportHeight());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Tab containment. `DockPanel` already moves focus to the composer on mount
  // and hands it back to the opener on unmount, and that contract is identical
  // in both forms — this adds only the cycle, so the two do not fight over
  // where focus starts. Modelled on the mobile slide-over's trap in AppLayout.
  useEffect(() => {
    const panel = sheetRef.current;
    if (!panel) return;

    const focusableSelector =
      'a[href], button:not([disabled]), textarea:not([disabled]), ' +
      'input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const getFocusable = () => Array.from(panel.querySelectorAll<HTMLElement>(focusableSelector));

    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const items = getFocusable();
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const active = document.activeElement;
      if (event.shiftKey) {
        if (active === first || !panel.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last || !panel.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, []);

  /**
   * Drag, hand-rolled on Pointer Events.
   *
   * Not framer's `drag`: the app is wrapped in `LazyMotion features={domAnimation}`
   * (App.tsx), which does NOT include the drag/pan feature bundle — a `drag` prop
   * under it is silently inert, no error and no warning. The alternatives were to
   * promote the whole app to `domMax` for one gesture on one breakpoint, or to
   * own ~40 lines of pointer handling. This is those lines, and it is the same
   * shape as the three resize handles the app already has (`ArticleRightPane`,
   * `SidebarTreeView`, `AiDock`), which are hand-rolled for the same reason.
   *
   * Pointer rather than touch events so one path serves finger, stylus and
   * mouse — and because `pointer-event-bridge.ts` (#1087/#1088) already
   * synthesizes the whole pointerdown/move/up sequence on the input stacks that
   * only emit legacy mouse events.
   */
  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    // Cleared at the start of every gesture rather than only when a click
    // arrives to consume it: touch input does not always deliver one (a
    // pointercancel produces none at all), and a suppression left standing
    // would swallow the *next* tap.
    suppressClickRef.current = false;
    const startY = e.clientY;
    const startHeight = heightRef.current;
    const ceiling = detentHeight('full', vhRef.current);
    const rest = detentHeight('rest', vhRef.current);
    let moved = false;
    let next = startHeight;

    function onMove(ev: PointerEvent) {
      // Up is positive: dragging toward the top of the screen grows the sheet.
      const delta = startY - ev.clientY;
      if (!moved && Math.abs(delta) < DRAG_SLOP) return;
      moved = true;
      // The floor is under `rest` so the dismiss gesture has somewhere to go.
      next = Math.min(
        ceiling,
        Math.max(Math.round(rest * DISMISS_RATIO) - DISMISS_OVERSHOOT, startHeight + delta),
      );
      setDragHeight(next);
    }

    function onEnd() {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
      setDragHeight(null);
      if (!moved) return; // A tap — the click handler owns it.
      suppressClickRef.current = true;
      if (next < rest * DISMISS_RATIO) {
        onClose();
        return;
      }
      setDetent(next > (rest + ceiling) / 2 ? 'full' : 'rest');
    }

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
  }, [onClose]);

  // The non-drag path. WCAG 2.5.7 requires one, and it is also simply the
  // faster way in: a thumb tap or Enter moves between the two detents without
  // aiming a gesture.
  const toggleDetent = useCallback(() => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    setDetent((d) => (d === 'rest' ? 'full' : 'rest'));
  }, []);

  const expanded = detent === 'full';

  return (
    <m.div
      ref={sheetRef}
      id="ai-dock-sheet"
      role="dialog"
      aria-modal="true"
      aria-label="AI assistant"
      tabIndex={-1}
      initial={reduceEffects ? false : { y: '100%' }}
      animate={{ y: 0 }}
      exit={{ y: '100%' }}
      transition={reduceEffects ? { duration: 0 } : sheetSpring}
      style={{ height }}
      className={cn(
        'fixed inset-x-0 bottom-0 z-50 flex flex-col overflow-hidden rounded-t-2xl',
        'border-t border-border bg-background shadow-[0_-12px_36px_-8px_var(--nm-shadow-out-strong)]',
        // Height is a plain inline style with a CSS transition rather than a
        // framer `animate` value, so the drag tracks the finger with no
        // animation frame between them. The transition is what makes the
        // release settle instead of jump — and it is dropped mid-gesture and
        // under reduced motion.
        dragHeight === null && !reduceEffects && 'transition-[height] duration-200 ease-out',
        dragHeight !== null && 'select-none',
      )}
      data-testid="ai-dock-sheet"
      data-detent={detent}
      onKeyDown={(e) => {
        // Escape from inside the panel is handled there (it stops propagation
        // so the article's edit mode does not exit too). This catches Escape
        // from the grab handle, which sits outside it.
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        onClose();
      }}
    >
      {/* Grab handle. One control carrying three input methods: drag it, tap
          it, or focus it and press Enter. `touch-none` so the browser does not
          claim the gesture as a scroll before the handler sees it. */}
      <button
        type="button"
        onPointerDown={handlePointerDown}
        onClick={toggleDetent}
        aria-expanded={expanded}
        aria-controls="ai-dock-sheet"
        aria-label={expanded ? 'Collapse assistant' : 'Expand assistant'}
        title={expanded ? 'Collapse assistant' : 'Expand assistant'}
        className="group flex h-7 w-full shrink-0 touch-none select-none items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40"
        data-testid="ai-dock-sheet-grabber"
      >
        {/* The handle is a control, so it takes --color-border-interactive —
            the token ADR-010 keeps measurably ≥3:1 on every surface (3.81 dark,
            3.48 light). A muted-foreground tint at any opacity that still reads
            as "handle" tops out around 2:1 and fails WCAG 1.4.11.

            forced-colors throws painted backgrounds away, which would leave the
            sheet's only drag affordance invisible in High Contrast Mode; a
            system color is the documented way back. */}
        <span
          className="h-1 w-10 rounded-full bg-border-interactive transition-colors group-hover:bg-muted-foreground forced-colors:bg-[ButtonText]"
          aria-hidden
        />
      </button>

      <DockPanel onClose={onClose} variant="sheet" />
    </m.div>
  );
}
