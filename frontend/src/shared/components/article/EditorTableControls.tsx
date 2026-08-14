import { useEffect, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { useEditorState } from '@tiptap/react';
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
  Table as TableIcon,
  Plus,
  Maximize2,
  Minimize2,
  GripVertical,
} from 'lucide-react';
import { cn } from '../../lib/cn';
import { ToolbarButton, ToolbarSeparator } from './editor-toolbar-primitives';

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
 * Renders in the editor sticky toolbar or floating above the table.
 * Includes row/column ops, cell merge/split, header toggles, table caption,
 * and page-width expansion toggle.
 */
export function TableContextToolbar({ editor }: { editor: EditorType }) {
  const { isTable, isHeaderRow, canMerge, canSplit, isFullWidth } = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      isTable: e.isActive('table'),
      isHeaderRow: e.isActive('tableHeader'),
      canMerge: e.can().mergeCells(),
      canSplit: e.can().splitCell(),
      isFullWidth: e.getAttributes('table')['data-layout'] === 'full-width',
    }),
  });

  if (!isTable) return null;

  const toggleFullWidth = () => {
    const nextLayout = isFullWidth ? 'default' : 'full-width';
    editor.chain().focus().updateAttributes('table', { 'data-layout': nextLayout }).run();
  };

  return (
    <div
      data-testid="table-context-toolbar"
      className="flex flex-wrap items-center gap-1 border-t border-border bg-card px-2 py-1.5 text-xs text-foreground transition-all duration-150"
    >
      {/* Table Badge */}
      <div className="flex items-center gap-1.5 pr-1 select-none">
        <span className="flex h-6 items-center gap-1 rounded border border-border-interactive/30 bg-foreground/5 px-2 font-medium text-foreground">
          <TableIcon size={13} className="text-primary shrink-0" />
          <span>Table</span>
        </span>
      </div>

      <ToolbarSeparator />

      {/* Row operations */}
      <div className="flex items-center gap-0.5" role="group" aria-label="Row operations">
        <ToolbarButton
          onClick={() => editor.chain().focus().addRowBefore().run()}
          disabled={!editor.can().addRowBefore()}
          title="Add row before"
        >
          <ArrowUpFromLine size={15} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().addRowAfter().run()}
          disabled={!editor.can().addRowAfter()}
          title="Add row after"
        >
          <ArrowDownFromLine size={15} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().deleteRow().run()}
          disabled={!editor.can().deleteRow()}
          title="Delete row"
        >
          <Rows3 size={15} className="text-destructive/80 transition-colors hover:text-destructive" />
        </ToolbarButton>
      </div>

      <ToolbarSeparator />

      {/* Column operations */}
      <div className="flex items-center gap-0.5" role="group" aria-label="Column operations">
        <ToolbarButton
          onClick={() => editor.chain().focus().addColumnBefore().run()}
          disabled={!editor.can().addColumnBefore()}
          title="Add column before"
        >
          <ArrowLeftFromLine size={15} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().addColumnAfter().run()}
          disabled={!editor.can().addColumnAfter()}
          title="Add column after"
        >
          <ArrowRightFromLine size={15} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().deleteColumn().run()}
          disabled={!editor.can().deleteColumn()}
          title="Delete column"
        >
          <Columns3 size={15} className="text-destructive/80 transition-colors hover:text-destructive" />
        </ToolbarButton>
      </div>

      <ToolbarSeparator />

      {/* Merge / Split */}
      <div className="flex items-center gap-0.5" role="group" aria-label="Cell layout">
        <ToolbarButton
          onClick={() => editor.chain().focus().mergeCells().run()}
          disabled={!canMerge}
          title="Merge cells"
        >
          <Merge size={15} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().splitCell().run()}
          disabled={!canSplit}
          title="Split cell"
        >
          <SplitSquareHorizontal size={15} />
        </ToolbarButton>
      </div>

      <ToolbarSeparator />

      {/* Header Toggles */}
      <div className="flex items-center gap-0.5" role="group" aria-label="Header formatting">
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleHeaderRow().run()}
          disabled={!editor.can().toggleHeaderRow()}
          active={isHeaderRow}
          title="Toggle header row"
        >
          <PanelTop size={15} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleHeaderColumn().run()}
          disabled={!editor.can().toggleHeaderColumn()}
          title="Toggle header column"
        >
          <ToggleLeft size={15} />
        </ToolbarButton>
      </div>

      <ToolbarSeparator />

      {/* Table Caption */}
      <ToolbarButton
        onClick={() => {
          editor.chain().focus().insertContent({ type: 'tableCaption' }).run();
        }}
        title="Add Table Caption"
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

      <div className="flex-1" />

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
 * Notion-Style Floating Table Overlay Controls attached directly to the active Table inside the editor canvas.
 * Renders:
 * 1. Corner Handle Button (`::`) at top-left corner of table with Table Options Popover.
 * 2. Edge Column Adder (`+`) button at the right boundary of the table.
 * 3. Edge Row Adder (`+`) button at the bottom boundary of the table.
 */
export function EditorTableOverlay({ editor }: { editor: EditorType }) {
  const { wrapperElement, isFullWidth } = useActiveTableElement(editor);
  const [popoverOpen, setPopoverOpen] = useState(false);

  if (!wrapperElement || !editor.isEditable) return null;

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
      {/* Corner Options Handle (Notion-style :: button) */}
      <div className="pointer-events-auto absolute -top-3.5 left-2 z-30">
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

      {/* Right-edge Add Column (+) Button */}
      <div className="pointer-events-auto absolute -top-3.5 right-2 z-30">
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

      {/* Bottom-edge Add Row (+) Button */}
      <div className="pointer-events-auto absolute -bottom-3.5 left-4 z-30">
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
