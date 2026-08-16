import { useRef } from 'react';
import { useEditorState } from '@tiptap/react';
import type { Editor as EditorType } from '@tiptap/react';
import { CellSelection, selectedRect } from '@tiptap/pm/tables';
import { toast } from 'sonner';
import {
  CopyPlus,
  UnfoldHorizontal,
  FoldHorizontal,
  Merge,
  SplitSquareHorizontal,
  Table2,
  Trash2,
} from 'lucide-react';
import { cn } from '../../lib/cn';
import { TOOLBAR_ITEM_ATTR, useToolbarRovingFocus } from './use-toolbar-roving-focus';
import {
  insertTableCaption,
  useActiveTableLayout,
  setTableLayout,
  getTableNode,
  checkHasHeaderRow,
  checkHasHeaderColumn,
  toggleTableHeaderRowDirect,
  toggleTableHeaderColumnDirect,
} from './table-cell-selection';
import {
  IconInsertRowAbove,
  IconInsertRowBelow,
  IconDeleteRow,
  IconInsertColumnBefore,
  IconInsertColumnAfter,
  IconDeleteColumn,
  IconHeaderRow,
  IconHeaderColumn,
  IconTableCaption,
} from './table-icons';

function TableActionButton({
  icon: Icon,
  title,
  shortcut,
  onClick,
  disabled,
  active,
  testId,
  destructive = false,
}: {
  icon: React.ComponentType<{ size?: number | string; strokeWidth?: number | string; className?: string }>;
  title: string;
  shortcut?: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  testId?: string;
  destructive?: boolean;
}) {
  const fullLabel = shortcut ? `${title} (${shortcut})` : title;
  return (
    <button
      type="button"
      {...{ [TOOLBAR_ITEM_ATTR]: '' }}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      disabled={disabled}
      title={fullLabel}
      aria-label={fullLabel}
      aria-pressed={active}
      data-state={active !== undefined ? (active ? 'checked' : 'unchecked') : undefined}
      data-testid={testId}
      className={cn(
        'nm-icon-button',
        destructive && 'nm-action-destructive',
      )}
    >
      <Icon size={16} strokeWidth={2} aria-hidden="true" />
    </button>
  );
}

function TableToolbarDivider() {
  return <div role="separator" aria-orientation="vertical" className="mx-0.5 h-4 w-px bg-border" />;
}

function deleteRowsAction(editor: EditorType, runCmd: (cmd: () => void) => void) {
  runCmd(() => {
    const { state } = editor;
    if (state.selection instanceof CellSelection) {
      try {
        const rect = selectedRect(state);
        const count = rect.bottom - rect.top;
        if (count > 1) {
          let chain = editor.chain().focus();
          for (let r = rect.bottom - 1; r >= rect.top; r--) {
            const cellOffset = rect.map.map[r * rect.map.width + rect.left];
            if (cellOffset !== undefined) {
              const cellPos = rect.tableStart + cellOffset;
              chain = chain.setTextSelection(cellPos + 1).deleteRow();
            }
          }
          chain.run();
          toast.success(`${count} rows deleted`, {
            action: {
              label: 'Undo',
              onClick: () => {
                if (!editor.isDestroyed) editor.commands.undo();
              },
            },
          });
          return;
        }
      } catch {
        // Fallback
      }
    }

    editor.chain().deleteRow().run();
    toast.success('Row deleted', {
      action: {
        label: 'Undo',
        onClick: () => {
          if (!editor.isDestroyed) editor.commands.undo();
        },
      },
    });
  });
}

function deleteColumnsAction(editor: EditorType, runCmd: (cmd: () => void) => void) {
  runCmd(() => {
    const { state } = editor;
    if (state.selection instanceof CellSelection) {
      try {
        const rect = selectedRect(state);
        const count = rect.right - rect.left;
        if (count > 1) {
          let chain = editor.chain().focus();
          for (let c = rect.right - 1; c >= rect.left; c--) {
            const cellOffset = rect.map.map[rect.top * rect.map.width + c];
            if (cellOffset !== undefined) {
              const cellPos = rect.tableStart + cellOffset;
              chain = chain.setTextSelection(cellPos + 1).deleteColumn();
            }
          }
          chain.run();
          toast.success(`${count} columns deleted`, {
            action: {
              label: 'Undo',
              onClick: () => {
                if (!editor.isDestroyed) editor.commands.undo();
              },
            },
          });
          return;
        }
      } catch {
        // Fallback
      }
    }

    editor.chain().deleteColumn().run();
    toast.success('Column deleted', {
      action: {
        label: 'Undo',
        onClick: () => {
          if (!editor.isDestroyed) editor.commands.undo();
        },
      },
    });
  });
}

/**
 * Focused table editing toolbar. All actions are icon-only with clear,
 * accessible tooltips, matching the rest of the editor toolbar system.
 */
export function TableContextToolbar({
  editor,
  embedded = false,
  targetPos,
  onClose,
  onDelete,
  onDuplicate,
}: {
  editor: EditorType;
  embedded?: boolean;
  targetPos?: number;
  onClose?: () => void;
  onDelete?: () => void;
  onDuplicate?: () => void;
}) {
  const isFullWidth = useActiveTableLayout(editor, targetPos);
  const rootRef = useRef<HTMLDivElement>(null);
  const roving = useToolbarRovingFocus(rootRef);

  const editorState = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const isInTable = e.isActive('table');
      const tableNode = getTableNode(e, targetPos);
      const isHeaderRow = checkHasHeaderRow(tableNode);
      const isHeaderCol = checkHasHeaderColumn(tableNode);
      if (!isInTable && !embedded) {
        return {
          isInTable: false,
          hasHeaderRow: isHeaderRow,
          hasHeaderColumn: isHeaderCol,
          canMergeCells: false,
          canSplitCell: false,
          canAddRowBefore: false,
          canAddRowAfter: false,
          canDeleteRow: false,
          canAddColumnBefore: false,
          canAddColumnAfter: false,
          canDeleteColumn: false,
        };
      }
      return {
        isInTable: true,
        hasHeaderRow: isHeaderRow,
        hasHeaderColumn: isHeaderCol,
        canMergeCells: e.can().mergeCells(),
        canSplitCell: e.can().splitCell(),
        canAddRowBefore: true,
        canAddRowAfter: true,
        canDeleteRow: true,
        canAddColumnBefore: true,
        canAddColumnAfter: true,
        canDeleteColumn: true,
      };
    },
  });

  const hasHeaderRow = editorState.hasHeaderRow;
  const hasHeaderColumn = editorState.hasHeaderColumn;

  if (!embedded && !editorState.isInTable) return null;

  const toggleFullWidth = () => {
    setTableLayout(editor, isFullWidth ? 'default' : 'full-width', targetPos);
  };

  const runTableCmd = (cmd: () => void) => {
    if (targetPos !== undefined && targetPos >= 0 && !editor.isDestroyed) {
      const { selection } = editor.state;
      const targetTableNode = editor.state.doc.nodeAt(targetPos);
      const isAlreadyInTargetTable =
        targetTableNode &&
        selection.$from.pos >= targetPos &&
        selection.$to.pos <= targetPos + targetTableNode.nodeSize;

      if (!isAlreadyInTargetTable) {
        let firstCellPos = targetPos + 1;
        if (targetTableNode) {
          let offset = 0;
          for (let i = 0; i < targetTableNode.childCount; i++) {
            const child = targetTableNode.child(i);
            if (child.type.name === 'tableRow') {
              firstCellPos = targetPos + 1 + offset + 1;
              break;
            }
            offset += child.nodeSize;
          }
        }
        if (firstCellPos <= editor.state.doc.content.size) {
          editor.commands.setTextSelection(firstCellPos);
        }
      }
    }
    cmd();
  };

  const handleDeleteTable = () => {
    if (onDelete) {
      onDelete();
    } else {
      runTableCmd(() => {
        editor.chain().focus().deleteTable().run();
        toast.success('Table deleted', {
          action: {
            label: 'Undo',
            onClick: () => {
              if (!editor.isDestroyed) editor.commands.undo();
            },
          },
        });
      });
      onClose?.();
    }
  };

  if (embedded) {
    return (
      <div
        ref={rootRef}
        aria-label="Table editing controls"
        role="toolbar"
        data-testid="block-table-toolbar"
        onKeyDown={roving.onKeyDown}
        onFocus={roving.onFocus}
        className="flex flex-col gap-1.5 p-1 text-card-foreground"
      >
        {/* Table Structure & Layout Header */}
        <div className="flex items-center justify-between gap-1 px-1">
          <div className="flex items-center gap-1.5 text-foreground" data-testid="table-toolbar-heading">
            <Table2 size={16} strokeWidth={1.9} aria-hidden="true" />
            <span className="text-xs font-semibold">Table</span>
          </div>

          <div className="flex items-center gap-0.5" role="group" aria-label="Table structure">
            <TableActionButton
              icon={isFullWidth ? FoldHorizontal : UnfoldHorizontal}
              title={isFullWidth ? 'Return table to standard width' : 'Expand table to page width'}
              onClick={toggleFullWidth}
              active={isFullWidth}
              testId="toggle-table-expand"
            />
            <TableActionButton
              icon={IconHeaderRow}
              title={hasHeaderRow ? 'Header row active (click to remove)' : 'Toggle header row'}
              onClick={() => toggleTableHeaderRowDirect(editor, targetPos)}
              active={hasHeaderRow}
              testId="table-toggle-header-row"
            />
            <TableActionButton
              icon={IconHeaderColumn}
              title={hasHeaderColumn ? 'Header column active (click to remove)' : 'Toggle header column'}
              onClick={() => toggleTableHeaderColumnDirect(editor, targetPos)}
              active={hasHeaderColumn}
              testId="table-toggle-header-column"
            />
            <TableActionButton
              icon={IconTableCaption}
              title="Add caption below table"
              onClick={() => runTableCmd(() => insertTableCaption(editor, targetPos))}
              testId="table-add-caption"
            />
          </div>
        </div>

        <div role="separator" aria-orientation="horizontal" className="my-0.5 h-px bg-border" />

        {/* Rows Group */}
        <div role="group" aria-label="Rows" className="flex items-center justify-between gap-2 px-1" data-testid="table-group-rows">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Rows</span>
          <div className="flex items-center gap-0.5">
            <TableActionButton
              icon={IconInsertRowAbove}
              title="Add row above"
              onClick={() => runTableCmd(() => editor.chain().addRowBefore().run())}
              disabled={editorState.isInTable ? !editorState.canAddRowBefore : false}
              testId="table-add-row-before"
            />
            <TableActionButton
              icon={IconInsertRowBelow}
              title="Add row below"
              onClick={() => runTableCmd(() => editor.chain().addRowAfter().run())}
              disabled={editorState.isInTable ? !editorState.canAddRowAfter : false}
              testId="table-add-row-after"
            />
            <TableActionButton
              icon={IconDeleteRow}
              title="Delete row"
              onClick={() => deleteRowsAction(editor, runTableCmd)}
              disabled={editorState.isInTable ? !editorState.canDeleteRow : false}
              destructive
              testId="table-delete-row"
            />
          </div>
        </div>

        {/* Columns Group */}
        <div role="group" aria-label="Columns" className="flex items-center justify-between gap-2 px-1" data-testid="table-group-columns">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Columns</span>
          <div className="flex items-center gap-0.5">
            <TableActionButton
              icon={IconInsertColumnBefore}
              title="Add column before"
              onClick={() => runTableCmd(() => editor.chain().addColumnBefore().run())}
              disabled={editorState.isInTable ? !editorState.canAddColumnBefore : false}
              testId="table-add-col-before"
            />
            <TableActionButton
              icon={IconInsertColumnAfter}
              title="Add column after"
              onClick={() => runTableCmd(() => editor.chain().addColumnAfter().run())}
              disabled={editorState.isInTable ? !editorState.canAddColumnAfter : false}
              testId="table-add-col-after"
            />
            <TableActionButton
              icon={IconDeleteColumn}
              title="Delete column"
              onClick={() => deleteColumnsAction(editor, runTableCmd)}
              disabled={editorState.isInTable ? !editorState.canDeleteColumn : false}
              destructive
              testId="table-delete-col"
            />
          </div>
        </div>

        {/* Cells Group */}
        {(editorState.canMergeCells || editorState.canSplitCell) && (
          <div role="group" aria-label="Cells" className="flex items-center justify-between gap-2 px-1" data-testid="table-group-cells">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Cells</span>
            <div className="flex items-center gap-0.5">
              <TableActionButton
                icon={Merge}
                title="Merge selected cells"
                onClick={() => runTableCmd(() => editor.chain().mergeCells().run())}
                disabled={!editorState.canMergeCells}
                testId="table-merge-cells"
              />
              <TableActionButton
                icon={SplitSquareHorizontal}
                title="Split cell"
                onClick={() => runTableCmd(() => editor.chain().splitCell().run())}
                disabled={!editorState.canSplitCell}
                testId="table-split-cell"
              />
            </div>
          </div>
        )}

        <div role="separator" aria-orientation="horizontal" className="my-0.5 h-px bg-border" />

        {/* Block Actions: Duplicate & Delete */}
        <div className="flex flex-col gap-0.5">
          {onDuplicate && (
            <button
              type="button"
              {...{ [TOOLBAR_ITEM_ATTR]: '' }}
              onMouseDown={(event) => event.preventDefault()}
              onClick={onDuplicate}
              data-testid="block-menu-duplicate"
              className={cn(
                'flex w-full items-center justify-between gap-2.5 rounded-md px-2.5 py-1.5 text-left text-xs text-foreground transition-colors',
                'hover:bg-accent/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              )}
            >
              <div className="flex items-center gap-2.5">
                <CopyPlus size={14} className="text-muted-foreground" />
                <span>Duplicate</span>
              </div>
              <kbd className="text-[11px] font-mono text-muted-foreground bg-muted/40 px-1.5 py-0.5 rounded border border-border">⌘D</kbd>
            </button>
          )}

          <button
            type="button"
            {...{ [TOOLBAR_ITEM_ATTR]: '' }}
            onMouseDown={(event) => event.preventDefault()}
            data-testid="table-delete"
            onClick={handleDeleteTable}
            className={cn(
              'flex w-full items-center justify-between gap-2.5 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors',
              'nm-action-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-destructive',
            )}
          >
            <div className="flex items-center gap-2.5">
              <Trash2 size={14} />
              <span>Delete table</span>
            </div>
            <kbd className="text-[11px] font-mono opacity-80 bg-destructive/10 px-1.5 py-0.5 rounded border border-destructive/20">Del</kbd>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      aria-label="Table editing controls"
      role="toolbar"
      data-testid="table-context-toolbar"
      onKeyDown={roving.onKeyDown}
      onFocus={roving.onFocus}
      className="flex max-w-full flex-wrap items-center gap-0.5 text-xs text-card-foreground"
    >
      <div className="flex h-8 items-center gap-1.5 px-1.5 text-foreground" data-testid="table-toolbar-heading">
        <Table2 size={16} strokeWidth={1.9} aria-hidden="true" />
        <span className="text-xs font-semibold">Table</span>
      </div>

      <TableToolbarDivider />

      <div role="group" aria-label="Table structure" className="flex items-center gap-0.5">
        <TableActionButton
          icon={isFullWidth ? FoldHorizontal : UnfoldHorizontal}
          title={isFullWidth ? 'Return table to standard width' : 'Expand table to page width'}
          onClick={toggleFullWidth}
          active={isFullWidth}
          testId="toggle-table-expand"
        />
        <TableActionButton
          icon={IconHeaderRow}
          title={hasHeaderRow ? 'Header row active (click to remove)' : 'Toggle header row'}
          onClick={() => editor.chain().focus().toggleHeaderRow().run()}
          active={hasHeaderRow}
          testId="table-toggle-header-row"
        />
        <TableActionButton
          icon={IconHeaderColumn}
          title={hasHeaderColumn ? 'Header column active (click to remove)' : 'Toggle header column'}
          onClick={() => editor.chain().focus().toggleHeaderColumn().run()}
          active={hasHeaderColumn}
          testId="table-toggle-header-column"
        />
        <TableActionButton
          icon={IconTableCaption}
          title="Add caption below table"
          onClick={() => insertTableCaption(editor)}
          testId="table-add-caption"
        />
      </div>

      <TableToolbarDivider />

      <div role="group" aria-label="Rows" className="flex items-center gap-0.5" data-testid="table-group-rows">
        <TableActionButton
          icon={IconInsertRowAbove}
          title="Add row above"
          onClick={() => editor.chain().focus().addRowBefore().run()}
          disabled={!editorState.canAddRowBefore}
        />
        <TableActionButton
          icon={IconInsertRowBelow}
          title="Add row below"
          onClick={() => editor.chain().focus().addRowAfter().run()}
          disabled={!editorState.canAddRowAfter}
        />
        <TableActionButton
          icon={IconDeleteRow}
          title="Delete row"
          onClick={() => deleteRowsAction(editor, (cmd) => cmd())}
          disabled={!editorState.canDeleteRow}
          destructive
        />
      </div>

      <TableToolbarDivider />

      <div role="group" aria-label="Columns" className="flex items-center gap-0.5" data-testid="table-group-columns">
        <TableActionButton
          icon={IconInsertColumnBefore}
          title="Add column before"
          onClick={() => editor.chain().focus().addColumnBefore().run()}
          disabled={!editorState.canAddColumnBefore}
        />
        <TableActionButton
          icon={IconInsertColumnAfter}
          title="Add column after"
          onClick={() => editor.chain().focus().addColumnAfter().run()}
          disabled={!editorState.canAddColumnAfter}
        />
        <TableActionButton
          icon={IconDeleteColumn}
          title="Delete column"
          onClick={() => deleteColumnsAction(editor, (cmd) => cmd())}
          disabled={!editorState.canDeleteColumn}
          destructive
        />
      </div>

      <TableToolbarDivider />

      <div role="group" aria-label="Cells" className="flex items-center gap-0.5" data-testid="table-group-cells">
        <TableActionButton
          icon={Merge}
          title="Merge selected cells"
          onClick={() => editor.chain().focus().mergeCells().run()}
          disabled={!editorState.canMergeCells}
        />
        <TableActionButton
          icon={SplitSquareHorizontal}
          title="Split cell"
          onClick={() => editor.chain().focus().splitCell().run()}
          disabled={!editorState.canSplitCell}
        />
      </div>

      <TableToolbarDivider />

      <TableActionButton
        icon={Trash2}
        title="Delete table"
        onClick={handleDeleteTable}
        destructive
        testId="table-delete"
      />
    </div>
  );
}
