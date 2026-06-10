import { useCallback, useEffect, useRef, useState } from 'react';
import { BubbleMenu } from '@tiptap/react/menus';
import { useEditorState } from '@tiptap/react';
import { posToDOMRect } from '@tiptap/core';
import * as Popover from '@radix-ui/react-popover';
import type { Editor as EditorType } from '@tiptap/react';
import {
  Bold, Italic, Underline, Strikethrough, Code, Highlighter,
  Sparkles, Loader2, Check, ArrowDownToLine, RotateCcw, X,
} from 'lucide-react';
import type { ImprovementType } from '@compendiq/contracts';
import { cn } from '../../lib/cn';
import { SanitizedHtml } from '../SanitizedHtml';
import { useImproveStream } from './use-improve-stream';
import { buildImproveHtml } from './improve-markdown';
import {
  createImproveDecorationPlugin,
  improveDecorationKey,
  setImproveDecoration,
  clearImproveDecoration,
} from './improve-decoration';

/**
 * #708 — Notion-style selection bubble menu for the article editor (edit mode
 * only). Shows core inline-formatting actions plus an "Improve" entry that
 * streams an AI rewrite of ONLY the selected fragment into a popover preview.
 * The document is never mutated until the user accepts (Replace / Insert).
 */

interface QuickAction {
  key: string;
  label: string;
  type: ImprovementType;
  /** Extra instruction passed to `/llm/improve` for tone/length variants. */
  instruction?: string;
}

// Quick actions map onto the backend's five `ImprovementType` values. Tone /
// length variants ride on the optional `instruction` field rather than new
// backend types, keeping v1 within the existing `/llm/improve` contract.
const QUICK_ACTIONS: readonly QuickAction[] = [
  { key: 'improve', label: 'Improve writing', type: 'clarity' },
  { key: 'grammar', label: 'Fix spelling & grammar', type: 'grammar' },
  {
    key: 'shorter', label: 'Make shorter', type: 'clarity',
    instruction: 'Make the passage more concise while preserving all key information.',
  },
  {
    key: 'longer', label: 'Make longer', type: 'completeness',
    instruction: 'Expand the passage with more detail and helpful examples.',
  },
  {
    key: 'professional', label: 'More professional tone', type: 'clarity',
    instruction: 'Rewrite the passage in a more professional, formal tone.',
  },
];

// Selection-specific prompt steering: the `improve_*` system prompts assume a
// whole article, so we pass an instruction that scopes the model to the passage
// and forbids extra commentary. (#708 — "improve the following passage; return
// only the improved passage, same language".)
const SELECTION_INSTRUCTION =
  'You are improving a SHORT SELECTED PASSAGE from a larger document, not the whole document. ' +
  'Return ONLY the improved passage with no preamble, headings, or explanation, and keep it in the same language.';

function buildInstruction(action: QuickAction, freeForm?: string): string {
  const parts = [SELECTION_INSTRUCTION];
  if (action.instruction) parts.push(action.instruction);
  if (freeForm?.trim()) parts.push(freeForm.trim());
  return parts.join('\n\n');
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
  if (aiOpen) return true;
  if (!editor.isEditable) return false;
  if (editor.state.selection.empty) return false;
  // Skip code blocks — formatting marks don't apply and improving code inline
  // isn't the intent here.
  if (editor.isActive('codeBlock')) return false;
  return true;
}

function MenuButton({
  onClick, active, title, children,
}: {
  onClick: () => void;
  active?: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()} // keep editor selection on click
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={cn(
        'flex h-8 w-8 items-center justify-center rounded transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
        active
          ? 'bg-primary/20 text-primary ring-1 ring-primary/30'
          : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

/**
 * The visible menu body. Split out from `EditorBubbleMenu` so it can be tested
 * directly with an editor instance, independent of the TipTap BubbleMenu
 * wrapper (which relies on Floating UI + a ProseMirror plugin that does not
 * render in jsdom). `onAiOpenChange` lets the wrapper mirror AI-popover state
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
  const [freeForm, setFreeForm] = useState('');
  // The action + free-form text of the most recent run, captured so "Try again"
  // replays the user's actual choice rather than a hardcoded default.
  const lastRunRef = useRef<{ action: QuickAction; freeForm: string } | null>(null);
  const stream = useImproveStream();

  // #764 — register the non-destructive selection-decoration plugin for the
  // life of the menu. It stays inert (empty DecorationSet) until `openAi`
  // dispatches the captured range.
  useEffect(() => {
    editor.registerPlugin(createImproveDecorationPlugin());
    return () => { editor.unregisterPlugin(improveDecorationKey); };
  }, [editor]);

  // #764 — Radix virtual anchor that measures the captured selection rect, so
  // the AI popover positions relative to the SELECTION rather than the Improve
  // trigger. The bubble menu floats above the selection, so `side="bottom"`
  // from the trigger would land the popover exactly on top of the selected
  // text; anchored to the selection rect instead, the stack reads predictably
  // top-to-bottom as bubble menu → decorated selection → popover. Measured
  // lazily on every Floating UI update so scrolling stays tracked.
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const selectionAnchorRef = useRef({
    getBoundingClientRect: (): DOMRect => {
      const range = rangeRef.current;
      const e = editorRef.current;
      if (range && !e.isDestroyed) {
        try {
          return posToDOMRect(e.view, range.from, range.to);
        } catch {
          // jsdom / detached view — fall through to the zero rect below.
        }
      }
      const zero = { top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0, x: 0, y: 0 };
      return { ...zero, toJSON: () => zero } as DOMRect;
    },
  });

  // Subscribe to active marks so the formatting buttons re-render their
  // active/pressed state on selection and toggle changes (mirrors EditorToolbar).
  const active = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      strike: e.isActive('strike'),
      code: e.isActive('code'),
      highlight: e.isActive('highlight'),
    }),
  });

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
    setFreeForm('');
    stream.reset();
    setAi(true);
  }, [editor, stream, setAi]);

  const closeAi = useCallback(() => {
    stream.abort();
    stream.reset();
    clearImproveDecoration(editor);
    setAi(false);
    rangeRef.current = null;
    lastRunRef.current = null;
  }, [editor, stream, setAi]);

  // Cmd/Ctrl+J opens the AI popover on the current selection (#708 optional
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

  const runAction = useCallback(
    (action: QuickAction, freeFormText: string) => {
      const range = rangeRef.current;
      if (!range) return;
      const text = editor.state.doc.textBetween(range.from, range.to, '\n');
      if (!text.trim()) return;
      lastRunRef.current = { action, freeForm: freeFormText };
      void stream.run(text, action.type, buildInstruction(action, freeFormText));
    },
    [editor, stream],
  );

  // "Try again" replays the last action with its captured free-form text,
  // falling back to the default quick action if nothing has run yet.
  const retry = useCallback(() => {
    const last = lastRunRef.current;
    if (last) runAction(last.action, last.freeForm);
    else runAction(QUICK_ACTIONS[0]!, freeForm);
  }, [runAction, freeForm]);

  const replaceSelection = useCallback(() => {
    const range = rangeRef.current;
    if (!range || !stream.output) return;
    const { inline } = buildImproveHtml(stream.output);
    editor.chain().focus().insertContentAt({ from: range.from, to: range.to }, inline).run();
    closeAi();
  }, [editor, stream.output, closeAi]);

  const insertBelow = useCallback(() => {
    const range = rangeRef.current;
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
  }, [editor, stream.output, closeAi]);

  const isStreaming = stream.status === 'streaming';
  const hasResult = stream.output.length > 0;
  // The stream finished but produced nothing — surface explicit feedback rather
  // than silently dropping back to the quick-action menu.
  const emptyResult = stream.status === 'done' && !hasResult;
  const { html: previewHtml } = buildImproveHtml(stream.output);

  return (
    <div
      data-testid="editor-bubble-menu"
      className={cn(
        'flex items-center gap-0.5 rounded-lg border border-border bg-card p-1 shadow-lg',
        'motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95',
      )}
      role="toolbar"
      aria-label="Selection formatting"
    >
      <MenuButton
        onClick={() => editor.chain().focus().toggleBold().run()}
        active={active.bold}
        title="Bold (Ctrl+B)"
      >
        <Bold size={15} />
      </MenuButton>
      <MenuButton
        onClick={() => editor.chain().focus().toggleItalic().run()}
        active={active.italic}
        title="Italic (Ctrl+I)"
      >
        <Italic size={15} />
      </MenuButton>
      <MenuButton
        onClick={() => editor.chain().focus().toggleUnderline().run()}
        active={active.underline}
        title="Underline (Ctrl+U)"
      >
        <Underline size={15} />
      </MenuButton>
      <MenuButton
        onClick={() => editor.chain().focus().toggleStrike().run()}
        active={active.strike}
        title="Strikethrough (Ctrl+Shift+X)"
      >
        <Strikethrough size={15} />
      </MenuButton>
      <MenuButton
        onClick={() => editor.chain().focus().toggleCode().run()}
        active={active.code}
        title="Inline code (Ctrl+E)"
      >
        <Code size={15} />
      </MenuButton>
      <MenuButton
        onClick={() => editor.chain().focus().toggleHighlight().run()}
        active={active.highlight}
        title="Highlight (Ctrl+Shift+H)"
      >
        <Highlighter size={15} />
      </MenuButton>

      <div role="separator" aria-orientation="vertical" className="mx-0.5 h-5 w-px bg-border" />

      <Popover.Root open={aiOpen} onOpenChange={(o) => (o ? openAi() : closeAi())}>
        {/* #764 — virtual anchor on the captured selection rect (see
            selectionAnchorRef above); renders no DOM node of its own. */}
        <Popover.Anchor virtualRef={selectionAnchorRef} />
        <Popover.Trigger asChild>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            title="Improve with AI"
            aria-label="Improve with AI"
            data-testid="bubble-ai-trigger"
            className={cn(
              'flex h-8 items-center gap-1 rounded px-2 text-sm font-medium transition-colors',
              'text-primary hover:bg-primary/10',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
            )}
          >
            <Sparkles size={15} />
            <span>Improve</span>
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            // #764 — anchored to the selection rect (virtual anchor above):
            // `side="bottom"` opens BELOW the selection, i.e. under the bubble
            // menu (which floats above it) without covering the decorated text.
            align="start"
            side="bottom"
            sideOffset={8}
            collisionPadding={12}
            data-testid="bubble-ai-popover"
            // Keep focus inside; closing is explicit (Discard / Escape).
            onOpenAutoFocus={(e) => { if (hasResult || isStreaming) e.preventDefault(); }}
            className={cn(
              'z-50 w-80 rounded-lg border border-border bg-card p-3 shadow-xl outline-none',
              'motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95',
            )}
          >
            {!hasResult && !isStreaming && !emptyResult && stream.status !== 'error' && (
              <div className="flex flex-col gap-2">
                <input
                  type="text"
                  value={freeForm}
                  autoFocus
                  onChange={(e) => setFreeForm(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && freeForm.trim()) {
                      e.preventDefault();
                      runAction(QUICK_ACTIONS[0]!, freeForm);
                    }
                  }}
                  placeholder="Ask AI to edit the selection…"
                  aria-label="Ask AI to edit the selection"
                  className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                />
                <div className="flex flex-col gap-0.5">
                  {QUICK_ACTIONS.map((action) => (
                    <button
                      key={action.key}
                      type="button"
                      onClick={() => runAction(action, freeForm)}
                      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    >
                      <Sparkles size={14} className="text-primary" />
                      {action.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {(isStreaming || hasResult) && (
              <div className="flex flex-col gap-2">
                <div
                  data-testid="bubble-ai-preview"
                  aria-live="polite"
                  className={cn(
                    'prose prose-sm max-h-56 max-w-none overflow-y-auto rounded-md border border-border/60 bg-background p-2 text-sm',
                    isStreaming && !hasResult && 'motion-safe:animate-pulse',
                  )}
                >
                  {hasResult
                    ? <SanitizedHtml html={previewHtml} />
                    : <span className="text-muted-foreground">Improving selection…</span>}
                </div>

                <div className="flex flex-wrap items-center gap-1">
                  <button
                    type="button"
                    onClick={replaceSelection}
                    disabled={!hasResult || isStreaming}
                    title="Replace selection"
                    className="flex items-center gap-1 rounded-md bg-primary/15 px-2 py-1 text-xs font-medium text-primary hover:bg-primary/25 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  >
                    <Check size={13} /> Replace
                  </button>
                  <button
                    type="button"
                    onClick={insertBelow}
                    disabled={!hasResult || isStreaming}
                    title="Insert below selection"
                    className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-foreground/5 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  >
                    <ArrowDownToLine size={13} /> Insert below
                  </button>
                  <button
                    type="button"
                    onClick={retry}
                    disabled={isStreaming}
                    title="Try again"
                    className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-foreground/5 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  >
                    <RotateCcw size={13} /> Try again
                  </button>
                  <button
                    type="button"
                    onClick={closeAi}
                    title="Discard"
                    className="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  >
                    <X size={13} /> Discard
                  </button>
                </div>
              </div>
            )}

            {isStreaming && (
              <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 size={13} className="motion-safe:animate-spin" />
                Streaming…
              </div>
            )}

            {emptyResult && (
              <div className="flex flex-col gap-2" data-testid="bubble-ai-empty">
                <p className="text-sm text-muted-foreground" role="status">
                  No changes returned. Try again or adjust your request.
                </p>
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={retry}
                    title="Try again"
                    className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  >
                    <RotateCcw size={13} /> Try again
                  </button>
                  <button
                    type="button"
                    onClick={closeAi}
                    title="Discard"
                    className="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  >
                    <X size={13} /> Discard
                  </button>
                </div>
              </div>
            )}

            {stream.status === 'error' && (
              <div className="flex flex-col gap-2">
                <p className="text-sm text-destructive" role="alert">{stream.error}</p>
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={retry}
                    className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  >
                    <RotateCcw size={13} /> Try again
                  </button>
                  <button
                    type="button"
                    onClick={closeAi}
                    className="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  >
                    <X size={13} /> Close
                  </button>
                </div>
              </div>
            )}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}

export function EditorBubbleMenu({ editor }: { editor: EditorType }) {
  // Mirror the AI-popover open state in a ref so the stable `shouldShow`
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
      shouldShow={shouldShow}
      options={{ placement: 'top' }}
      updateDelay={100}
    >
      <BubbleMenuContent editor={editor} onAiOpenChange={(open) => { aiOpenRef.current = open; }} />
    </BubbleMenu>
  );
}
