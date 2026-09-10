import { useCallback, useEffect, useMemo, useState } from 'react';
import { m, AnimatePresence, useReducedMotion } from 'framer-motion';
import { PanelLeft, PanelLeftClose, SquarePen } from 'lucide-react';
import { MainNavStripExpanded, MainNavStripCollapsed } from '../../../shared/components/layout/MainNavStrip';
import { useUiStore } from '../../../stores/ui-store';
import { cn } from '../../../shared/lib/cn';
import { useAiContext } from '../AiContext';
import { useConversationList } from './use-conversation-list';
import { ConversationList } from './ConversationList';
import { filterConversations } from './filter-conversations';

const sidebarSpring = { type: 'spring' as const, stiffness: 400, damping: 30 };

/**
 * A filter is a scale affordance, so it appears only at scale — the tree's own
 * SPACE_FILTER_THRESHOLD precedent. Measured against the LOADED row count, which
 * is also what the footer states.
 */
export const CONVERSATION_FILTER_THRESHOLD = 8;

/**
 * The conversations rail — the third arm of AppLayout's sidebar ternary, mounted
 * on AI routes in place of the Pages tree.
 *
 * It shares `treeSidebarCollapsed` / `treeSidebarWidth` with both trees, so "," and
 * the persisted width carry across routes, and it takes no forceCollapsed /
 * onForceExpand: the layout presets that used to produce them were deleted, and
 * `app-shell-layout.test.ts` fails if either name comes back in AppLayout.
 *
 * `embedMainNav` mirrors SidebarTreeView / SettingsSidebar exactly. The desktop
 * shell renders <MainNavChassisRail /> outside the workspace card and passes
 * `false`; the mobile drawer has no such rail and takes the default. When it is
 * false there is no nav row at all, so the collapse button moves into the row
 * below — the tree's own two-branch treatment (SidebarTreeView.tsx:1087-1096).
 */
export function AiConversationsSidebar({
  onNavigate,
  embedMainNav = true,
}: { onNavigate?: () => void; embedMainNav?: boolean } = {}) {
  const treeSidebarCollapsed = useUiStore((s) => s.treeSidebarCollapsed);
  const toggleTreeSidebar = useUiStore((s) => s.toggleTreeSidebar);
  const treeSidebarWidth = useUiStore((s) => s.treeSidebarWidth);
  const setTreeSidebarWidth = useUiStore((s) => s.setTreeSidebarWidth);
  const reduceEffects = useReducedMotion();
  const { startNewConversation } = useAiContext();

  const list = useConversationList();
  const [filter, setFilter] = useState('');
  const [isResizing, setIsResizing] = useState(false);

  const showFilter = list.rows.length > CONVERSATION_FILTER_THRESHOLD;
  // `ConversationList`'s own predicate (`filterConversations`), not a second
  // definition of "matches": the footer states what the list above it is
  // actually showing, filter included, so the two can never read a different
  // count for the same screen.
  const visibleCount = useMemo(
    () => filterConversations(list.rows, filter).length,
    [list.rows, filter],
  );

  // A remembered filter would silently hide conversations from whoever reopens
  // the pane — the space dropdown's rule, applied to the rail.
  useEffect(() => {
    if (treeSidebarCollapsed) setFilter('');
  }, [treeSidebarCollapsed]);

  const handleNewChat = useCallback(() => {
    startNewConversation();
    onNavigate?.();
  }, [startNewConversation, onNavigate]);

  const handleFilterKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key !== 'Escape') return;
      // Two stages: clear the text, then leave the field. Stopped here so the
      // keystroke never reaches a document shortcut listener mid-typing.
      event.stopPropagation();
      if (filter) setFilter('');
      else event.currentTarget.blur();
    },
    [filter],
  );

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsResizing(true);
      const startX = e.clientX;
      const startWidth = treeSidebarWidth;

      function onMouseMove(ev: MouseEvent) {
        setTreeSidebarWidth(startWidth + (ev.clientX - startX));
      }

      function onMouseUp() {
        setIsResizing(false);
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      }

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    },
    [treeSidebarWidth, setTreeSidebarWidth],
  );

  const handleResizeKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setTreeSidebarWidth(treeSidebarWidth - 16);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        setTreeSidebarWidth(treeSidebarWidth + 16);
      } else if (e.key === 'Home') {
        e.preventDefault();
        // 282, the store's default and the tree's own double-click reset.
        setTreeSidebarWidth(282);
      }
    },
    [treeSidebarWidth, setTreeSidebarWidth],
  );

  if (treeSidebarCollapsed) {
    return (
      <AnimatePresence mode="wait">
        {/* <aside>, not <div>: both branches are the same region in two sizes,
            and both are named. */}
        <m.aside
          key="collapsed-conversations-rail"
          aria-label="Conversations"
          data-testid="ai-conversations-sidebar"
          initial={reduceEffects ? false : { width: 0, opacity: 0 }}
          animate={{ width: 40, opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={reduceEffects ? { duration: 0 } : sidebarSpring}
          className="app-sidebar flex flex-col items-center border-r overflow-hidden"
        >
          <button
            type="button"
            onClick={toggleTreeSidebar}
            className="mt-2 flex items-center rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-[var(--glass-pill-hover)] hover:text-foreground"
            aria-label="Expand sidebar"
            title="Expand sidebar (,)"
          >
            <PanelLeft size={16} />
          </button>

          {embedMainNav && <MainNavStripCollapsed onNavigate={onNavigate} />}

          {/* One glyph, and only this one. Never a Delete; never the list.
              Nothing follows it: the tree's collapsed rail ends with an
              `mt-auto` Trash button and the pane has no equivalent
              low-frequency destination, and session chrome lives in the app
              header (#1377/#1378) rather than at the foot of a rail. */}
          <button
            type="button"
            onClick={handleNewChat}
            data-testid="conversations-new-chat"
            className="mt-2 flex items-center rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-[var(--glass-pill-hover)] hover:text-foreground"
            aria-label="New chat"
            title="New chat"
          >
            <SquarePen size={16} />
          </button>
        </m.aside>
      </AnimatePresence>
    );
  }

  return (
    <m.aside
      key="expanded-conversations-sidebar"
      aria-label="Conversations"
      data-testid="ai-conversations-sidebar"
      initial={reduceEffects ? false : { width: 0, opacity: 0 }}
      animate={{ width: treeSidebarWidth, opacity: 1 }}
      transition={reduceEffects || isResizing ? { duration: 0 } : sidebarSpring}
      className={cn(
        'app-sidebar relative flex max-w-full flex-col border-r overflow-hidden',
        isResizing && 'select-none',
      )}
    >
      {/* The 48px chrome row every pane holds: h-12, never py-*, so the panes
          start their content on one y. The hairline that used to run under it
          came off with the rest of the 48px rule (2026-08-31) — the height is
          the alignment now, and toolbar-rule-alignment.test.ts still loops
          over EVERY panel-toolbar row in this file, not just the first.

          Rendered only when this rail owns the destination strip. On desktop
          the chassis rail does (embedMainNav={false}), and then this row does
          not exist — so the collapse button moves into the New chat row below,
          exactly as SidebarTreeView.tsx:1087-1096 moves its own, and that row
          becomes the pane's 48px chrome row instead. Both class branches keep
          the guard honest: the branch that IS the chrome row carries h-12 and
          no py-*. */}
      {embedMainNav && (
      <div className="panel-toolbar flex h-12 shrink-0 items-center gap-1 px-2">
        <MainNavStripExpanded onNavigate={onNavigate} />
        <button
          type="button"
          onClick={toggleTreeSidebar}
          className="flex shrink-0 items-center rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-[var(--glass-pill-hover)] hover:text-foreground"
          aria-label="Collapse sidebar"
          title="Collapse sidebar (,)"
        >
          <PanelLeftClose size={14} />
        </button>
      </div>
      )}

      <div
        className={cn(
          'flex shrink-0 items-center gap-1 px-2',
          embedMainNav ? 'py-2' : 'panel-toolbar h-12',
        )}
      >
        <button
          type="button"
          onClick={handleNewChat}
          data-testid="conversations-new-chat"
          className="nm-button-ghost min-w-0 flex-1 justify-start gap-2"
        >
          <SquarePen size={14} aria-hidden="true" />
          New chat
        </button>
        {!embedMainNav && (
          <button
            type="button"
            onClick={toggleTreeSidebar}
            className="flex shrink-0 items-center rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-[var(--glass-pill-hover)] hover:text-foreground"
            aria-label="Collapse sidebar"
            title="Collapse sidebar (,)"
          >
            <PanelLeftClose size={14} />
          </button>
        )}
      </div>

      {showFilter && (
        <div className="shrink-0 px-2 pb-2">
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={handleFilterKeyDown}
            aria-label="Filter conversations"
            placeholder="Filter conversations"
            className="nm-input h-7 text-[13px]"
          />
        </div>
      )}

      {/* Fragment: the scroller, the degraded strip and Show more land here as
          siblings, so the button is a shrink-0 row rather than scrolling away. */}
      <ConversationList list={list} filter={filter} onNavigate={onNavigate} />

      {/* Loaded row count, and nothing else. SidebarTreeView.tsx:1348's footer
          recipe byte for byte — including its `treeData ? … : ''` shape: the
          count is blank rather than a misleading "0 conversations" until the
          first page has actually loaded. It counts what `ConversationList`
          above it is actually showing (`visibleCount`, the same
          `filterConversations` predicate), not `list.rows.length` — those two
          diverge the moment a filter is active, and the footer exists to
          state what is on screen, not what was fetched. The tree spends its
          right cell on a Trash link and this pane has no equivalent
          low-frequency destination, so the count keeps flex-1 and the cell
          stays empty. No session chrome: theme and account are in the app
          header on every route (#1377/#1378). The rule below sits on the
          row's TOP edge, not its bottom — a second bordered nav-style row
          here would have to carry h-12 and would draw a line where there is
          no chrome. */}
      <div className="panel-toolbar flex shrink-0 items-center gap-2 border-t px-2 py-1.5">
        <span
          data-testid="conversations-footer-count"
          className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground"
        >
          {list.query.isPending
            ? ''
            : `${visibleCount} ${visibleCount === 1 ? 'conversation' : 'conversations'}`}
        </span>
      </div>

      <div
        role="separator"
        aria-label="Resize conversations sidebar"
        aria-orientation="vertical"
        aria-valuemin={180}
        aria-valuemax={600}
        aria-valuenow={treeSidebarWidth}
        aria-valuetext={`${treeSidebarWidth} pixels`}
        tabIndex={0}
        onMouseDown={handleResizeStart}
        onDoubleClick={() => setTreeSidebarWidth(282)}
        onKeyDown={handleResizeKeyDown}
        className={cn(
          'group absolute bottom-0 right-0 top-0 z-10 flex w-2 cursor-col-resize items-center justify-end outline-none',
          'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
        )}
        title="Drag to resize · Double-click to reset"
      >
        <span
          className={cn(
            'h-full w-px bg-transparent transition-colors group-hover:bg-action/45 group-focus-visible:bg-action/55',
            isResizing && 'bg-action/70',
          )}
          aria-hidden="true"
        />
      </div>
    </m.aside>
  );
}
