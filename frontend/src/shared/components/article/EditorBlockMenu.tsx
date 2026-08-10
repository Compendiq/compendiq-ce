import { useCallback, useEffect, useId, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { useEditorState } from '@tiptap/react';
import type { Editor as EditorType } from '@tiptap/react';
import type { Node as PMNode } from '@tiptap/pm/model';
import DragHandle from '@tiptap/extension-drag-handle-react';
import { GripVertical, Sparkles, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '../../lib/cn';
import { useImproveStream } from './use-improve-stream';
import { buildImproveHtml } from './improve-markdown';
import { EditorFormatBar } from './EditorFormatBar';
import { ImprovePanel, type ImprovePanelCopy } from './ImprovePanel';
import { buildInstruction, BLOCK_INSTRUCTION, type QuickAction } from './improve-actions';
import {
  blockLabel, containsLossyMarks, containsStructuredInline, supportsTextActions,
} from './block-menu-nodes';
import { blockMenuTargetKey, blockMenuTargetRange } from './block-menu-decoration';
import { absorbBlockMenuEscape, useBlockMenuTarget } from './use-block-menu-target';

/**
 * #1179 — right-click menu on the editor's block drag handle.
 *
 * The handle (#49) was drag-only. Right-clicking it now opens a block-scoped
 * command surface: the bubble menu's inline formatting and its "Improve with
 * AI" section, plus a Delete that removes the whole block — the only way in the
 * editor to delete a macro, diagram or image block without hand-selecting it.
 *
 * Three things make this safe rather than merely possible:
 *
 * - **Text actions are hidden, not disabled, for anything that is not a
 *   paragraph / heading / quote / list item** (`block-menu-nodes.ts`). Improve
 *   ends in an `insertContentAt` of Markdown-derived HTML; over a structured
 *   Confluence node that is silent content loss on the next Save.
 * - **Text actions select the block's *content*** (`pos + 1` … `pos + size - 1`),
 *   never the node — so improving an `h2` cannot flatten it to a paragraph.
 *   `NodeSelection` semantics are reserved for Delete, which works on the node
 *   range directly without ever putting one in the editor state.
 * - **The position is remapped, not remembered.** The drag-handle plugin hands
 *   over a plain `pos` that any edit invalidates, so the menu marks the block
 *   with a decoration (`block-menu-decoration.ts`) and reads the live range
 *   back on every action. That marker is also how `selectionShouldShow` knows
 *   to keep the selection bubble menu out of the way, and how the user sees
 *   which block the menu is about to act on.
 *
 * Mouse-only by design (recorded on the issue): the handle is created
 * imperatively by the drag-handle library and is only ever positioned by
 * `mousemove`, so it cannot be reached by keyboard. Nothing becomes
 * keyboard-inaccessible as a result, but the two halves get there differently.
 * The formatting toggles and Improve are the selection bubble menu's own
 * actions, and that menu is fully keyboard-operable. Delete has no bubble-menu
 * equivalent; its keyboard path is ProseMirror's own — arrow onto a block to
 * make a `NodeSelection`, or Backspace from the start of the block after it.
 * This menu is a faster route to that, not the only one.
 */

const BLOCK_COPY: ImprovePanelCopy = {
  ariaLabel: 'Improve block with AI',
  placeholder: 'Ask AI to edit this block…',
  inputLabel: 'Ask AI to edit this block',
  replaceTitle: 'Replace block content',
  insertTitle: 'Insert below block',
  pendingLabel: 'Improving block…',
};

/**
 * The menu body. Split out from the handle wrapper so it can be tested with a
 * real editor — the drag-handle plugin resolves its node from `mousemove`
 * coordinates and `getBoundingClientRect`, neither of which exists in jsdom.
 */
export function EditorBlockMenu({
  editor,
  pos,
  node,
  onClose,
}: {
  editor: EditorType;
  /** Position of the target block when the menu opened. */
  pos: number;
  /** The target block when the menu opened — its type drives what is offered. */
  node: PMNode;
  onClose: () => void;
}) {
  const [aiOpen, setAiOpen] = useState(false);
  const stream = useImproveStream();
  const aiPanelId = useId();
  const label = blockLabel(node);
  const textActions = supportsTextActions(node);

  /**
   * The target block's live range. The marker plugin remaps it through every
   * transaction, so this stays right while the menu is open, and goes `null`
   * once the block is gone — which is exactly when every action must refuse
   * rather than act on whatever slid into the old offsets. The `pos` snapshot
   * is used only when no marker plugin is registered at all.
   */
  const nodeRange = useCallback((): { from: number; to: number } | null => {
    if (editor.isDestroyed) return null;
    if (blockMenuTargetKey.getState(editor.state) === undefined) {
      const end = pos + node.nodeSize;
      return end <= editor.state.doc.content.size ? { from: pos, to: end } : null;
    }
    return blockMenuTargetRange(editor);
  }, [editor, pos, node]);

  /** The block's inline content — what formatting and Improve act on. */
  const contentRange = useCallback((): { from: number; to: number } | null => {
    const range = nodeRange();
    if (!range || range.to - range.from < 2) return null;
    return { from: range.from + 1, to: range.to - 1 };
  }, [nodeRange]);

  // Subscribe to the document so the menu closes itself if the block is
  // removed underneath it (undo, a collaborator, the AI dock) and so Improve
  // disappears from an emptied block rather than opening a panel that has
  // nothing to send.
  const live = useEditorState({
    editor,
    selector: () => {
      const range = contentRange();
      const { doc } = editor.state;
      return {
        // `DecorationSet.map` drops a node decoration whenever its node is
        // replaced — measured, including a swap to a different node type of
        // exactly the same span (`paragraph('xy')` and `blockquote(paragraph())`
        // are both nodeSize 4). So "the marker is still there" already means
        // "it is still the block this menu was opened on"; an extra node-type
        // comparison here would be dead code. The test file pins the outcome.
        present: nodeRange() !== null,
        hasText: range !== null
          && doc.textBetween(range.from, range.to, '\n').trim().length > 0,
        // Improve rewrites the whole content range from Markdown, which drops
        // any inline Confluence macro sitting in it. See containsStructuredInline.
        dropsMacros: range !== null && containsStructuredInline(doc, range.from, range.to),
        // Warned about rather than hidden — see containsLossyMarks.
        dropsLinks: range !== null && containsLossyMarks(doc, range.from, range.to),
      };
    },
  });

  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!live.present) closeRef.current();
  }, [live.present]);

  // The menu is portalled and unmounts the moment the popover closes — Escape,
  // an outside click, Delete. `useImproveStream` has no unmount abort of its
  // own, so without this an in-flight Improve would keep streaming into a
  // component nobody can see. `abort` is a stable `useCallback`.
  const { abort } = stream;
  useEffect(() => () => { abort(); }, [abort]);

  const openAi = useCallback(() => {
    stream.reset();
    setAiOpen(true);
  }, [stream]);

  /** Collapse the AI section back to the command list (the Discard button). */
  const closeAi = useCallback(() => {
    stream.abort();
    stream.reset();
    setAiOpen(false);
  }, [stream]);

  const runAction = useCallback((action: QuickAction, freeForm: string) => {
    const range = contentRange();
    if (!range) return;
    const text = editor.state.doc.textBetween(range.from, range.to, '\n');
    if (!text.trim()) return;
    void stream.run(text, action.type, buildInstruction(action, freeForm, BLOCK_INSTRUCTION));
  }, [editor, stream, contentRange]);

  /**
   * Whether the model answered with more than one block. `unwrapSingleParagraph`
   * only strips a wrapper when the answer is exactly one paragraph; otherwise it
   * hands back the block-level HTML unchanged, which is precisely the case that
   * cannot be written into a heading's inline content.
   */
  const multiBlockAnswer = useCallback((): boolean => {
    if (!stream.output) return false;
    const { inline, html } = buildImproveHtml(stream.output);
    return inline === html.trim();
  }, [stream.output]);

  /**
   * Replacing a heading's content range with block-level HTML does not fill the
   * heading — ProseMirror lifts the blocks out and the `h2` is gone (or becomes
   * an `h1`, or a list). "Make longer" on a heading hits this every time, and a
   * heading demoted to body text silently breaks the page's TOC and anchors on
   * the next Save. Other allowed types are safe: `blockquote` and `listItem`
   * take block content by schema, and a `paragraph` becoming paragraphs is the
   * point of the action. So this refuses only where it must, and Insert below
   * stays available, which loses nothing.
   */
  const replaceWouldDestroyBlock = node.type.name === 'heading' && multiBlockAnswer();

  const replaceBlocked = replaceWouldDestroyBlock
    ? 'That answer is more than one block, so replacing would turn this heading into body text. Insert it below instead.'
    : null;

  const replaceBlockContent = useCallback(() => {
    const range = contentRange();
    if (!range || !stream.output) return;
    // Backstop for a CROSS-FILE contract, not a stale-render guard: the render
    // gate derives from React state, so it cannot go stale against this click
    // the way a document-derived range can. What it defends is `ImprovePanel`
    // continuing to honour `replaceBlocked` — a shared component this file does
    // not own. No behavioural test can reach it while the panel disables the
    // button (adversarial review confirmed the mutant survives), which is the
    // price of it being a backstop rather than the primary gate.
    if (replaceWouldDestroyBlock) return;
    const { inline } = buildImproveHtml(stream.output);
    // The range is the block's CONTENT, so a single-paragraph answer replaces
    // the text and leaves the node alone — an improved `h2` is still an `h2`.
    editor.chain().focus().insertContentAt({ from: range.from, to: range.to }, inline).run();
    onClose();
  }, [editor, stream.output, contentRange, onClose, replaceWouldDestroyBlock]);

  const insertBelowBlock = useCallback(() => {
    const range = nodeRange();
    if (!range || !stream.output) return;
    const { html } = buildImproveHtml(stream.output);
    // The node's end, not the content's — a block-level insert here lands
    // after the whole block instead of splitting it in two.
    editor.chain().focus().insertContentAt(range.to, html).run();
    onClose();
  }, [editor, stream.output, nodeRange, onClose]);

  const deleteBlock = useCallback(() => {
    const range = nodeRange();
    if (!range) return;

    // `deleteRange`, not `delete`: it widens to a range the schema can actually
    // lose, so removing a container's last child takes the empty container with
    // it, and emptying the whole document leaves the bare paragraph that a
    // `block+` doc requires rather than an invalid empty one.
    //
    // An earlier revision special-cased "this is the only block" and swapped in
    // a fresh paragraph by hand. That branch was removed because it was dead:
    // measured against `deleteRange` over a sole paragraph, heading, atom,
    // blockquote, list, table, figure, layout, panel, code block and rule, the
    // two produce byte-identical documents AND the same selection.
    // `EditorBlockMenu.test.tsx` pins the invariant itself instead, which is
    // what actually has to hold if ProseMirror's fitting ever changes.
    try {
      editor.chain().focus().deleteRange({ from: range.from, to: range.to }).run();

      // No confirmation dialog: the block is outlined in the document while the
      // menu is open, so the user can see what they are removing, and nothing
      // reaches Confluence until Save. An undo affordance is the proportionate
      // safety net for a three-step deliberate gesture.
      toast.success(`${label} deleted`, {
        // The toast outlives the menu and can outlive the editor — leaving edit
        // mode or navigating away destroys it while this is still on screen.
        action: { label: 'Undo', onClick: () => { if (!editor.isDestroyed) editor.commands.undo(); } },
      });
    } finally {
      // Whatever happened, the menu must close: it owns the target marker and
      // the drag-handle lock, and leaving either set strands the editor — the
      // bubble menu suppressed and the handle frozen for the rest of the session.
      onClose();
    }
  }, [editor, nodeRange, label, onClose]);

  const showImprove = textActions && live.hasText && !live.dropsMacros;

  return (
    <div data-testid="editor-block-menu" className="flex w-72 flex-col py-1.5">
      <p
        className="truncate px-4 pt-1 pb-1.5 font-display text-[0.6875rem] font-medium uppercase tracking-[0.08em] text-muted-foreground"
        data-testid="block-menu-label"
      >
        {label}
      </p>

      {textActions ? (
        <>
          <EditorFormatBar
            editor={editor}
            ariaLabel="Block formatting"
            getRange={contentRange}
            // `px-2` puts the toggles' icon column on the same 16px axis as the
            // Improve and Delete rows below (twMerge drops the base `p-1`'s
            // horizontal half and keeps its vertical one).
            className="px-2"
          />

          {showImprove && (
            <button
              type="button"
              onClick={() => (aiOpen ? closeAi() : openAi())}
              aria-expanded={aiOpen}
              aria-controls={aiOpen ? aiPanelId : undefined}
              data-testid="block-ai-trigger"
              className={cn(
                'mx-2 mt-0.5 flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-medium transition-colors',
                'text-primary hover:bg-primary/10',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                aiOpen && 'bg-primary/10',
              )}
            >
              <Sparkles size={15} />
              <span>Improve with AI</span>
            </button>
          )}

          {textActions && live.dropsMacros && (
            <p className="px-4 pb-1 text-xs text-muted-foreground">
              Improve is unavailable here: a rewrite would drop this block&rsquo;s
              inline macros.
            </p>
          )}

          {showImprove && live.dropsLinks && (
            <p className="px-4 pb-1 text-xs text-warning" data-testid="block-menu-link-warning">
              Only plain text is sent — links, code spans and highlights in this
              block will not survive a rewrite.
            </p>
          )}
        </>
      ) : (
        <p className="px-4 pb-1 text-xs text-muted-foreground">
          Formatting and AI editing apply to text blocks only.
        </p>
      )}

      {/* Expands the SAME container in place rather than stacking a second
          floating panel, matching what #782 settled for the bubble menu. Radix
          re-runs Floating UI when the content resizes, so the popover keeps
          itself on screen as the panel grows. */}
      {aiOpen && (
        <ImprovePanel
          id={aiPanelId}
          testIdPrefix="block-ai"
          copy={BLOCK_COPY}
          stream={stream}
          onRun={runAction}
          onReplace={replaceBlockContent}
          onInsertBelow={insertBelowBlock}
          onClose={closeAi}
          replaceBlocked={replaceBlocked}
          className="mt-1.5"
        />
      )}

      {!aiOpen && (
        <>
          <div role="separator" className="mx-2 my-1.5 h-px bg-border" />
          <button
            type="button"
            onClick={deleteBlock}
            data-testid="block-menu-delete"
            className={cn(
              'mx-2 flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-medium',
              // One shared destructive treatment — see nm-action-destructive.
              'nm-action-destructive',
            )}
          >
            <Trash2 size={15} />
            <span>Delete block</span>
          </button>
        </>
      )}
    </div>
  );
}

/**
 * The drag handle plus its context menu. Owns the marker plugin, the handle
 * lock, and the Radix popover; the menu body above owns everything else.
 */
export function EditorBlockHandle({ editor }: { editor: EditorType }) {
  // Open/close state plus the two editor-level side effects it owns — marking
  // the target block and freezing the handle — live in the hook so they can be
  // tested. This component cannot be: the drag-handle plugin resolves its node
  // from pointer coordinates, which jsdom never produces.
  const { target, setHovered, open: openTarget, close: closeMenu } = useBlockMenuTarget(editor);
  const open = target !== null;

  // MUST be stable: the drag-handle component lists `onNodeChange` in the
  // effect deps that register/unregister its ProseMirror plugin, so an inline
  // arrow would tear the plugin down and rebuild it on every render.
  const handleNodeChange = useCallback(
    ({ node, pos }: { node: PMNode | null; pos: number }) => {
      setHovered(node && pos >= 0 ? { node, pos } : null);
    },
    [setHovered],
  );

  const openMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    openTarget();
  }, [openTarget]);

  return (
    <DragHandle editor={editor} className="drag-handle" onNodeChange={handleNodeChange}>
      <Popover.Root open={open} onOpenChange={(next) => { if (!next) closeMenu(); }}>
        <Popover.Anchor asChild>
          <span
            className="flex h-full w-full items-center justify-center"
            data-block-menu-open={open ? 'true' : undefined}
            data-testid="drag-handle-trigger"
            title="Drag to move · Right-click for block actions"
            onContextMenu={openMenu}
          >
            <GripVertical size={16} />
          </span>
        </Popover.Anchor>

        {target && (
          <Popover.Portal>
            <Popover.Content
              side="right"
              align="start"
              sideOffset={8}
              collisionPadding={12}
              aria-label={`${blockLabel(target.node)} block actions`}
              data-testid="editor-block-menu-content"
              className={cn(
                'nm-card-elevated editor-block-menu z-50 overflow-hidden',
                'motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95',
              )}
              // Every action chain ends in `editor.chain().focus()`, which moves
              // focus out of the popover. Radix reads that as an interaction
              // outside the layer and would dismiss the menu after a single
              // Bold — so focus leaving is explicitly not a dismissal here.
              // Escape and an outside pointerdown still close it.
              onFocusOutside={(event) => event.preventDefault()}
              // Escape must not reach `document` — see absorbBlockMenuEscape.
              // Not `onKeyDown`: bypassed when Radix unmounts this layer in its
              // capture pass, and again when the key comes from outside the
              // layer, so its handler never runs in most of the grid.
              // `preventDefault` is what the page's shortcut reads since #1206;
              // `stopPropagation` keeps the key off every other document
              // listener. Both measured across the full grid.
              onEscapeKeyDown={(event) => absorbBlockMenuEscape(event, closeMenu)}
            >
              <EditorBlockMenu
                editor={editor}
                pos={target.pos}
                node={target.node}
                onClose={closeMenu}
              />
            </Popover.Content>
          </Popover.Portal>
        )}
      </Popover.Root>
    </DragHandle>
  );
}
