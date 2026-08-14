import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { BubbleMenu } from '@tiptap/react/menus';
import { useEditorState } from '@tiptap/react';
import { posToDOMRect } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import type { Editor as EditorType } from '@tiptap/react';
import { Sparkles } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useImproveStream } from './use-improve-stream';
import { buildImproveHtml } from './improve-markdown';
import { EditorFormatBar } from './EditorFormatBar';
import { ImprovePanel, type ImprovePanelCopy } from './ImprovePanel';
import { buildInstruction, type QuickAction } from './improve-actions';
import { containsStructuredInline } from './block-menu-nodes';
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
 * Keep the Improve controls attached to the side of the formatting toolbar
 * with the room, rather than letting a growing menu pull the toolbar away from
 * its original anchor. `below` is the intended default; Floating UI reports
 * an above-selection menu after collision handling, which is the cue to grow
 * the controls upward instead.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function improvePanelPlacement(
  menuRect: Pick<DOMRect, 'top' | 'bottom'>,
  selectionRect: Pick<DOMRect, 'top' | 'bottom'>,
): 'above' | 'below' {
  // A shifted menu can overlap the selection by a fraction of a pixel. In
  // that ambiguous case, preserve the default downward disclosure.
  return menuRect.bottom <= selectionRect.top ? 'above' : 'below';
}

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
  // Skip tables and code blocks — dedicated table context toolbar and format
  // controls handle tables, preventing competing Floating UI layout calculations.
  if (editor.isActive('table') || editor.isActive('codeBlock')) return false;
  return true;
}

/**
 * Improve is hidden — not warned about — when the selection carries one of
 * Confluence's inline atoms (`confluenceStatus`, `confluenceUserMention`,
 * `confluenceJiraIssue`). Same predicate, same verdict as #1179's block menu,
 * reached by a different route, so the reasoning is recorded here rather than
 * inherited:
 *
 * - **The loss is data, not presentation.** `containsLossyMarks` only warns
 *   because the words survive and the formatting does not. An atom takes the
 *   *content* with it: which person was mentioned, which Jira issue, what the
 *   status said. That is the class `TEXT_BLOCK_TYPES` exists to protect.
 * - **Warning cannot be honest, because the input is broken too.** `textBetween`
 *   drops the atoms before the request is built, so the model answers a
 *   mutilated prompt — "Ask @jdoe about DONE" is sent as `"Ask  about "`. Even
 *   Insert below, which deletes nothing, would return prose derived from text
 *   the user never wrote. There is no accept path that produces a right answer,
 *   so there is nothing worth offering behind a warning. Worse, a plausible
 *   answer invites the user to insert it and delete the original by hand, which
 *   is the same loss with extra steps.
 * - **The disruption argument runs the other way.** A block target has no
 *   remedy: the menu acts on the whole block, so hiding removes the only route.
 *   A selection is the user's own drag — the remedy is to select around the
 *   macro, and the boundary behaviour of `nodesBetween` makes a range that stops
 *   at the atom clean. Hiding costs *less* here than on the block menu, as long
 *   as the copy says what to do instead. That is the one thing this surface
 *   changes: #1179's "unavailable here" is terminal; ours names the way out.
 *
 * Auto-shrinking the selection past the atom was considered and rejected. It is
 * only well defined when the atom sits at an edge — one in the middle needs two
 * disjoint ranges and `insertContentAt` takes one — and silently improving
 * something other than what the user highlighted is its own surprise.
 *
 * Formatting toggles stay: a mark toggle rewrites marks, not nodes.
 */
const MACRO_NOTICE =
  'Improve is unavailable: a rewrite would drop the inline macros in this selection. Select text around them instead.';

/**
 * Shown in the AI section when an atom lands *inside* the passage after the
 * section opened — a collaborator, an undo, the AI dock. The gate above runs
 * when Improve opens and cannot see that. Replace is the only destructive half,
 * so it is the only half refused; Insert below still preserves everything.
 *
 * **This one renders amber while `MACRO_NOTICE` renders muted, and that is the
 * intended pairing rather than an oversight.** Both are refusals, so the colour
 * is not tracking "refusal vs warning" — it is tracking whether the user is
 * mid-gesture. `MACRO_NOTICE` appears passively as a selection is dragged
 * across a macro, many times a minute, and amber at that frequency is noise.
 * This appears only once the user has opened the section, asked for an answer,
 * and had a control they were reaching for go dead underneath them; that is
 * attention, which is what ADR-010 reserves amber for. It arrives via
 * `ImprovePanel`'s `replaceBlocked` slot, which is shared with #1179's
 * multi-block-heading refusal and is amber for the same reason.
 */
const MACRO_REPLACE_BLOCKED =
  'This passage now contains an inline macro, and replacing would delete it. Insert below instead.';

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
  improvePanelPosition = 'below',
}: {
  editor: EditorType;
  onAiOpenChange?: (open: boolean) => void;
  /** Which side of the toolbar the expanded Improve controls occupy. */
  improvePanelPosition?: 'above' | 'below';
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
    // The gate itself, not a mirror of the render gate: Cmd/Ctrl+J reaches this
    // without going near the trigger, so hiding the button alone would leave the
    // keyboard path opening a section that can only lose macros. See MACRO_NOTICE.
    if (containsStructuredInline(editor.state.doc, from, to)) return;
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
    editor.commands?.focus?.();
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
  }, [editor, aiOpen, improvePanelPosition, stream.status]);

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

  /**
   * The range Improve is about: the decorated passage once the section is open,
   * the live selection before that. Two phases, one predicate — so the trigger
   * disappears as a drag crosses a macro, and the open section keeps watching
   * the passage it captured rather than wherever the caret has since gone.
   */
  const improveRange = useCallback((): { from: number; to: number } | null => {
    const captured = currentRange();
    if (captured) return captured;
    if (editor.isDestroyed) return null;
    const { from, to } = editor.state.selection;
    return from < to ? { from, to } : null;
  }, [editor, currentRange]);

  // Subscribe to the document so this re-evaluates on every selection change
  // and every edit. `useEditorState` compares results, so a selection dragged
  // through plain prose re-renders nothing.
  const dropsMacros = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const range = improveRange();
      return range !== null && containsStructuredInline(e.state.doc, range.from, range.to);
    },
  });

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
    // Re-read from the DOCUMENT, not from `dropsMacros`. The render gate is a
    // React value derived from editor state, so a transaction landing between
    // the last paint and this click leaves it a frame stale — and one frame is
    // all it takes to delete a mention. Unlike #1179's equivalent this is the
    // primary guard for the mid-flight case, not a cross-file backstop, and the
    // test suite drives that exact interleaving.
    if (containsStructuredInline(editor.state.doc, range.from, range.to)) return;
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

  // While the section is open the trigger is also its collapse control, so it
  // stays even if a macro arrives in the passage — hiding it there would strand
  // an expanded panel with no way back and a dangling `aria-controls`. The
  // mid-flight protection is `replaceBlocked` below, not the render gate.
  const showImprove = aiOpen || !dropsMacros;

  return (
    <div
      ref={rootRef}
      data-testid="editor-bubble-menu"
      className={cn(
        'flex nm-card-elevated',
        aiOpen && improvePanelPosition === 'above' ? 'flex-col-reverse' : 'flex-col',
        'motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95',
      )}
    >
      <EditorFormatBar editor={editor} ariaLabel="Selection formatting">
        {showImprove && (
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
        )}
      </EditorFormatBar>

      {/* Deliberately not a live region. This appears and disappears as the
          selection is dragged, so announcing it would chatter over every drag;
          it is read when the user goes looking for the button that is missing.
          Muted, not amber — amber is for a warning the user may act through
          (#1179's mark warning), and this is a refusal. */}
      {!aiOpen && dropsMacros && (
        <p
          data-testid="bubble-menu-macro-notice"
          className="w-72 border-t border-border px-3 py-2 text-xs text-muted-foreground"
        >
          {MACRO_NOTICE}
        </p>
      )}

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
          replaceBlocked={dropsMacros ? MACRO_REPLACE_BLOCKED : null}
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
  const menuRef = useRef<HTMLDivElement>(null);
  const [improvePanelPosition, setImprovePanelPosition] = useState<'above' | 'below'>('below');

  const shouldShow = useCallback(
    ({ editor: e }: { editor: EditorType }) => selectionShouldShow(e, aiOpenRef.current),
    [],
  );

  const updateImprovePanelPosition = useCallback(() => {
    if (!aiOpenRef.current || editor.isDestroyed || !menuRef.current) return;
    const { from, to } = editor.state.selection;
    const next = improvePanelPlacement(
      menuRef.current.getBoundingClientRect(),
      posToDOMRect(editor.view, from, to),
    );
    setImprovePanelPosition((current) => current === next ? current : next);
  }, [editor]);

  const handleAiOpenChange = useCallback((open: boolean) => {
    aiOpenRef.current = open;
    // Every disclosure begins downward. If the preferred bottom placement is
    // unavailable, Floating UI's next update switches this to `above`.
    setImprovePanelPosition('below');
  }, []);

  return (
    <BubbleMenu
      ref={menuRef}
      editor={editor}
      pluginKey={editorBubbleMenuPluginKey}
      shouldShow={shouldShow}
      // A single merged panel, anchored below the selection by default. When
      // its full height cannot fit there, `flip` moves it above the selection;
      // `onUpdate` then puts the AI controls above the toolbar as well. `size`
      // makes the rare too-tall panel scroll inside the viewport instead of
      // escaping it.
      options={{
        placement: 'bottom',
        offset: 8,
        flip: { padding: 8 },
        shift: { padding: 8 },
        size: {
          padding: 8,
          apply({ availableHeight, elements }) {
            elements.floating.style.maxHeight = `${Math.max(0, availableHeight)}px`;
            elements.floating.style.overflowY = 'auto';
          },
        },
        onUpdate: updateImprovePanelPosition,
      }}
      updateDelay={100}
    >
      <BubbleMenuContent
        editor={editor}
        onAiOpenChange={handleAiOpenChange}
        improvePanelPosition={improvePanelPosition}
      />
    </BubbleMenu>
  );
}
