import { useEffect, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { useEditorState } from '@tiptap/react';
import type { Editor as EditorType } from '@tiptap/react';
import {
  BetweenHorizontalEnd,
  BetweenHorizontalStart,
  BetweenVerticalEnd,
  BetweenVerticalStart,
  Captions,
  ChevronDown,
  Columns3,
  Expand,
  MoreHorizontal,
  PanelLeftDashed,
  PanelTopDashed,
  Rows3,
  Shrink,
  SplitSquareHorizontal,
  Table2,
  TableProperties,
  Trash2,
  Merge,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../lib/cn';
import { TOOLBAR_ITEM_ATTR, useToolbarRovingFocus } from './use-toolbar-roving-focus';

function syncTableLayoutAttributes(editor: EditorType) {
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== 'table') return true;

    const dom = editor.view.nodeDOM(pos) as HTMLElement | null;
    const table = dom?.tagName === 'TABLE' ? dom : dom?.querySelector('table');
    if (!table) return true;
    const wrapper = table.closest('.tableWrapper');

    if (node.attrs['data-layout'] === 'full-width') {
      table.setAttribute('data-layout', 'full-width');
      wrapper?.setAttribute('data-layout', 'full-width');

      const columns = table.querySelectorAll<HTMLTableColElement>('colgroup > col');
      if (columns.length > 0) {
        const columnWidth = `${100 / columns.length}%`;
        columns.forEach((column) => column.style.setProperty('width', columnWidth, 'important'));
      }
    } else {
      table.removeAttribute('data-layout');
      wrapper?.removeAttribute('data-layout');

      table.querySelectorAll<HTMLTableColElement>('colgroup > col').forEach((column) => {
        column.style.removeProperty('width');
      });
    }

    return true;
  });
}

/** Observe whether the active table is using the full-width layout. */
function useActiveTableLayout(editor: EditorType | null) {
  const [isFullWidth, setIsFullWidth] = useState(false);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;

    const update = () => {
      if (!editor.isActive('table')) {
        setIsFullWidth(false);
        return;
      }

      syncTableLayoutAttributes(editor);
      setIsFullWidth(editor.getAttributes('table')['data-layout'] === 'full-width');
    };

    update();
    editor.on('selectionUpdate', update);
    editor.on('transaction', update);
    return () => {
      editor.off('selectionUpdate', update);
      editor.off('transaction', update);
    };
  }, [editor]);

  return isFullWidth;
}

function TableActionButton({
  icon: Icon,
  label,
  title,
  onClick,
  disabled,
  testId,
  destructive = false,
}: {
  icon: LucideIcon;
  label: string;
  title: string;
  onClick: () => void;
  disabled?: boolean;
  testId?: string;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      {...{ [TOOLBAR_ITEM_ATTR]: '' }}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      data-testid={testId}
      className={cn(
        'flex h-8 items-center gap-1.5 rounded-md border border-transparent px-2 text-[12px] font-medium whitespace-nowrap transition-colors',
        'text-muted-foreground hover:bg-accent hover:text-foreground',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        'disabled:pointer-events-none disabled:opacity-40',
        destructive && 'nm-action-destructive',
      )}
    >
      <Icon size={15} strokeWidth={1.9} aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}

function TableMenuItem({
  icon: Icon,
  label,
  onClick,
  destructive = false,
  testId,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  destructive?: boolean;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      data-testid={testId}
      className={cn(
        'flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs transition-colors',
        'text-foreground hover:bg-accent',
        destructive && 'nm-action-destructive',
      )}
    >
      <Icon size={15} strokeWidth={1.9} aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}

function TableToolbarDivider() {
  return <div role="separator" aria-orientation="vertical" className="mx-1 hidden h-5 w-px bg-border sm:block" />;
}

function setTableLayout(editor: EditorType, nextLayout: 'default' | 'full-width') {
  const { selection } = editor.state;
  const $pos = selection.$from;
  let tablePos: number | null = null;
  for (let d = $pos.depth; d > 0; d--) {
    if ($pos.node(d).type.name === 'table') {
      tablePos = $pos.before(d);
      break;
    }
  }

  if (tablePos !== null) {
    editor.view.dispatch(editor.state.tr.setNodeAttribute(tablePos, 'data-layout', nextLayout));
  } else {
    editor.chain().focus().updateAttributes('table', { 'data-layout': nextLayout }).run();
  }
}

/**
 * Focused table editing toolbar. Common structural actions are labeled and
 * grouped; display and destructive actions live in the More menu so the bar
 * stays easy to scan at desktop and narrow widths.
 */
export function TableContextToolbar({ editor, embedded = false }: { editor: EditorType; embedded?: boolean }) {
  const isFullWidth = useActiveTableLayout(editor);
  const rootRef = useRef<HTMLDivElement>(null);
  const roving = useToolbarRovingFocus(rootRef);
  const [moreOpen, setMoreOpen] = useState(false);

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

  if (!editorState.isInTable) return null;

  const toggleFullWidth = () => {
    setTableLayout(editor, isFullWidth ? 'default' : 'full-width');
  };

  return (
    <div
      ref={rootRef}
      aria-label="Table editing controls"
      role="toolbar"
      data-testid="table-context-toolbar"
      onKeyDown={roving.onKeyDown}
      onFocus={roving.onFocus}
      className={embedded
        ? 'flex max-w-full flex-wrap items-center gap-0.5 border-t border-border bg-card px-2 py-1.5 text-card-foreground'
        : 'flex max-w-full flex-wrap items-center gap-0.5 rounded-lg border border-border bg-card p-1 text-card-foreground nm-card-elevated animate-in fade-in-50'}
    >
      <div className="flex h-8 items-center gap-1.5 px-1.5 text-foreground" data-testid="table-toolbar-heading">
        <Table2 size={16} strokeWidth={1.9} aria-hidden="true" />
        <span className="text-xs font-semibold">Table</span>
      </div>

      <TableToolbarDivider />

      <div role="group" aria-label="Rows" className="flex items-center gap-0.5" data-testid="table-group-rows">
        <TableActionButton
          icon={BetweenHorizontalStart}
          label="Above"
          title="Add row above"
          onClick={() => editor.chain().focus().addRowBefore().run()}
          disabled={!editorState.canAddRowBefore}
        />
        <TableActionButton
          icon={BetweenHorizontalEnd}
          label="Below"
          title="Add row below"
          onClick={() => editor.chain().focus().addRowAfter().run()}
          disabled={!editorState.canAddRowAfter}
        />
        <TableActionButton
          icon={Rows3}
          label="Delete"
          title="Delete row"
          onClick={() => editor.chain().focus().deleteRow().run()}
          disabled={!editorState.canDeleteRow}
          destructive
        />
      </div>

      <TableToolbarDivider />

      <div role="group" aria-label="Columns" className="flex items-center gap-0.5" data-testid="table-group-columns">
        <TableActionButton
          icon={BetweenVerticalStart}
          label="Before"
          title="Add column before"
          onClick={() => editor.chain().focus().addColumnBefore().run()}
          disabled={!editorState.canAddColumnBefore}
        />
        <TableActionButton
          icon={BetweenVerticalEnd}
          label="After"
          title="Add column after"
          onClick={() => editor.chain().focus().addColumnAfter().run()}
          disabled={!editorState.canAddColumnAfter}
        />
        <TableActionButton
          icon={Columns3}
          label="Delete"
          title="Delete column"
          onClick={() => editor.chain().focus().deleteColumn().run()}
          disabled={!editorState.canDeleteColumn}
          destructive
        />
      </div>

      <TableToolbarDivider />

      <div role="group" aria-label="Cells" className="flex items-center gap-0.5" data-testid="table-group-cells">
        <TableActionButton
          icon={Merge}
          label="Merge"
          title="Merge selected cells"
          onClick={() => editor.chain().focus().mergeCells().run()}
          disabled={!editorState.canMergeCells}
        />
        <TableActionButton
          icon={SplitSquareHorizontal}
          label="Split"
          title="Split cell"
          onClick={() => editor.chain().focus().splitCell().run()}
          disabled={!editorState.canSplitCell}
        />
      </div>

      <TableToolbarDivider />

      <TableActionButton
        icon={isFullWidth ? Shrink : Expand}
        label={isFullWidth ? 'Page width' : 'Expand'}
        title={isFullWidth ? 'Return table to standard width' : 'Expand table to page width'}
        onClick={toggleFullWidth}
        testId="toggle-table-expand"
      />

      <Popover.Root open={moreOpen} onOpenChange={setMoreOpen}>
        <Popover.Trigger asChild>
          <button
            type="button"
            {...{ [TOOLBAR_ITEM_ATTR]: '' }}
            onMouseDown={(event) => event.preventDefault()}
            data-testid="table-more-trigger"
            aria-label="More table actions"
            aria-expanded={moreOpen}
            className="flex h-8 items-center gap-1 rounded-md border border-transparent px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <MoreHorizontal size={15} strokeWidth={1.9} aria-hidden="true" />
            <span>More</span>
            <ChevronDown size={13} strokeWidth={1.9} aria-hidden="true" />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            side="bottom"
            align="end"
            sideOffset={6}
            onOpenAutoFocus={(event) => event.preventDefault()}
            className="z-50 min-w-[220px] rounded-lg border border-border bg-card p-1 text-foreground nm-card-elevated animate-in fade-in-50"
          >
            <div className="px-2 py-1.5 text-xs font-semibold">More table actions</div>
            <div className="my-1 h-px bg-border" />
            <TableMenuItem
              icon={PanelTopDashed}
              label="Toggle header row"
              testId="table-toggle-header-row"
              onClick={() => {
                editor.chain().focus().toggleHeaderRow().run();
                setMoreOpen(false);
              }}
            />
            <TableMenuItem
              icon={PanelLeftDashed}
              label="Toggle header column"
              testId="table-toggle-header-column"
              onClick={() => {
                editor.chain().focus().toggleHeaderColumn().run();
                setMoreOpen(false);
              }}
            />
            <TableMenuItem
              icon={Captions}
              label="Add table caption"
              testId="table-add-caption"
              onClick={() => {
                editor.chain().focus().insertContent({ type: 'tableCaption' }).run();
                setMoreOpen(false);
              }}
            />
            <TableMenuItem
              icon={TableProperties}
              label={isFullWidth ? 'Return to standard width' : 'Expand to page width'}
              testId="table-more-toggle-width"
              onClick={() => {
                toggleFullWidth();
                setMoreOpen(false);
              }}
            />
            <div className="my-1 h-px bg-border" />
            <TableMenuItem
              icon={Trash2}
              label="Delete table"
              testId="table-delete"
              destructive
              onClick={() => {
                editor.chain().focus().deleteTable().run();
                setMoreOpen(false);
              }}
            />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
