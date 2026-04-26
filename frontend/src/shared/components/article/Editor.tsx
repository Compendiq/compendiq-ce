import { useEffect, useRef, useCallback, useState } from 'react';
import { useEditor, useEditorState, EditorContent } from '@tiptap/react';
import DragHandle from '@tiptap/extension-drag-handle-react';
import StarterKit from '@tiptap/starter-kit';
import { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import { Image } from '@tiptap/extension-image';
import { TitledCodeBlock } from './TitledCodeBlock';
import { Placeholder } from '@tiptap/extensions';
import { Highlight } from '@tiptap/extension-highlight';
import { TextStyle } from '@tiptap/extension-text-style';
import { Color } from '@tiptap/extension-color';
import { lowlight } from '../../lib/lowlight';
import { SearchAndReplaceExtension } from './search-extension';
import { SearchAndReplace } from './SearchAndReplace';
import {
  Bold, Italic, Strikethrough, Code, Heading1, Heading2, Heading3,
  List, ListOrdered, CheckSquare, Quote, Minus, Undo2, Redo2,
  Table as TableIcon, Image as ImageIcon, CodeSquare, Columns2,
  ArrowUpFromLine, ArrowDownFromLine, ArrowLeftFromLine, ArrowRightFromLine,
  Trash2, Columns3, Rows3, Merge, SplitSquareHorizontal, Square,
  ToggleLeft, PanelTop, Workflow, Underline, Highlighter, Palette,
  Badge, ChevronsUpDown, Hash, Paperclip, ListTree, ImagePlus, TableProperties, Table2,
  GripVertical,
  Terminal,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '../../lib/cn';
import { apiFetch } from '../../lib/api';
import { useIsLightTheme } from '../../hooks/use-is-light-theme';
import { MermaidBlock } from './MermaidBlockExtension';
import {
  ConfluenceLayout,
  ConfluenceLayoutSection,
  ConfluenceLayoutCell,
  ConfluenceSection,
  ConfluenceColumn,
  ConfluenceChildren,
  ConfluenceStatus,
  ConfluenceAttachments,
  Details,
  DetailsSummary,
  DrawioDiagram,
  Figure,
  Figcaption,
  TableCaption,
  FigureIndex,
  TableIndex,
  isInConfluenceSection,
  isInConfluenceLayout,
  LAYOUT_PRESETS,
} from './article-extensions';
import type { Editor as EditorType } from '@tiptap/react';
import { VimExtension, type VimState } from './vim-extension';
import { VimModeIndicator } from './VimModeIndicator';

const ConfluenceImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      'data-confluence-image-source': {
        default: null,
        parseHTML: (element) => element.getAttribute('data-confluence-image-source'),
        renderHTML: (attributes) => attributes['data-confluence-image-source']
          ? { 'data-confluence-image-source': attributes['data-confluence-image-source'] }
          : {},
      },
      'data-confluence-filename': {
        default: null,
        parseHTML: (element) => element.getAttribute('data-confluence-filename'),
        renderHTML: (attributes) => attributes['data-confluence-filename']
          ? { 'data-confluence-filename': attributes['data-confluence-filename'] }
          : {},
      },
      'data-confluence-owner-page-title': {
        default: null,
        parseHTML: (element) => element.getAttribute('data-confluence-owner-page-title'),
        renderHTML: (attributes) => attributes['data-confluence-owner-page-title']
          ? { 'data-confluence-owner-page-title': attributes['data-confluence-owner-page-title'] }
          : {},
      },
      'data-confluence-owner-space-key': {
        default: null,
        parseHTML: (element) => element.getAttribute('data-confluence-owner-space-key'),
        renderHTML: (attributes) => attributes['data-confluence-owner-space-key']
          ? { 'data-confluence-owner-space-key': attributes['data-confluence-owner-space-key'] }
          : {},
      },
      'data-confluence-url': {
        default: null,
        parseHTML: (element) => element.getAttribute('data-confluence-url'),
        renderHTML: (attributes) => attributes['data-confluence-url']
          ? { 'data-confluence-url': attributes['data-confluence-url'] }
          : {},
      },
    };
  },
});

interface EditorProps {
  content?: string;
  onChange?: (html: string) => void;
  editable?: boolean;
  placeholder?: string;
  /** Key for localStorage auto-save (e.g. "page-draft-12345"). Omit to disable. */
  draftKey?: string;
  /** Remove the nm-card wrapper (use inside an already-styled card). Default false. */
  naked?: boolean;
  /** Callback fired when the TipTap editor instance is ready (or destroyed). */
  onEditorReady?: (editor: EditorType | null) => void;
  /** Hide built-in toolbar. Default false. */
  hideToolbar?: boolean;
  /** Page ID for image paste/drop uploads. When set, clipboard images are uploaded to this page. */
  pageId?: string;
  /** Callback to trigger a server-side save (used by vim :w command). */
  onSave?: () => void;
  /** Controlled vim mode — when provided, overrides internal vim state. */
  vimEnabled?: boolean;
}

function ToolbarButton({
  onClick,
  active,
  disabled,
  children,
  title,
}: {
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
  title: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        'rounded p-1.5 transition-colors',
        active ? 'bg-primary/20 text-primary ring-1 ring-primary/30' : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
        disabled && 'opacity-30 cursor-not-allowed',
      )}
    >
      {children}
    </button>
  );
}

function ToolbarSeparator() {
  return <div className="mx-1 h-5 w-px bg-foreground/10" />;
}

const STATUS_COLORS = [
  { label: 'Grey', value: 'grey', bg: '#6b7280' },
  { label: 'Blue', value: 'blue', bg: '#3b82f6' },
  { label: 'Green', value: 'green', bg: '#22c55e' },
  { label: 'Yellow', value: 'yellow', bg: '#eab308' },
  { label: 'Red', value: 'red', bg: '#ef4444' },
];

function StatusLabelInsert({ editor }: { editor: EditorType }) {
  const [open, setOpen] = useState(false);
  const [selectedColor, setSelectedColor] = useState('blue');
  const [labelText, setLabelText] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleInsert = () => {
    const text = labelText.trim() || 'STATUS';
    editor.chain().focus().insertContent({ type: 'confluenceStatus', attrs: { color: selectedColor, label: text } }).run();
    setLabelText('');
    setOpen(false);
  };

  return (
    <div className="relative" ref={ref}>
      <ToolbarButton onClick={() => setOpen(!open)} title="Insert Status Label">
        <Badge size={16} />
      </ToolbarButton>
      {open && (
        <div className="absolute top-full left-0 z-50 mt-1 w-52 rounded-lg border border-border bg-card p-3 shadow-lg">
          <div className="mb-2 flex gap-1">
            {STATUS_COLORS.map((c) => (
              <button
                key={c.value}
                title={c.label}
                onClick={() => setSelectedColor(c.value)}
                className={cn(
                  'h-5 w-5 rounded-full border-2 transition-transform',
                  selectedColor === c.value ? 'border-foreground scale-110' : 'border-transparent',
                )}
                style={{ backgroundColor: c.bg }}
              />
            ))}
          </div>
          <input
            type="text"
            value={labelText}
            onChange={(e) => setLabelText(e.target.value.toUpperCase())}
            onKeyDown={(e) => e.key === 'Enter' && handleInsert()}
            placeholder="IN PROGRESS"
            className="mb-2 w-full rounded-md border border-border bg-background px-2 py-1 text-xs uppercase"
            autoFocus
          />
          <button
            onClick={handleInsert}
            className="w-full rounded-md bg-primary/20 px-2 py-1 text-xs text-primary hover:bg-primary/30"
          >
            Insert
          </button>
        </div>
      )}
    </div>
  );
}

const PRESET_COLORS = [
  { label: 'Red', value: '#ef4444' },
  { label: 'Orange', value: '#f97316' },
  { label: 'Yellow', value: '#eab308' },
  { label: 'Green', value: '#22c55e' },
  { label: 'Blue', value: '#3b82f6' },
  { label: 'Purple', value: '#a855f7' },
  { label: 'Pink', value: '#ec4899' },
  { label: 'Grey', value: '#6b7280' },
];

function ColorPickerDropdown({
  onSelect,
  onReset,
  activeColor,
  icon,
  title,
}: {
  onSelect: (color: string) => void;
  onReset: () => void;
  activeColor: string | undefined;
  icon: React.ReactNode;
  title: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        title={title}
        className={cn(
          'rounded p-1.5 transition-colors',
          activeColor ? 'ring-1 ring-primary/30' : '',
          'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
        )}
      >
        <div className="relative">
          {icon}
          {activeColor && (
            <div className="absolute -bottom-0.5 left-0.5 right-0.5 h-0.5 rounded-full" style={{ backgroundColor: activeColor }} />
          )}
        </div>
      </button>
      {open && (
        <div className="absolute top-full left-0 z-50 mt-1 rounded-lg border border-border bg-card p-2 shadow-lg">
          <div className="grid grid-cols-4 gap-1">
            {PRESET_COLORS.map((c) => (
              <button
                key={c.value}
                title={c.label}
                onClick={() => { onSelect(c.value); setOpen(false); }}
                className="h-6 w-6 rounded-md border border-border/50 transition-transform hover:scale-110"
                style={{ backgroundColor: c.value }}
              />
            ))}
          </div>
          <button
            onClick={() => { onReset(); setOpen(false); }}
            className="mt-1.5 w-full rounded-md px-2 py-0.5 text-xs text-muted-foreground hover:bg-foreground/5"
          >
            Reset
          </button>
        </div>
      )}
    </div>
  );
}

export function EditorToolbar({ editor, headerNumbering, onToggleHeaderNumbering, vimEnabled, onToggleVim }: { editor: EditorType; headerNumbering?: boolean; onToggleHeaderNumbering?: () => void; vimEnabled?: boolean; onToggleVim?: () => void }) {
  // Subscribe to editor state changes so toolbar re-renders on selection/formatting changes (#16)
  const activeState = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      strike: e.isActive('strike'),
      underline: e.isActive('underline'),
      code: e.isActive('code'),
      h1: e.isActive('heading', { level: 1 }),
      h2: e.isActive('heading', { level: 2 }),
      h3: e.isActive('heading', { level: 3 }),
      bulletList: e.isActive('bulletList'),
      orderedList: e.isActive('orderedList'),
      taskList: e.isActive('taskList'),
      blockquote: e.isActive('blockquote'),
      codeBlock: e.isActive('codeBlock'),
      textColor: e.getAttributes('textStyle').color as string | undefined,
      highlightColor: e.getAttributes('highlight').color as string | undefined,
    }),
  });

  return (
    <div className="flex flex-wrap items-center gap-0.5 px-2 py-1.5">
      <ToolbarButton onClick={() => editor.chain().focus().toggleBold().run()} active={activeState.bold} title="Bold (Ctrl+B)">
        <Bold size={16} />
      </ToolbarButton>
      <ToolbarButton onClick={() => editor.chain().focus().toggleItalic().run()} active={activeState.italic} title="Italic (Ctrl+I)">
        <Italic size={16} />
      </ToolbarButton>
      <ToolbarButton onClick={() => editor.chain().focus().toggleStrike().run()} active={activeState.strike} title="Strikethrough (Ctrl+Shift+X)">
        <Strikethrough size={16} />
      </ToolbarButton>
      <ToolbarButton onClick={() => editor.chain().focus().toggleUnderline().run()} active={activeState.underline} title="Underline (Ctrl+U)">
        <Underline size={16} />
      </ToolbarButton>
      <ToolbarButton onClick={() => editor.chain().focus().toggleCode().run()} active={activeState.code} title="Inline Code (Ctrl+E)">
        <Code size={16} />
      </ToolbarButton>

      <ToolbarSeparator />

      {/* Text color & highlight (#14 #15) */}
      <ColorPickerDropdown
        icon={<Palette size={16} />}
        title="Text Color"
        activeColor={activeState.textColor}
        onSelect={(color) => editor.chain().focus().setColor(color).run()}
        onReset={() => editor.chain().focus().unsetColor().run()}
      />
      <ColorPickerDropdown
        icon={<Highlighter size={16} />}
        title="Highlight (Ctrl+Shift+H)"
        activeColor={activeState.highlightColor}
        onSelect={(color) => editor.chain().focus().toggleHighlight({ color }).run()}
        onReset={() => editor.chain().focus().unsetHighlight().run()}
      />

      <ToolbarSeparator />

      <ToolbarButton onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} active={activeState.h1} title="Heading 1 (Ctrl+Alt+1)">
        <Heading1 size={16} />
      </ToolbarButton>
      <ToolbarButton onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} active={activeState.h2} title="Heading 2 (Ctrl+Alt+2)">
        <Heading2 size={16} />
      </ToolbarButton>
      <ToolbarButton onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} active={activeState.h3} title="Heading 3 (Ctrl+Alt+3)">
        <Heading3 size={16} />
      </ToolbarButton>
      {onToggleHeaderNumbering && (
        <ToolbarButton onClick={onToggleHeaderNumbering} active={headerNumbering} title="Toggle Header Numbering">
          <Hash size={16} />
        </ToolbarButton>
      )}

      <ToolbarSeparator />

      <ToolbarButton onClick={() => editor.chain().focus().toggleBulletList().run()} active={activeState.bulletList} title="Bullet List (Ctrl+Shift+8)">
        <List size={16} />
      </ToolbarButton>
      <ToolbarButton onClick={() => editor.chain().focus().toggleOrderedList().run()} active={activeState.orderedList} title="Ordered List (Ctrl+Shift+7)">
        <ListOrdered size={16} />
      </ToolbarButton>
      <ToolbarButton onClick={() => editor.chain().focus().toggleTaskList().run()} active={activeState.taskList} title="Task List">
        <CheckSquare size={16} />
      </ToolbarButton>

      <ToolbarSeparator />

      <ToolbarButton onClick={() => editor.chain().focus().toggleBlockquote().run()} active={activeState.blockquote} title="Blockquote">
        <Quote size={16} />
      </ToolbarButton>
      <ToolbarButton onClick={() => editor.chain().focus().toggleCodeBlock().run()} active={activeState.codeBlock} title="Code Block">
        <CodeSquare size={16} />
      </ToolbarButton>
      <ToolbarButton onClick={() => editor.chain().focus().setHorizontalRule().run()} title="Horizontal Rule">
        <Minus size={16} />
      </ToolbarButton>

      <ToolbarSeparator />

      <ToolbarButton
        onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
        title="Insert Table"
      >
        <TableIcon size={16} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => {
          const url = window.prompt('Image URL:');
          if (url) editor.chain().focus().setImage({ src: url }).run();
        }}
        title="Insert Image"
      >
        <ImageIcon size={16} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().insertDrawioDiagram().run()}
        title="Insert Draw.io Diagram"
      >
        <Workflow size={16} />
      </ToolbarButton>

      {/* Confluence-compatible content blocks (#6 #7) */}
      <StatusLabelInsert editor={editor} />
      <ToolbarButton
        onClick={() => {
          editor.chain().focus().insertContent({
            type: 'details',
            content: [
              { type: 'detailsSummary', content: [{ type: 'text', text: 'Click to expand' }] },
              { type: 'paragraph', content: [{ type: 'text', text: 'Content here...' }] },
            ],
          }).run();
        }}
        title="Insert Expand/Collapse Section"
      >
        <ChevronsUpDown size={16} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => {
          editor.chain().focus().insertContent({
            type: 'confluenceAttachments',
            attrs: { upload: 'false', old: 'false' },
          }).run();
        }}
        title="Insert Attachments Block"
      >
        <Paperclip size={16} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => {
          editor.chain().focus().insertContent({ type: 'confluenceChildren' }).run();
        }}
        title="Insert Children Pages"
      >
        <ListTree size={16} />
      </ToolbarButton>

      <LayoutPresetPicker editor={editor} />

      <ToolbarSeparator />

      {/* Caption & Index tools (#13) */}
      <ToolbarButton
        onClick={() => {
          // Wrap selected image in a figure with caption
          const { from } = editor.state.selection;
          const node = editor.state.doc.nodeAt(from);
          if (node?.type.name === 'image') {
            editor.chain()
              .deleteRange({ from, to: from + node.nodeSize })
              .insertContentAt(from, {
                type: 'figure',
                content: [
                  { type: 'image', attrs: node.attrs },
                  { type: 'figcaption' },
                ],
              })
              .run();
          }
        }}
        title="Add Caption to Selected Image"
      >
        <ImagePlus size={16} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => {
          // Insert a table caption after the current position
          editor.chain().focus().insertContent({ type: 'tableCaption' }).run();
        }}
        title="Insert Table Caption"
      >
        <TableProperties size={16} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => {
          editor.chain().focus().insertContent({ type: 'figureIndex' }).run();
        }}
        title="Insert List of Figures"
      >
        <ListTree size={16} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => {
          editor.chain().focus().insertContent({ type: 'tableIndex' }).run();
        }}
        title="Insert List of Tables"
      >
        <Table2 size={16} />
      </ToolbarButton>

      <div className="flex-1" />

      {onToggleVim && (
        <ToolbarButton onClick={onToggleVim} active={vimEnabled} title="Toggle Vim Mode">
          <Terminal size={16} />
        </ToolbarButton>
      )}

      <ToolbarSeparator />

      <ToolbarButton onClick={() => editor.chain().focus().undo().run()} disabled={!editor.can().undo()} title="Undo">
        <Undo2 size={16} />
      </ToolbarButton>
      <ToolbarButton onClick={() => editor.chain().focus().redo().run()} disabled={!editor.can().redo()} title="Redo">
        <Redo2 size={16} />
      </ToolbarButton>
    </div>
  );
}

export function TableContextToolbar({ editor }: { editor: EditorType }) {
  const { isTable } = useEditorState({
    editor,
    selector: ({ editor: e }) => ({ isTable: e.isActive('table') }),
  });
  if (!isTable) return null;

  return (
    <div
      data-testid="table-context-toolbar"
      className="flex flex-wrap items-center gap-0.5 border-t border-primary/20 bg-primary/5 px-2 py-1.5"
    >
      <span className="mr-1 text-xs font-semibold text-primary/70 select-none">Table</span>

      <ToolbarSeparator />

      {/* Row operations */}
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
        <Rows3 size={15} className="text-destructive/70" />
      </ToolbarButton>

      <ToolbarSeparator />

      {/* Column operations */}
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
        <Columns3 size={15} className="text-destructive/70" />
      </ToolbarButton>

      <ToolbarSeparator />

      {/* Merge / Split */}
      <ToolbarButton
        onClick={() => editor.chain().focus().mergeCells().run()}
        disabled={!editor.can().mergeCells()}
        title="Merge cells"
      >
        <Merge size={15} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().splitCell().run()}
        disabled={!editor.can().splitCell()}
        title="Split cell"
      >
        <SplitSquareHorizontal size={15} />
      </ToolbarButton>

      <ToolbarSeparator />

      {/* Header toggles */}
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleHeaderRow().run()}
        disabled={!editor.can().toggleHeaderRow()}
        active={editor.isActive('tableHeader')}
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

      <ToolbarSeparator />

      {/* Add table caption (#13) */}
      <ToolbarButton
        onClick={() => {
          // Insert a table caption node after the current table
          editor.chain().focus().insertContent({ type: 'tableCaption' }).run();
        }}
        title="Add Table Caption"
      >
        <TableProperties size={15} />
      </ToolbarButton>

      <div className="flex-1" />

      {/* Delete table */}
      <ToolbarButton
        onClick={() => editor.chain().focus().deleteTable().run()}
        disabled={!editor.can().deleteTable()}
        title="Delete table"
      >
        <Trash2 size={15} className="text-destructive/70" />
      </ToolbarButton>
    </div>
  );
}

function LayoutPreview({ bars, size = 'sm' }: { bars: readonly number[]; size?: 'sm' | 'md' }) {
  const h = size === 'sm' ? 'h-4' : 'h-5';
  const w = size === 'sm' ? 'w-10' : 'w-12';
  return (
    <div className={`flex gap-0.5 ${h} ${w}`}>
      {bars.map((flex, i) => (
        <div key={i} style={{ flex }} className="rounded-[2px] bg-current opacity-25" />
      ))}
    </div>
  );
}

function LayoutPresetPicker({ editor }: { editor: EditorType }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <ToolbarButton onClick={() => setOpen(!open)} active={open} title="Insert Layout">
        <Columns2 size={16} />
      </ToolbarButton>
      {open && (
        <div className="absolute top-full left-0 z-50 mt-1 rounded-lg border border-border/50 bg-card p-2 shadow-lg min-w-max">
          <p className="mb-1.5 px-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Page Layout</p>
          <div className="flex gap-1">
            {LAYOUT_PRESETS.map((preset) => (
              <button
                key={preset.type}
                onClick={() => {
                  editor.chain().focus().insertLayout({ layoutType: preset.type }).run();
                  setOpen(false);
                }}
                title={preset.label}
                className="flex flex-col items-center gap-1 rounded-md px-2 py-1.5 hover:bg-foreground/5 transition-colors"
              >
                <LayoutPreview bars={preset.bars} size="md" />
                <span className="text-[10px] text-muted-foreground whitespace-nowrap">{preset.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function LayoutContextToolbar({ editor }: { editor: EditorType }) {
  const { inLayout, currentType } = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      inLayout: isInConfluenceLayout(e),
      currentType: (e.getAttributes('confluenceLayoutSection')['data-layout-type'] ?? '') as string,
    }),
  });
  if (!inLayout) return null;

  return (
    <div
      data-testid="layout-context-toolbar"
      className="flex flex-wrap items-center gap-0.5 border-t border-primary/20 bg-primary/5 px-2 py-1.5"
    >
      <span className="mr-1 text-xs font-semibold text-primary/70 select-none">Layout</span>

      <ToolbarSeparator />

      {LAYOUT_PRESETS.map((preset) => (
        <ToolbarButton
          key={preset.type}
          onClick={() => editor.chain().focus().changeLayoutType({ layoutType: preset.type }).run()}
          active={currentType === preset.type}
          title={preset.label}
        >
          <LayoutPreview bars={preset.bars} />
        </ToolbarButton>
      ))}

      <div className="flex-1" />

      <ToolbarButton
        onClick={() => editor.chain().focus().deleteLayout().run()}
        title="Delete layout"
      >
        <Trash2 size={15} className="text-destructive/70" />
      </ToolbarButton>
    </div>
  );
}

export function ColumnContextToolbar({ editor }: { editor: EditorType }) {
  const { inSection, hasBorder } = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      inSection: isInConfluenceSection(e),
      hasBorder: e.getAttributes('confluenceSection').border === 'true',
    }),
  });
  if (!inSection) return null;

  return (
    <div
      data-testid="column-context-toolbar"
      className="flex flex-wrap items-center gap-0.5 border-t border-primary/20 bg-primary/5 px-2 py-1.5"
    >
      <span className="mr-1 text-xs font-semibold text-primary/70 select-none">Columns</span>

      <ToolbarSeparator />

      {/* Add/remove columns */}
      <ToolbarButton
        onClick={() => editor.chain().focus().addSectionColumnBefore().run()}
        disabled={!editor.can().addSectionColumnBefore()}
        title="Add column before"
      >
        <ArrowLeftFromLine size={15} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().addSectionColumnAfter().run()}
        disabled={!editor.can().addSectionColumnAfter()}
        title="Add column after"
      >
        <ArrowRightFromLine size={15} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().removeSectionColumn().run()}
        disabled={!editor.can().removeSectionColumn()}
        title="Remove column"
      >
        <Columns3 size={15} className="text-destructive/70" />
      </ToolbarButton>

      <ToolbarSeparator />

      {/* Toggle border */}
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleSectionBorder().run()}
        active={hasBorder}
        title="Toggle border"
      >
        <Square size={15} />
      </ToolbarButton>

      <div className="flex-1" />

      {/* Delete row (section = row in Confluence layout model) */}
      <ToolbarButton
        onClick={() => editor.chain().focus().deleteSection().run()}
        disabled={!editor.can().deleteSection()}
        title="Delete row"
      >
        <Trash2 size={15} className="text-destructive/70" />
      </ToolbarButton>
    </div>
  );
}

/** Map MIME type to file extension for pasted images */
const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/**
 * Upload a pasted/dropped image file to the server.
 * Returns the served URL on success, or null on failure (shows a toast).
 */
async function uploadPastedImage(file: File, pageId: string): Promise<string | null> {
  const ext = MIME_TO_EXT[file.type];
  if (!ext) {
    toast.error(`Unsupported image type: ${file.type}`);
    return null;
  }

  const hex = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
  const filename = `paste-${Date.now()}-${hex}.${ext}`;

  const dataUri = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

  try {
    const result = await apiFetch<{ url: string }>(
      `/pages/${encodeURIComponent(pageId)}/images`,
      {
        method: 'POST',
        body: JSON.stringify({ dataUri, filename }),
      },
    );
    return result.url;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to upload image';
    toast.error(message);
    return null;
  }
}

const AUTO_SAVE_DELAY = 2000;

// eslint-disable-next-line react-refresh/only-export-components
export function getDraft(key: string): string | null {
  try {
    return localStorage.getItem(`draft:${key}`);
  } catch {
    return null;
  }
}

// eslint-disable-next-line react-refresh/only-export-components
export function clearDraft(key: string): void {
  try {
    localStorage.removeItem(`draft:${key}`);
  } catch { /* ignore */ }
}

const VIM_STORAGE_KEY = 'compendiq-vim-mode';

function defaultVimDisplayState(): VimState {
  return { mode: 'normal', pendingKeys: '', countPrefix: '', register: '', commandBuffer: null };
}

export function Editor({ content, onChange, editable = true, placeholder, draftKey, naked = false, onEditorReady, hideToolbar = false, pageId, onSave, vimEnabled: vimEnabledProp }: EditorProps) {
  const isLight = useIsLightTheme();
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Ref for the editor instance so async paste/drop handlers can insert images
  const editorRef = useRef<EditorType | null>(null);
  // Keep pageId in a ref so editorProps closures see the latest value
  const pageIdRef = useRef(pageId);
  pageIdRef.current = pageId;
  // Keep onSave in a ref so the VimExtension closure always sees the latest callback
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  const [headerNumbering, setHeaderNumbering] = useState(() =>
    localStorage.getItem('editor-header-numbering') === 'true'
  );

  const toggleHeaderNumbering = () => {
    setHeaderNumbering(prev => {
      localStorage.setItem('editor-header-numbering', String(!prev));
      return !prev;
    });
  };

  // Vim mode state — use controlled prop when provided, otherwise internal state
  const [vimEnabledInternal, setVimEnabledInternal] = useState(() =>
    localStorage.getItem(VIM_STORAGE_KEY) === 'true'
  );
  const vimEnabled = vimEnabledProp ?? vimEnabledInternal;
  const [vimDisplayState, setVimDisplayState] = useState<VimState>(defaultVimDisplayState);

  const toggleVim = () => {
    setVimEnabledInternal(prev => {
      const next = !prev;
      localStorage.setItem(VIM_STORAGE_KEY, String(next));
      if (!next) setVimDisplayState(defaultVimDisplayState());
      return next;
    });
  };

  const saveDraft = useCallback((html: string) => {
    if (!draftKey) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      try {
        localStorage.setItem(`draft:${draftKey}`, html);
      } catch { /* quota exceeded — ignore */ }
    }, AUTO_SAVE_DELAY);
  }, [draftKey]);

  // Cleanup timer on unmount
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  /**
   * Handle pasted or dropped image files: upload to server, insert as image node.
   * Returns true if an image was handled, false to let TipTap process normally.
   */
  const handleImageFiles = useCallback((files: File[]): boolean => {
    const imageFile = files.find((f) => f.type.startsWith('image/'));
    if (!imageFile) return false;

    const currentPageId = pageIdRef.current;
    if (!currentPageId) {
      toast.error('Save the page first to paste images.');
      return true; // Prevent default paste of raw data
    }

    uploadPastedImage(imageFile, currentPageId).then((url) => {
      if (url && editorRef.current) {
        editorRef.current.chain().focus().setImage({ src: url }).run();
      }
    });

    return true;
  }, []);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        codeBlock: false,
      }),
      TextStyle,
      Color,
      Highlight.configure({ multicolor: true }),
      Table.configure({ resizable: true }),
      TableRow,
      TableCell,
      TableHeader,
      TaskList,
      TaskItem.configure({ nested: true }),
      MermaidBlock,
      Details,
      DetailsSummary,
      ConfluenceStatus,
      ConfluenceLayout,
      ConfluenceLayoutSection,
      ConfluenceLayoutCell,
      ConfluenceSection,
      ConfluenceColumn,
      ConfluenceAttachments,
      ConfluenceChildren,
      DrawioDiagram,
      Figure,
      Figcaption,
      TableCaption,
      FigureIndex,
      TableIndex,
      TitledCodeBlock.configure({ lowlight }),
      ConfluenceImage.configure({ inline: false }),
      Placeholder.configure({ placeholder: placeholder ?? 'Start writing...' }),
      SearchAndReplaceExtension,
      ...(vimEnabled ? [VimExtension.configure({
        onStateChange: setVimDisplayState,
        onSave: () => {
          // Flush current editor content to React state, then trigger server-side save
          if (editorRef.current) {
            onChange?.(editorRef.current.getHTML());
          }
          onSaveRef.current?.();
        },
      })] : []),
    ],
    editorProps: {
      handlePaste(_view, event) {
        const items = Array.from(event.clipboardData?.items ?? []);
        const imageItem = items.find((i) => i.type.startsWith('image/'));
        if (!imageItem) return false;
        event.preventDefault();
        const file = imageItem.getAsFile();
        if (!file) return false;
        return handleImageFiles([file]);
      },
      handleDrop(_view, event, _slice, moved) {
        // Only handle external drops (not internal drag-and-drop of existing content)
        if (moved) return false;
        const files = Array.from(event.dataTransfer?.files ?? []);
        if (files.length === 0) return false;
        const hasImage = files.some((f) => f.type.startsWith('image/'));
        if (!hasImage) return false;
        event.preventDefault();
        return handleImageFiles(files);
      },
    },
    content,
    editable,
    immediatelyRender: false,
    onUpdate: ({ editor: ed }) => {
      const html = ed.getHTML();
      onChange?.(html);
      saveDraft(html);
    },
  }, [vimEnabled]);

  // Keep the editor ref in sync
  editorRef.current = editor;

  // Notify parent when editor instance is ready (triggers re-render via setState)
  useEffect(() => {
    onEditorReady?.(editor);
    return () => onEditorReady?.(null);
  }, [editor, onEditorReady]);

  return (
    <div className={cn('relative', naked ? '' : 'nm-card', headerNumbering && 'header-numbering')}>
      {editable && editor && !hideToolbar && (
        <div className="sticky top-0 z-30 border-b border-border/30 bg-card px-1">
          <EditorToolbar editor={editor} headerNumbering={headerNumbering} onToggleHeaderNumbering={toggleHeaderNumbering} vimEnabled={vimEnabled} onToggleVim={toggleVim} />
          <TableContextToolbar editor={editor} />
          <LayoutContextToolbar editor={editor} />
          <ColumnContextToolbar editor={editor} />
        </div>
      )}
      {editable && editor && <SearchAndReplace editor={editor} />}
      {editable && editor && (
        <DragHandle editor={editor} className="drag-handle">
          <GripVertical size={16} />
        </DragHandle>
      )}
      <EditorContent
        editor={editor}
        className={cn(
          'prose max-w-none',
          !isLight && 'prose-invert',
          '[&_.tiptap]:min-h-[200px] [&_.tiptap]:px-10 [&_.tiptap]:py-6 [&_.tiptap]:outline-none',
          '[&_table]:border-collapse [&_td]:border [&_td]:border-border/50 [&_td]:p-2 [&_th]:border [&_th]:border-border/50 [&_th]:bg-foreground/5 [&_th]:p-2',
          '[&_pre]:rounded-md [&_pre]:bg-foreground/5 [&_pre:not([data-title])]:p-4 [&_pre[data-title]]:px-4 [&_pre[data-title]]:pb-4',
          '[&_ul[data-type=taskList]]:list-none [&_ul[data-type=taskList]]:pl-0',
        )}
      />
      {vimEnabled && editable && <VimModeIndicator vimState={vimDisplayState} />}
    </div>
  );
}
