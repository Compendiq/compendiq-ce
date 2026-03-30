import { useEffect, useRef, useCallback, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import { Image } from '@tiptap/extension-image';
import { TitledCodeBlock } from './TitledCodeBlock';
import { Placeholder } from '@tiptap/extensions';
import { lowlight } from '../../lib/lowlight';
import {
  Bold, Italic, Strikethrough, Code, Heading1, Heading2, Heading3,
  List, ListOrdered, CheckSquare, Quote, Minus, Undo2, Redo2,
  Table as TableIcon, Image as ImageIcon, CodeSquare, Columns2,
  ArrowUpFromLine, ArrowDownFromLine, ArrowLeftFromLine, ArrowRightFromLine,
  Trash2, Columns3, Rows3, Merge, SplitSquareHorizontal, Square,
  ToggleLeft, PanelTop, Workflow,
} from 'lucide-react';
import { cn } from '../../lib/cn';
import { useIsLightTheme } from '../../hooks/use-is-light-theme';
import { MermaidBlock } from './MermaidBlockExtension';
import {
  ConfluenceLayout,
  ConfluenceLayoutSection,
  ConfluenceLayoutCell,
  ConfluenceSection,
  ConfluenceColumn,
  DrawioDiagram,
  isInConfluenceSection,
  isInConfluenceLayout,
  LAYOUT_PRESETS,
} from './article-extensions';
import type { Editor as EditorType } from '@tiptap/react';

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
  /** Remove the glass-card wrapper (use inside an already-styled card). Default false. */
  naked?: boolean;
  /** Callback fired when the TipTap editor instance is ready (or destroyed). */
  onEditorReady?: (editor: EditorType | null) => void;
  /** Hide built-in toolbar. Default false. */
  hideToolbar?: boolean;
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

export function EditorToolbar({ editor }: { editor: EditorType }) {
  return (
    <div className="flex flex-wrap items-center gap-0.5 px-2 py-1.5">
      <ToolbarButton onClick={() => editor.chain().focus().toggleBold().run()} active={editor.isActive('bold')} title="Bold (Ctrl+B)">
        <Bold size={16} />
      </ToolbarButton>
      <ToolbarButton onClick={() => editor.chain().focus().toggleItalic().run()} active={editor.isActive('italic')} title="Italic (Ctrl+I)">
        <Italic size={16} />
      </ToolbarButton>
      <ToolbarButton onClick={() => editor.chain().focus().toggleStrike().run()} active={editor.isActive('strike')} title="Strikethrough (Ctrl+Shift+X)">
        <Strikethrough size={16} />
      </ToolbarButton>
      <ToolbarButton onClick={() => editor.chain().focus().toggleCode().run()} active={editor.isActive('code')} title="Inline Code (Ctrl+E)">
        <Code size={16} />
      </ToolbarButton>

      <ToolbarSeparator />

      <ToolbarButton onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} active={editor.isActive('heading', { level: 1 })} title="Heading 1 (Ctrl+Alt+1)">
        <Heading1 size={16} />
      </ToolbarButton>
      <ToolbarButton onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} active={editor.isActive('heading', { level: 2 })} title="Heading 2 (Ctrl+Alt+2)">
        <Heading2 size={16} />
      </ToolbarButton>
      <ToolbarButton onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} active={editor.isActive('heading', { level: 3 })} title="Heading 3 (Ctrl+Alt+3)">
        <Heading3 size={16} />
      </ToolbarButton>

      <ToolbarSeparator />

      <ToolbarButton onClick={() => editor.chain().focus().toggleBulletList().run()} active={editor.isActive('bulletList')} title="Bullet List (Ctrl+Shift+8)">
        <List size={16} />
      </ToolbarButton>
      <ToolbarButton onClick={() => editor.chain().focus().toggleOrderedList().run()} active={editor.isActive('orderedList')} title="Ordered List (Ctrl+Shift+7)">
        <ListOrdered size={16} />
      </ToolbarButton>
      <ToolbarButton onClick={() => editor.chain().focus().toggleTaskList().run()} active={editor.isActive('taskList')} title="Task List">
        <CheckSquare size={16} />
      </ToolbarButton>

      <ToolbarSeparator />

      <ToolbarButton onClick={() => editor.chain().focus().toggleBlockquote().run()} active={editor.isActive('blockquote')} title="Blockquote">
        <Quote size={16} />
      </ToolbarButton>
      <ToolbarButton onClick={() => editor.chain().focus().toggleCodeBlock().run()} active={editor.isActive('codeBlock')} title="Code Block">
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
      <LayoutPresetPicker editor={editor} />

      <div className="flex-1" />

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
  if (!editor.isActive('table')) return null;

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
  if (!isInConfluenceLayout(editor)) return null;

  const currentType = editor.getAttributes('confluenceLayoutSection')['data-layout-type'] ?? '';

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
  if (!isInConfluenceSection(editor)) return null;

  const sectionAttrs = editor.getAttributes('confluenceSection');
  const hasBorder = sectionAttrs.border === 'true';

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

export function Editor({ content, onChange, editable = true, placeholder, draftKey, naked = false, onEditorReady, hideToolbar = false }: EditorProps) {
  const isLight = useIsLightTheme();
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

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

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        codeBlock: false,
      }),
      Table.configure({ resizable: true }),
      TableRow,
      TableCell,
      TableHeader,
      TaskList,
      TaskItem.configure({ nested: true }),
      MermaidBlock,
      ConfluenceLayout,
      ConfluenceLayoutSection,
      ConfluenceLayoutCell,
      ConfluenceSection,
      ConfluenceColumn,
      DrawioDiagram,
      TitledCodeBlock.configure({ lowlight }),
      ConfluenceImage.configure({ inline: false }),
      Placeholder.configure({ placeholder: placeholder ?? 'Start writing...' }),
    ],
    content,
    editable,
    immediatelyRender: false,
    onUpdate: ({ editor: ed }) => {
      const html = ed.getHTML();
      onChange?.(html);
      saveDraft(html);
    },
  });

  // Notify parent when editor instance is ready (triggers re-render via setState)
  useEffect(() => {
    onEditorReady?.(editor);
    return () => onEditorReady?.(null);
  }, [editor, onEditorReady]);

  return (
    <div className={naked ? '' : 'glass-card'}>
      {editable && editor && !hideToolbar && (
        <div className="sticky top-0 z-30 rounded-t-xl border-b border-border/50 bg-card before:absolute before:-z-10 before:-top-[100px] before:bottom-0 before:left-0 before:right-0 before:bg-background">
          <EditorToolbar editor={editor} />
          <TableContextToolbar editor={editor} />
          <LayoutContextToolbar editor={editor} />
          <ColumnContextToolbar editor={editor} />
        </div>
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
    </div>
  );
}
