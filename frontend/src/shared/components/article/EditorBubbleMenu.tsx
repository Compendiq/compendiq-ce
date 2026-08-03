import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { BubbleMenu } from '@tiptap/react/menus';
import { PluginKey } from '@tiptap/pm/state';
import type { Editor as EditorType } from '@tiptap/react';
import { Sparkles } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useImproveStream } from './use-improve-stream';
import { buildImproveHtml } from './improve-markdown';
import { EditorFormatBar } from './EditorFormatBar';
import { ImprovePanel, type ImprovePanelCopy } from './ImprovePanel';
import { buildInstruction, type QuickAction } from './improve-actions';
import { hasBlockMenuTarget } from './block-menu-decoration';
import {
  createImproveDecorationPlugin,
  improveDecorationKey,
  setImproveDecoration,
  clearImproveDecoration,
} from './improve-decoration';

/**
 * #708 / #782 — Notion-style selection bubble menu for the article editor
 * (edit mode only). A SINGLE floating panel: core inline-formatting actions in
 * a toolbar row, plus an "Improve" entry that expands the SAME container in
 * place into the AI section (prompt input, quick actions, streamed preview,
 * accept controls). The AI rewrite targets ONLY the selected fragment and the
 * document is never mutated until the user accepts (Replace / Insert).
 *
 * Before #782 the AI section was a separate Radix Popover portalled to <body>
 * and anchored below the selection — two disconnected popups stacked around
 * the selected text. Now everything rides the one TipTap BubbleMenu container
 * (Floating UI: placement top, flip/shift on collision); the selection stays
 * visible below the panel via the #764 decoration.
 */

/**
 * Plugin key for the bubble-menu Floating UI plugin. Exported so the content
 * can ask the plugin to recompute its position when the panel changes size
 * (the plugin repositions on selection/doc/scroll/resize, but does not observe
 * the floating element itself). Documented mechanism:
 * `editor.view.dispatch(editor.state.tr.setMeta(pluginKey, 'updatePosition'))`.
 */
// eslint-disable-next-line react-refresh/only-export-components
export const editorBubbleMenuPluginKey = new PluginKey('editorBubbleMenu');

/**
 * Whether the selection bubble menu should be visible. Exported for unit
 * testing the show/hide contract (the BubbleMenu plugin calls this on every
 * selection change). When `aiOpen` is true the menu stays mounted regardless
 * of editor focus/selection — that is the BubbleMenu focus pitfall fix: the AI
 * input steals focus from the editor, which would otherwise hide the menu.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function selectionShouldShow(editor: EditorType, aiOpen: boolean): boolean {
  // #1179 — the block context menu owns the interaction while it is open, and
  // its text actions select the whole block. That selection is non-empty, so
  // without this the bubble menu would render a second panel on top of it.
  // Checked before `aiOpen` so an AI section left open behind the block menu
  // cannot force the bubble menu back into view either.
  if (hasBlockMenuTarget(editor)) return false;
  if (aiOpen) return true;
  if (!editor.isEditable) return false;
  if (editor.state.selection.empty) return false;
  // Skip code blocks — formatting marks don't apply and improving code inline
  // isn't the intent here.
  if (editor.isActive('codeBlock')) return false;
  return true;
}

const SELECTION_COPY: ImprovePanelCopy = {
  ariaLabel: 'Improve selection with AI',
  placeholder: 'Ask AI to edit the selection…',
  inputLabel: 'Ask AI to edit the selection',
  replaceTitle: 'Replace selection',
  insertTitle: 'Insert below selection',
  pendingLabel: 'Improving selection…',
};

/**
 * The visible menu body. Split out from `EditorBubbleMenu` so it can be tested
 * directly with an editor instance, independent of the TipTap BubbleMenu
 * wrapper (which relies on Floating UI + a ProseMirror plugin that does not
 * render in jsdom). `onAiOpenChange` lets the wrapper mirror AI-section state
 * into `shouldShow`.
 */
export function BubbleMenuContent({
  editor,
  onAiOpenChange,
}: {
  editor: EditorType;
  onAiOpenChange?: (open: boolean) => void;
}) {
  const [aiOpen, setAiOpen] = useState(false);
  // Range captured the moment "Improve" is clicked, so Replace/Insert act on
  // the original selection even after focus moves or the selection collapses.
  const rangeRef = useRef<{ from: number; to: number } | null>(null);
  const stream = useImproveStream();
  const rootRef = useRef<HTMLDivElement>(null);
  const aiPanelId = useId();

  // #764 — register the non-destructive selection-decoration plugin for the
  // life of the menu. It stays inert (empty DecorationSet) until `openAi`
  // dispatches the captured range. TipTap guards `unregisterPlugin` against a
  // destroyed editor internally, but not `registerPlugin` — hence the check.
  useEffect(() => {
    if (editor.isDestroyed) return;
    editor.registerPlugin(createImproveDecorationPlugin());
    return () => { editor.unregisterPlugin(improveDecorationKey); };
  }, [editor]);

  const setAi = useCallback((open: boolean) => {
    setAiOpen(open);
    onAiOpenChange?.(open);
  }, [onAiOpenChange]);

  const openAi = useCallback(() => {
    const { from, to } = editor.state.selection;
    if (from === to) return;
    rangeRef.current = { from, to };
    // #764 — the AI input is about to steal focus, which blurs the editor and
    // hides the native selection highlight. Decorate the captured range so the
    // passage stays visibly marked (no document mutation).
    setImproveDecoration(editor, { from, to });
    stream.reset();
    setAi(true);
  }, [editor, stream, setAi]);

  const closeAi = useCallback(() => {
    stream.abort();
    stream.reset();
    clearImproveDecoration(editor);
    setAi(false);
    rangeRef.current = null;
  }, [editor, stream, setAi]);

  // Cmd/Ctrl+J expands the AI section on the current selection (#708 optional
  // keyboard trigger).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        if (!editor.isEditable || editor.state.selection.empty) return;
        e.preventDefault();
        openAi();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [editor, openAi]);

  // #782 — dismissal was previously Radix Popover's job. Escape and
  // outside-pointerdown collapse the AI section (abort + clear decoration);
  // clicks inside the merged panel (toolbar row included) never dismiss.
  useEffect(() => {
    if (!aiOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // A layer stacked above us (modal, dropdown) already consumed this
      // Escape — don't double-dismiss.
      if (e.defaultPrevented) return;
      // The Escape belongs to a foreign floating layer (dialog / Radix popper
      // portalled to <body>) that is open above the editor — let it close
      // itself instead of swallowing the key here.
      const root = rootRef.current;
      const foreignLayer = (e.target as Element | null)?.closest?.(
        '[role="dialog"], [role="alertdialog"], [data-radix-popper-content-wrapper]',
      );
      if (foreignLayer && !(root && root.contains(foreignLayer))) return;
      e.preventDefault();
      closeAi();
    };
    const onPointerDown = (e: PointerEvent) => {
      const root = rootRef.current;
      if (root && e.target instanceof Node && !root.contains(e.target)) closeAi();
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [aiOpen, closeAi]);

  // #782 — the BubbleMenu plugin repositions on selection/doc changes, scroll
  // and window resize, but it does NOT observe the floating element's own
  // size. Expanding/collapsing the AI section and the preview growing while
  // streaming change the panel height, so ask the plugin to re-run Floating UI
  // (flip/shift re-pick the side with room) via its documented
  // `updatePosition` transaction meta. Layout effect so the reposition happens
  // in the same frame as the DOM growth (no flash over the selection).
  useLayoutEffect(() => {
    if (editor.isDestroyed) return;
    editor.view.dispatch(editor.state.tr.setMeta(editorBubbleMenuPluginKey, 'updatePosition'));
  }, [editor, aiOpen, stream.status]);

  // The streamed preview grows on EVERY SSE chunk; dispatching a reposition
  // transaction per chunk would run a full state apply + Floating UI
  // computePosition each time. Coalesce via requestAnimationFrame — at most
  // one dispatch per frame (re-scheduling within a frame keeps the same
  // next-paint slot), cancelled on unmount. Open/close and status transitions
  // above stay layout-effect-synchronous so expansion never flashes over the
  // selection; only this high-frequency path is throttled.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (editor.isDestroyed) return;
      editor.view.dispatch(editor.state.tr.setMeta(editorBubbleMenuPluginKey, 'updatePosition'));
    });
    return () => cancelAnimationFrame(frame);
  }, [editor, stream.output]);

  // #764 — the decoration set is remapped through every transaction (see
  // improve-decoration.ts), while `rangeRef` keeps the offsets captured when
  // the AI section opened. Read the live range from the decoration so actions
  // track the passage even if the document changed while the section was
  // open; fall back to the captured range when no decoration exists.
  const currentRange = useCallback((): { from: number; to: number } | null => {
    if (editor.isDestroyed) return null;
    const deco = improveDecorationKey.getState(editor.state)?.find()[0];
    if (deco) return { from: deco.from, to: deco.to };
    // No decoration left: the passage was deleted while the section was open —
    // #1179's block menu makes that a single click. The captured offsets now
    // point into a shorter document, so clamp them and refuse rather than hand
    // an out-of-range range to `insertContentAt`, which throws.
    const captured = rangeRef.current;
    if (!captured) return null;
    const max = editor.state.doc.content.size;
    const from = Math.min(captured.from, max);
    const to = Math.min(captured.to, max);
    return from < to ? { from, to } : null;
  }, [editor]);

  const runAction = useCallback(
    (action: QuickAction, freeFormText: string) => {
      const range = currentRange();
      if (!range) return;
      const text = editor.state.doc.textBetween(range.from, range.to, '\n');
      if (!text.trim()) return;
      void stream.run(text, action.type, buildInstruction(action, freeFormText));
    },
    [editor, stream, currentRange],
  );

  const replaceSelection = useCallback(() => {
    const range = currentRange();
    if (!range || !stream.output) return;
    const { inline } = buildImproveHtml(stream.output);
    editor.chain().focus().insertContentAt({ from: range.from, to: range.to }, inline).run();
    closeAi();
  }, [editor, stream.output, closeAi, currentRange]);

  const insertBelow = useCallback(() => {
    const range = currentRange();
    if (!range || !stream.output) return;
    const { html } = buildImproveHtml(stream.output);
    // Insert block HTML at the end of the selection so the original passage is
    // preserved. Caveat: when the selection ends mid-block (e.g. mid-sentence),
    // ProseMirror splits the containing block to place the new block-level
    // node, so the remainder of the paragraph moves below the insertion. This
    // matches Notion's "Insert below" (it always produces a new block) and is
    // the expected outcome for a block-level insert; we keep it as-is rather
    // than constraining selections to block boundaries.
    editor.chain().focus().insertContentAt(range.to, html).run();
    closeAi();
  }, [editor, stream.output, closeAi, currentRange]);

  return (
    <div
      ref={rootRef}
      data-testid="editor-bubble-menu"
      className={cn(
        'flex flex-col rounded-lg border border-border bg-card shadow-lg',
        'motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95',
      )}
    >
      <EditorFormatBar editor={editor} ariaLabel="Selection formatting">
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()} // keep editor selection on click
          onClick={() => (aiOpen ? closeAi() : openAi())}
          title="Improve with AI"
          aria-label="Improve with AI"
          aria-expanded={aiOpen}
          aria-controls={aiOpen ? aiPanelId : undefined}
          data-testid="bubble-ai-trigger"
          className={cn(
            'flex h-8 items-center gap-1 rounded px-2 text-sm font-medium transition-colors',
            'text-primary hover:bg-primary/10',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
            aiOpen && 'bg-primary/10',
          )}
        >
          <Sparkles size={15} />
          <span>Improve</span>
        </button>
      </EditorFormatBar>

      {/* #782 — the AI section expands the SAME container in place (below the
          toolbar row) instead of opening a second portalled popover on the
          other side of the selection. The container floats above the selection
          (placement 'top' on the wrapper), so growing downward is re-anchored
          by the updatePosition effect and never covers the decorated text. */}
      {aiOpen && (
        <ImprovePanel
          id={aiPanelId}
          testIdPrefix="bubble-ai"
          copy={SELECTION_COPY}
          stream={stream}
          onRun={runAction}
          onReplace={replaceSelection}
          onInsertBelow={insertBelow}
          onClose={closeAi}
          className="w-80"
        />
      )}
    </div>
  );
}

export function EditorBubbleMenu({ editor }: { editor: EditorType }) {
  // Mirror the AI-section open state in a ref so the stable `shouldShow`
  // closure passed to the BubbleMenu plugin keeps the menu mounted while the
  // AI input has focus.
  const aiOpenRef = useRef(false);

  const shouldShow = useCallback(
    ({ editor: e }: { editor: EditorType }) => selectionShouldShow(e, aiOpenRef.current),
    [],
  );

  return (
    <BubbleMenu
      editor={editor}
      pluginKey={editorBubbleMenuPluginKey}
      shouldShow={shouldShow}
      // #782 — single merged panel, single Floating UI anchor (the selection).
      // Primary side is 'top' so the decorated passage stays readable below
      // the panel; `flip` drops it below the selection when the expanded panel
      // runs out of room above, and `shift` keeps it on-screen horizontally.
      // 8px viewport padding mirrors the old Radix collisionPadding intent.
      options={{
        placement: 'top',
        offset: 8,
        flip: { padding: 8 },
        shift: { padding: 8 },
      }}
      updateDelay={100}
    >
      <BubbleMenuContent editor={editor} onAiOpenChange={(open) => { aiOpenRef.current = open; }} />
    </BubbleMenu>
  );
}
