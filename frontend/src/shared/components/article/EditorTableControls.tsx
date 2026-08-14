import { useCallback, useEffect, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { BubbleMenu } from '@tiptap/react/menus';
import { useEditorState } from '@tiptap/react';
import { PluginKey } from '@tiptap/pm/state';
import type { Editor as EditorType } from '@tiptap/react';
import {
  ArrowUpFromLine,
  ArrowDownFromLine,
  ArrowLeftFromLine,
  ArrowRightFromLine,
  Trash2,
  Columns3,
  Rows3,
  Merge,
  SplitSquareHorizontal,
  ToggleLeft,
  PanelTop,
  TableProperties,
  Plus,
  Maximize2,
  Minimize2,
  GripVertical,
} from 'lucide-react';
import { cn } from '../../lib/cn';
import { ToolbarButton, ToolbarSeparator } from './editor-toolbar-primitives';

export const tableBubbleMenuPluginKey = new PluginKey('tableBubbleMenu');

/**
 * Hook to observe the active table node in the TipTap editor.
 * Returns the active HTMLTableElement, its wrapping container, and the current `data-layout` attribute.
 */
export function useActiveTableElement(editor: EditorType | null) {
  const [state, setState] = useState<{
    tableElement: HTMLTableElement | null;
    wrapperElement: HTMLElement | null;
    isFullWidth: boolean;
  }>({
    tableElement: null,
    wrapperElement: null,
    isFullWidth: false,
  });

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;

    const update = () => {
      if (!editor.isActive('table')) {
        setState({ tableElement: null, wrapperElement: null, isFullWidth: false });
        return;
      }

      const { selection } = editor.state;
      const $pos = selection.$from;
      let tablePos: number | null = null;
      for (let d = $pos.depth; d > 0; d--) {
        if ($pos.node(d).type.name === 'table') {
          tablePos = $pos.before(d);
          break;
        }
      }

      if (tablePos === null) {
        setState({ tableElement: null, wrapperElement: null, isFullWidth: false });
        return;
      }

      const dom = editor.view.nodeDOM(tablePos) as HTMLElement | null;
      if (!dom) {
        setState({ tableElement: null, wrapperElement: null, isFullWidth: false });
        return;
      }

      const tableEl = dom.tagName === 'TABLE' ? (dom as HTMLTableElement) : dom.querySelector('table');
      const wrapperEl = dom.classList?.contains('tableWrapper')
        ? dom
        : (dom.closest('.tableWrapper') as HTMLElement | null) || dom;

      const layout = editor.getAttributes('table')['data-layout'];
      const isFullWidth = layout === 'full-width';

      setState({
        tableElement: tableEl,
        wrapperElement: wrapperEl,
        isFullWidth,
      });
    };

    update();
    editor.on('selectionUpdate', update);
    editor.on('transaction', update);
    return () => {
      editor.off('selectionUpdate', update);
      editor.off('transaction', update);
    };
  }, [editor]);

  return state;
}

/**
 * Modernized Notion-style Table Context Toolbar.
 * Provides controls for row/column operations, header toggles, cell merging, table layout expansion, and deletion.
 */
export function TableContextToolbar({ editor }: { editor: EditorType }) {
  const { isFullWidth } = useActiveTableElement(editor);

  const editorState = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      isInTable: e.isActive('table'),
      canMergeCells: e.can().mergeCells(),
      canSplitCell: e.can().splitCell(),
      canAddRowBefore: e.can().addRowBefore(),
      canAddRowAfter: e.can().addRowAfter(),
      canDeleteRow: e.can().deleteRow(),
      canAddColumnBefore: e.can().addColumnBefore(),
      canAddColumnAfter: e.can().addColumnAfter(),
      canDeleteColumn: e.can().deleteColumn(),
    }),
  });

  if (!editorState.isInTable) {
    return null;
  }

  const toggleFullWidth = () => {
    const nextLayout = isFullWidth ? 'default' : 'full-width';
    editor.chain().focus().updateAttributes('table', { 'data-layout': nextLayout }).run();
  };

  return (
    <div
      aria-label="Table options"
      role="toolbar"
      data-testid="table-context-toolbar"
      className="flex flex-wrap items-center gap-0.5 rounded-lg border border-border bg-card p-1 text-card-foreground nm-card-elevated animate-in fade-in-50"
    >
      {/* Row Operations */}
      <ToolbarButton
        onClick={() => editor.chain().focus().addRowBefore().run()}
        disabled={!editorState.canAddRowBefore}
        title="Add row before"
      >
        <ArrowUpFromLine size={15} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().addRowAfter().run()}
        disabled={!editorState.canAddRowAfter}
        title="Add row after"
      >
        <ArrowDownFromLine size={15} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().deleteRow().run()}
        disabled={!editorState.canDeleteRow}
        title="Delete row"
      >
        <Rows3 size={15} className="text-destructive/80 transition-colors hover:text-destructive" />
      </ToolbarButton>

      <ToolbarSeparator />

      {/* Column Operations */}
      <ToolbarButton
        onClick={() => editor.chain().focus().addColumnBefore().run()}
        disabled={!editorState.canAddColumnBefore}
        title="Add column before"
      >
        <ArrowLeftFromLine size={15} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().addColumnAfter().run()}
        disabled={!editorState.canAddColumnAfter}
        title="Add column after"
      >
        <ArrowRightFromLine size={15} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().deleteColumn().run()}
        disabled={!editorState.canDeleteColumn}
        title="Delete column"
      >
        <Columns3 size={15} className="text-destructive/80 transition-colors hover:text-destructive" />
      </ToolbarButton>

      <ToolbarSeparator />

      {/* Cell Merge / Split */}
      <ToolbarButton
        onClick={() => editor.chain().focus().mergeCells().run()}
        disabled={!editorState.canMergeCells}
        title="Merge cells"
      >
        <Merge size={15} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().splitCell().run()}
        disabled={!editorState.canSplitCell}
        title="Split cell"
      >
        <SplitSquareHorizontal size={15} />
      </ToolbarButton>

      <ToolbarSeparator />

      {/* Header Toggles & Caption */}
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleHeaderRow().run()}
        title="Toggle header row"
      >
        <PanelTop size={15} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleHeaderColumn().run()}
        title="Toggle header column"
      >
        <ToggleLeft size={15} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().insertContent({ type: 'tableCaption' }).run()}
        title="Add table caption"
      >
        <TableProperties size={15} />
      </ToolbarButton>

      <ToolbarSeparator />

      {/* Feature: Expand Table to Page Size */}
      <button
        type="button"
        onClick={toggleFullWidth}
        title={isFullWidth ? 'Standard width table' : 'Expand table to page size'}
        aria-label="Expand table to page size"
        aria-pressed={isFullWidth}
        data-testid="toggle-table-expand"
        className={cn(
          'flex h-7 items-center gap-1.5 rounded px-2 text-xs font-medium transition-colors select-none',
          isFullWidth
            ? 'bg-foreground/10 text-foreground border border-border-interactive'
            : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground'
        )}
      >
        {isFullWidth ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        <span>{isFullWidth ? 'Page width' : 'Expand'}</span>
      </button>

      <ToolbarSeparator />

      {/* Delete Table */}
      <ToolbarButton
        onClick={() => editor.chain().focus().deleteTable().run()}
        disabled={!editor.can().deleteTable()}
        title="Delete table"
      >
        <Trash2 size={15} className="text-destructive/80 transition-colors hover:text-destructive" />
      </ToolbarButton>
    </div>
  );
}

/**
 * Floating Table Context Toolbar attached DIRECTLY to the active Table in the editor canvas using TipTap BubbleMenu.
 */
export function FloatingTableToolbar({ editor }: { editor: EditorType }) {
  const shouldShow = useCallback(({ editor: e }: { editor: EditorType }) => {
    if (!e || e.isDestroyed || !e.isEditable) return false;
    return e.isActive('table');
  }, []);

  return (
    <BubbleMenu
      editor={editor}
      pluginKey={tableBubbleMenuPluginKey}
      shouldShow={shouldShow}
      options={{
        placement: 'top-start',
        offset: 8,
        flip: { padding: 8 },
        shift: { padding: 8 },
      }}
      updateDelay={50}
    >
      <TableContextToolbar editor={editor} />
    </BubbleMenu>
  );
}

/**
 * Notion-Style Floating Table Overlay Controls positioned directly at the active Table in the editor canvas.
 * Computes exact DOM coordinates relative to the editor container so controls map 1:1 to table boundaries:
 * 1. Corner Handle Button (`:: Table`) at top-left corner of table with Table Options Popover.
 * 2. Edge Column Adder (`+ Column`) button at the right boundary of the table.
 * 3. Edge Row Adder (`+ Row`) button at the bottom boundary of the table.
 */
export function EditorTableOverlay({ editor }: { editor: EditorType }) {
  const { wrapperElement, isFullWidth } = useActiveTableElement(editor);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [rect, setRect] = useState<{ top: number; left: number; width: number; height: number } | null>(null);

  // Update bounds relative to editor view container
  useEffect(() => {
    if (!wrapperElement || !editor.view.dom) {
      setRect(null);
      return;
    }

    const updateRect = () => {
      const container = editor.view.dom.parentElement;
      if (!container) return;
      const containerRect = container.getBoundingClientRect();
      const elemRect = wrapperElement.getBoundingClientRect();

      setRect({
        top: elemRect.top - containerRect.top,
        left: elemRect.left - containerRect.left,
        width: elemRect.width,
        height: elemRect.height,
      });
    };

    updateRect();
    const ro = new ResizeObserver(updateRect);
    ro.observe(wrapperElement);
    if (editor.view.dom.parentElement) {
      ro.observe(editor.view.dom.parentElement);
    }
    window.addEventListener('scroll', updateRect, true);
    window.addEventListener('resize', updateRect);

    return () => {
      ro.disconnect();
      window.removeEventListener('scroll', updateRect, true);
      window.removeEventListener('resize', updateRect);
    };
  }, [wrapperElement, editor]);

  if (!wrapperElement || !rect || !editor.isEditable) return null;

  const handleAddColumn = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    editor.chain().focus().addColumnAfter().run();
  };

  const handleAddRow = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    editor.chain().focus().addRowAfter().run();
  };

  const toggleFullWidth = () => {
    const nextLayout = isFullWidth ? 'default' : 'full-width';
    editor.chain().focus().updateAttributes('table', { 'data-layout': nextLayout }).run();
    setPopoverOpen(false);
  };

  return (
    <div
      data-testid="editor-table-overlay"
      className="pointer-events-none absolute inset-0 z-20"
      style={{ overflow: 'visible' }}
    >
      {/* Corner Options Handle (Notion-style :: button) anchored directly at top-left of table */}
      <div
        className="pointer-events-auto absolute z-30"
        style={{ top: `${rect.top - 14}px`, left: `${rect.left + 4}px` }}
      >
        <Popover.Root open={popoverOpen} onOpenChange={setPopoverOpen}>
          <Popover.Trigger asChild>
            <button
              type="button"
              data-testid="table-corner-menu-trigger"
              title="Table actions"
              aria-label="Table options"
              className="flex h-6 items-center gap-1 rounded-md border border-border bg-card px-1.5 text-xs text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
            >
              <GripVertical size={13} className="shrink-0 opacity-75" />
              <span className="font-medium text-xs">Table</span>
            </button>
          </Popover.Trigger>

          <Popover.Portal>
            <Popover.Content
              side="top"
              align="start"
              sideOffset={4}
              className="z-50 min-w-[180px] rounded-lg border border-border bg-card p-1 text-xs text-foreground nm-card-elevated animate-in fade-in-50"
            >
              <div className="px-2 py-1 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                Table Options
              </div>
              <div className="my-1 h-px bg-border/50" />

              <button
                type="button"
                onClick={toggleFullWidth}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors hover:bg-foreground/5"
              >
                {isFullWidth ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                <span>{isFullWidth ? 'Reset to standard width' : 'Expand to page width'}</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  editor.chain().focus().toggleHeaderRow().run();
                  setPopoverOpen(false);
                }}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors hover:bg-foreground/5"
              >
                <PanelTop size={14} />
                <span>Toggle header row</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  editor.chain().focus().toggleHeaderColumn().run();
                  setPopoverOpen(false);
                }}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors hover:bg-foreground/5"
              >
                <ToggleLeft size={14} />
                <span>Toggle header column</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  editor.chain().focus().insertContent({ type: 'tableCaption' }).run();
                  setPopoverOpen(false);
                }}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors hover:bg-foreground/5"
              >
                <TableProperties size={14} />
                <span>Add table caption</span>
              </button>

              <div className="my-1 h-px bg-border/50" />

              <button
                type="button"
                onClick={() => {
                  editor.chain().focus().deleteTable().run();
                  setPopoverOpen(false);
                }}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-destructive transition-colors hover:bg-destructive/10"
              >
                <Trash2 size={14} />
                <span>Delete table</span>
              </button>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      </div>

      {/* Right-edge Add Column (+) Button anchored at top-right boundary of table */}
      <div
        className="pointer-events-auto absolute z-30"
        style={{ top: `${rect.top - 14}px`, left: `${rect.left + rect.width - 70}px` }}
      >
        <button
          type="button"
          onClick={handleAddColumn}
          data-testid="add-column-right-btn"
          title="Add column to right"
          aria-label="Add column"
          className="flex h-6 items-center gap-1 rounded-md border border-border bg-card px-2 text-xs font-medium text-muted-foreground transition-colors hover:border-border-interactive hover:bg-foreground/5 hover:text-foreground"
        >
          <Plus size={13} className="shrink-0" />
          <span>Column</span>
        </button>
      </div>

      {/* Bottom-edge Add Row (+) Button anchored at bottom-left boundary of table */}
      <div
        className="pointer-events-auto absolute z-30"
        style={{ top: `${rect.top + rect.height - 10}px`, left: `${rect.left + 16}px` }}
      >
        <button
          type="button"
          onClick={handleAddRow}
          data-testid="add-row-bottom-btn"
          title="Add row below"
          aria-label="Add row"
          className="flex h-6 items-center gap-1 rounded-md border border-border bg-card px-2 text-xs font-medium text-muted-foreground transition-colors hover:border-border-interactive hover:bg-foreground/5 hover:text-foreground"
        >
          <Plus size={13} className="shrink-0" />
          <span>Row</span>
        </button>
      </div>
    </div>
  );
}
