import { useCallback, useEffect, useId, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { useEditorState } from '@tiptap/react';
import { TextSelection } from '@tiptap/pm/state';
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
import { blockLabel, supportsTextActions } from './block-menu-nodes';
import {
  blockMenuTargetKey,
  blockMenuTargetRange,
  clearBlockMenuTarget,
  createBlockMenuTargetPlugin,
  setBlockMenuTarget,
} from './block-menu-decoration';

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
 * `mousemove`, so it cannot be reached by keyboard. Nothing here is
 * keyboard-inaccessible as a result — every action is also reachable through
 * the selection bubble menu, which is fully keyboard-operable.
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
      return {
        present: nodeRange() !== null,
        hasText: range !== null
          && editor.state.doc.textBetween(range.from, range.to, '\n').trim().length > 0,
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

  const replaceBlockContent = useCallback(() => {
    const range = contentRange();
    if (!range || !stream.output) return;
    const { inline } = buildImproveHtml(stream.output);
    // The range is the block's CONTENT, so the block node itself survives: an
    // improved `h2` is still an `h2`. Replacing the node range instead would
    // flatten it — and for a macro node would destroy it outright.
    editor.chain().focus().insertContentAt({ from: range.from, to: range.to }, inline).run();
    onClose();
  }, [editor, stream.output, contentRange, onClose]);

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
    const { doc, schema } = editor.state;
    const isOnlyBlock = range.from === 0 && range.to === doc.content.size;

    editor.chain().focus().command(({ tr, dispatch }) => {
      if (!dispatch) return true;
      if (isOnlyBlock) {
        // A `block+` document cannot be empty, so deleting the last block has
        // to leave something behind. Stated outright rather than left to
        // `deleteRange`'s "delete as much as is valid" fallback: the empty
        // paragraph and the caret sitting in it are the intended result, not a
        // by-product of how far ProseMirror decided it could delete.
        const paragraph = schema.nodes.paragraph?.createAndFill();
        if (!paragraph) return false;
        tr.replaceWith(range.from, range.to, paragraph);
        tr.setSelection(TextSelection.create(tr.doc, 1));
      } else {
        // `deleteRange` (not `delete`) so removing the last child of a
        // container takes the now-empty container with it.
        tr.deleteRange(range.from, range.to);
      }
      return true;
    }).run();

    // No confirmation dialog: the block is outlined in the document while the
    // menu is open, so the user can see what they are removing, and nothing
    // reaches Confluence until Save. An undo affordance is the proportionate
    // safety net for a three-step deliberate gesture.
    toast.success(`${label} deleted`, {
      action: { label: 'Undo', onClick: () => editor.commands.undo() },
    });
    onClose();
  }, [editor, nodeRange, label, onClose]);

  const showImprove = textActions && live.hasText;

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
              'mx-2 flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-medium transition-colors',
              'text-destructive hover:bg-destructive/10',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive',
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
  // The hovered block, kept in a ref rather than state: the drag-handle plugin
  // fires `onNodeChange` on every `mousemove` across the document, and putting
  // that in React state would re-render the editor tree continuously.
  const hoveredRef = useRef<{ node: PMNode; pos: number } | null>(null);
  const [target, setTarget] = useState<{ node: PMNode; pos: number } | null>(null);
  const open = target !== null;

  // MUST be stable: the drag-handle component lists `onNodeChange` in the
  // effect deps that register/unregister its ProseMirror plugin, so an inline
  // arrow would tear the plugin down and rebuild it on every render.
  const handleNodeChange = useCallback(
    ({ node, pos }: { node: PMNode | null; pos: number }) => {
      hoveredRef.current = node && pos >= 0 ? { node, pos } : null;
    },
    [],
  );

  useEffect(() => {
    if (editor.isDestroyed) return;
    editor.registerPlugin(createBlockMenuTargetPlugin());
    return () => { editor.unregisterPlugin(blockMenuTargetKey); };
  }, [editor]);

  const openMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    const hovered = hoveredRef.current;
    if (!hovered || editor.isDestroyed) return;
    // The drag-handle plugin nulls its node out on `mouseleave` unless the
    // pointer lands inside the handle's own wrapper — and the menu is portalled
    // to <body>, so it never is. Locking freezes the handle where it is and
    // makes `mousemove` / `mouseleave` / `keydown` early-return. It has to be
    // the transaction meta: the `lockDragHandle` *command* lives on the
    // DragHandle Extension, which this editor does not register (only the React
    // component's plugin).
    editor.view.dispatch(editor.state.tr.setMeta('lockDragHandle', true));
    setBlockMenuTarget(editor, hovered.pos);
    setTarget(hovered);
  }, [editor]);

  const closeMenu = useCallback(() => {
    setTarget(null);
    if (editor.isDestroyed) return;
    clearBlockMenuTarget(editor);
    editor.view.dispatch(editor.state.tr.setMeta('lockDragHandle', false));
  }, [editor]);

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
