import { useCallback, useEffect, useId, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { useEditorState } from '@tiptap/react';
import type { Editor as EditorType } from '@tiptap/react';
import type { Node as PMNode } from '@tiptap/pm/model';
import DragHandle from '@tiptap/extension-drag-handle-react';
import {
  CopyPlus,
  GripVertical,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '../../lib/cn';
import { useImproveStream } from './use-improve-stream';
import { buildImproveHtml } from './improve-markdown';
import { EditorFormatBar } from './EditorFormatBar';
import { BlockTypeMenu } from './BlockTypeMenu';
import { ImprovePanel, type ImprovePanelCopy } from './ImprovePanel';
import { buildInstruction, BLOCK_INSTRUCTION, type QuickAction } from './improve-actions';
import {
  blockLabel, containsLossyMarks, containsStructuredInline, supportsTextActions, NESTED_DRAG_OPTIONS,
} from './block-menu-nodes';
import { blockMenuTargetKey, blockMenuTargetRange } from './block-menu-decoration';
import { absorbBlockMenuEscape, useBlockMenuTarget } from './use-block-menu-target';
import { TableContextToolbar } from './EditorTableControls';

/**
 * #1179 — State-of-the-art Notion-style command surface on the editor's block drag handle.
 *
 * Left-clicking the handle opens a focused contextual command surface:
 * - Table configuration (Fit to width toggle switch, Header row toggle switch, Header column toggle switch)
 * - Text Block controls (Block type conversion and inline formatting)
 * - Block lifecycle: Duplicate and Delete (with undo toast)
 * - AI integration: "Ask AI" inline prompt
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
  const isTable = node.type.name === 'table';
  const textActions = supportsTextActions(node);

  /**
   * The target block's live range. The marker plugin remaps it through every
   * transaction, so this stays right while the menu is open, and goes `null`
   * once the block is gone.
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

  const targetPos = nodeRange()?.from ?? pos;

  const live = useEditorState({
    editor,
    selector: () => {
      const nr = nodeRange();
      if (!nr) {
        return { present: false, hasText: false, dropsMacros: false, dropsLinks: false };
      }
      const range = nr.to - nr.from >= 2 ? { from: nr.from + 1, to: nr.to - 1 } : null;
      const { doc } = editor.state;
      const hasText = range !== null && doc.textBetween(range.from, range.to, '\n').trim().length > 0;
      return {
        present: true,
        hasText,
        dropsMacros: range !== null && hasText && containsStructuredInline(doc, range.from, range.to),
        dropsLinks: range !== null && hasText && containsLossyMarks(doc, range.from, range.to),
      };
    },
  });

  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!live.present) closeRef.current();
  }, [live.present]);

  const { abort } = stream;
  useEffect(() => () => { abort(); }, [abort]);

  const openAi = useCallback(() => {
    stream.reset();
    setAiOpen(true);
  }, [stream]);

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

  const multiBlockAnswer = useCallback((): boolean => {
    if (!stream.output) return false;
    const { inline, html } = buildImproveHtml(stream.output);
    return inline === html.trim();
  }, [stream.output]);

  const replaceWouldDestroyBlock = node.type.name === 'heading' && multiBlockAnswer();

  const replaceBlocked = replaceWouldDestroyBlock
    ? 'That answer is more than one block, so replacing would turn this heading into body text. Insert it below instead.'
    : null;

  const replaceBlockContent = useCallback(() => {
    const range = contentRange();
    if (!range || !stream.output) return;
    if (replaceWouldDestroyBlock) return;
    const { inline } = buildImproveHtml(stream.output);
    editor.chain().focus().insertContentAt({ from: range.from, to: range.to }, inline).run();
    onClose();
  }, [editor, stream.output, contentRange, onClose, replaceWouldDestroyBlock]);

  const insertBelowBlock = useCallback(() => {
    const range = nodeRange();
    if (!range || !stream.output) return;
    const { html } = buildImproveHtml(stream.output);
    editor.chain().focus().insertContentAt(range.to, html).run();
    onClose();
  }, [editor, stream.output, nodeRange, onClose]);

  const deleteBlock = useCallback(() => {
    const range = nodeRange();
    if (!range) return;

    try {
      const $pos = editor.state.doc.resolve(range.from);
      const parent = $pos.parent;
      // If the node is the sole block in a container requiring block+ (e.g. column, cell, panel),
      // replace with an empty paragraph instead of creating an invalid empty container.
      const isSoleBlockInContainer =
        parent &&
        parent.childCount === 1 &&
        (parent.type.name === 'confluenceColumn' ||
          parent.type.name === 'confluenceLayoutCell' ||
          parent.type.name === 'panel');

      const paragraphType = editor.schema.nodes.paragraph;
      if (isSoleBlockInContainer && paragraphType) {
        editor
          .chain()
          .focus()
          .command(({ tr }) => {
            tr.replaceWith(range.from, range.to, paragraphType.create());
            return true;
          })
          .run();
      } else {
        editor.chain().focus().deleteRange({ from: range.from, to: range.to }).run();
      }
      toast.success(`${label} deleted`, {
        action: { label: 'Undo', onClick: () => { if (!editor.isDestroyed) editor.commands.undo(); } },
      });
    } finally {
      onClose();
    }
  }, [editor, nodeRange, label, onClose]);

  const duplicateBlock = useCallback(() => {
    const range = nodeRange();
    if (!range) return;
    const targetNode = editor.state.doc.nodeAt(range.from);
    if (!targetNode) return;

    try {
      editor.chain().focus().insertContentAt(range.to, targetNode.toJSON()).run();
      toast.success(`${label} duplicated`, {
        action: {
          label: 'Undo',
          onClick: () => {
            if (!editor.isDestroyed) editor.commands.undo();
          },
        },
      });
    } finally {
      onClose();
    }
  }, [editor, nodeRange, label, onClose]);

  const showImprove = textActions && live.hasText && !live.dropsMacros;

  return (
    <div
      data-testid="editor-block-menu"
      className="flex w-60 flex-col text-xs select-none p-1"
    >
      {/* Main Command Surface */}
      {!aiOpen ? (
        <div className="flex flex-col">
          {/* Table Controls (When Block is Table) */}
          {isTable && (
            <TableContextToolbar
              editor={editor}
              embedded={true}
              targetPos={targetPos}
              onClose={onClose}
              onDelete={deleteBlock}
              onDuplicate={duplicateBlock}
            />
          )}

          {/* Text Formatting Controls (For Headings, Paragraphs, Quotes, Lists) */}
          {!isTable && textActions && (
            <div className="flex flex-col">
              <div className="flex items-center justify-between px-2.5 pt-1.5 pb-1">
                <span
                  className="truncate text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                  data-testid="block-menu-label"
                >
                  {label}
                </span>
              </div>
              <div className="px-1 pb-1">
                <BlockTypeMenu editor={editor} getRange={contentRange} className="w-full" />
              </div>
              <EditorFormatBar
                editor={editor}
                ariaLabel="Block formatting"
                getRange={contentRange}
                className="px-1"
              />
            </div>
          )}

          {!isTable && !textActions && (
            <div className="flex items-center justify-between px-2.5 pt-1.5 pb-1">
              <span
                className="truncate text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                data-testid="block-menu-label"
              >
                {label}
              </span>
            </div>
          )}

          {/* General Block Actions: Duplicate, Delete (for non-table blocks) */}
          {!isTable && (
            <>
              <div role="separator" aria-orientation="horizontal" className="my-1 mx-1.5 h-px bg-border" />

              <div className="flex flex-col gap-0.5">
                <button
                  type="button"
                  onClick={duplicateBlock}
                  data-testid="block-menu-duplicate"
                  className={cn(
                    'flex w-full items-center justify-between gap-2.5 rounded-md px-2.5 py-1.5 text-left text-xs text-foreground/90 transition-colors',
                    'hover:bg-accent/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                  )}
                >
                  <div className="flex items-center gap-2.5">
                    <CopyPlus size={14} className="text-muted-foreground" />
                    <span>Duplicate</span>
                  </div>
                  <kbd className="text-[11px] font-mono text-muted-foreground/60 bg-muted/40 px-1.5 py-0.5 rounded border border-border/40">⌘D</kbd>
                </button>

                <button
                  type="button"
                  onClick={deleteBlock}
                  data-testid="block-menu-delete"
                  className={cn(
                    'flex w-full items-center justify-between gap-2.5 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors',
                    'nm-action-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-destructive',
                  )}
                >
                  <div className="flex items-center gap-2.5">
                    <Trash2 size={14} />
                    <span>Delete</span>
                  </div>
                  <kbd className="text-[11px] font-mono opacity-70 bg-destructive/10 px-1.5 py-0.5 rounded border border-destructive/20">Del</kbd>
                </button>
              </div>
            </>
          )}

          {/* AI Section (Ask AI) */}
          {showImprove && (
            <>
              <div role="separator" className="my-1 mx-1.5 h-px bg-border/40" />
              <button
                type="button"
                onClick={() => (aiOpen ? closeAi() : openAi())}
                aria-expanded={aiOpen}
                aria-controls={aiOpen ? aiPanelId : undefined}
                data-testid="block-ai-trigger"
                className={cn(
                  'flex w-full items-center justify-between gap-2.5 rounded-md px-2.5 py-1.5 text-left text-xs font-medium transition-colors',
                  'text-status-ai hover:bg-status-ai/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-status-ai',
                )}
              >
                <div className="flex items-center gap-2.5">
                  <Sparkles size={14} />
                  <span>Ask AI</span>
                </div>
                <kbd className="text-[11px] font-mono text-status-ai/80 bg-status-ai/10 px-1.5 py-0.5 rounded border border-status-ai/20">⌘J</kbd>
              </button>
            </>
          )}

          {textActions && live.dropsMacros && (
            <p className="px-2.5 py-1 text-[11px] text-muted-foreground">
              Improve is unavailable here: a rewrite would drop this block&rsquo;s inline macros.
            </p>
          )}

          {showImprove && live.dropsLinks && (
            <p className="px-2.5 py-1 text-[11px] text-warning" data-testid="block-menu-link-warning">
              Only plain text is sent — links, code spans and highlights in this block will not survive a rewrite.
            </p>
          )}

          {!textActions && !isTable && (
            <p className="px-2.5 py-1 text-[11px] text-muted-foreground">
              Formatting and AI editing apply to text blocks only.
            </p>
          )}
        </div>
      ) : (
        /* Expands the SAME container in place for the AI panel */
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
          className="mt-0.5"
        />
      )}

      {/* Clean Footer */}
      {!aiOpen && (
        <div className="mt-1 px-2.5 py-1.5 border-t border-border text-[11px] text-muted-foreground flex items-center justify-between rounded-b-md">
          <span className="truncate">Block: <strong className="font-medium text-foreground">{label}</strong></span>
          <span className="font-mono opacity-70 shrink-0">Esc</span>
        </div>
      )}
    </div>
  );
}

/**
 * The drag handle plus its context menu. Owns the marker plugin, the handle
 * lock, and the Radix popover; the menu body above owns everything else.
 */
export function EditorBlockHandle({ editor }: { editor: EditorType }) {
  const { target, setHovered, open: openTarget, close: closeMenu } = useBlockMenuTarget(editor);
  const open = target !== null;

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
    <DragHandle
      editor={editor}
      className="drag-handle"
      onNodeChange={handleNodeChange}
      nested={NESTED_DRAG_OPTIONS}
    >
      <Popover.Root open={open} onOpenChange={(next) => { if (!next) closeMenu(); }}>
        <Popover.Anchor asChild>
          <span
            className="flex h-full w-full items-center justify-center cursor-pointer relative before:absolute before:-inset-1.5 before:content-['']"
            data-block-menu-open={open ? 'true' : undefined}
            data-testid="drag-handle-trigger"
            title="Drag to move · Click for block actions"
            onClick={openMenu}
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
                'nm-card-elevated z-50 overflow-hidden rounded-lg',
                'motion-safe:animate-in motion-safe:fade-in-0 duration-75',
              )}
              onFocusOutside={(event) => event.preventDefault()}
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
