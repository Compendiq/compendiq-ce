import type React from 'react';
import type { Editor as EditorType } from '@tiptap/react';
import {
  Heading1, Heading2, Heading3, Heading4, Type,
  List, ListOrdered, CheckSquare, Quote, Minus,
  Table as TableIcon, CodeSquare, Workflow, Code,
  Info, TriangleAlert, StickyNote, Lightbulb,
  ChevronsUpDown, Columns2, Columns3,
  ListTree, Badge, Paperclip, Images, Table2,
} from 'lucide-react';
import { insertPanel, insertExpandSection } from './article-extensions';

export type SlashCategory =
  | 'Basic blocks'
  | 'Media & diagrams'
  | 'Panels & callouts'
  | 'Layout & containers'
  | 'Confluence macros';

export interface SlashCommandItem {
  id: string;
  title: string;
  description: string;
  category: SlashCategory;
  keywords: string[];
  shortcut?: string;
  Icon: React.ComponentType<{ size?: number; className?: string; style?: React.CSSProperties }>;
  iconColor?: string;
  run: (editor: EditorType, range: { from: number; to: number }) => void;
}

export const SLASH_COMMAND_ITEMS: readonly SlashCommandItem[] = [
  // --- Basic blocks ---
  {
    id: 'paragraph',
    title: 'Text',
    description: 'Plain body text paragraph',
    category: 'Basic blocks',
    keywords: ['paragraph', 'p', 'plain', 'text', 'normal', 'body'],
    Icon: Type,
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).setParagraph().run();
    },
  },
  {
    id: 'h1',
    title: 'Heading 1',
    description: 'Large section heading',
    category: 'Basic blocks',
    keywords: ['h1', 'heading', 'title', 'large', 'header', '#'],
    shortcut: 'H1',
    Icon: Heading1,
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).setHeading({ level: 1 }).run();
    },
  },
  {
    id: 'h2',
    title: 'Heading 2',
    description: 'Medium section heading',
    category: 'Basic blocks',
    keywords: ['h2', 'heading', 'medium', 'header', '##'],
    shortcut: 'H2',
    Icon: Heading2,
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).setHeading({ level: 2 }).run();
    },
  },
  {
    id: 'h3',
    title: 'Heading 3',
    description: 'Small section heading',
    category: 'Basic blocks',
    keywords: ['h3', 'heading', 'small', 'header', '###'],
    shortcut: 'H3',
    Icon: Heading3,
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).setHeading({ level: 3 }).run();
    },
  },
  {
    id: 'h4',
    title: 'Heading 4',
    description: 'Sub-heading for deeper structure',
    category: 'Basic blocks',
    keywords: ['h4', 'heading', 'subheading', 'header', '####'],
    shortcut: 'H4',
    Icon: Heading4,
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).setHeading({ level: 4 }).run();
    },
  },
  {
    id: 'bulletList',
    title: 'Bullet list',
    description: 'Create a simple bulleted list',
    category: 'Basic blocks',
    keywords: ['bullet', 'list', 'unordered', 'ul', '*', '-'],
    Icon: List,
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).toggleBulletList().run();
    },
  },
  {
    id: 'orderedList',
    title: 'Numbered list',
    description: 'Create a numbered sequential list',
    category: 'Basic blocks',
    keywords: ['numbered', 'list', 'ordered', 'ol', '1.', 'numbers'],
    Icon: ListOrdered,
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).toggleOrderedList().run();
    },
  },
  {
    id: 'taskList',
    title: 'Task list',
    description: 'Track tasks with interactive checkboxes',
    category: 'Basic blocks',
    keywords: ['task', 'todo', 'check', 'checklist', 'checkbox', '[ ]', 'tasks'],
    shortcut: '[]',
    Icon: CheckSquare,
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).toggleTaskList().run();
    },
  },
  {
    id: 'blockquote',
    title: 'Quote',
    description: 'Capture a quote or highlighted callout',
    category: 'Basic blocks',
    keywords: ['quote', 'blockquote', 'cite', 'citation', '>'],
    shortcut: '>',
    Icon: Quote,
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).toggleBlockquote().run();
    },
  },
  {
    id: 'divider',
    title: 'Divider',
    description: 'Visually separate sections with a horizontal line',
    category: 'Basic blocks',
    keywords: ['divider', 'line', 'hr', 'horizontal', 'rule', 'separator', '---'],
    shortcut: '---',
    Icon: Minus,
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).setHorizontalRule().run();
    },
  },

  // --- Media & diagrams ---
  {
    id: 'table',
    title: 'Table',
    description: 'Insert a 3x3 table with header row',
    category: 'Media & diagrams',
    keywords: ['table', 'grid', 'matrix', 'rows', 'columns', '3x3', 'spreadsheet', 'tabels'],
    shortcut: '3x3',
    Icon: TableIcon,
    run: (editor, range) => {
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
        .run();
    },
  },
  {
    id: 'codeBlock',
    title: 'Code block',
    description: 'Code snippet with syntax highlighting',
    category: 'Media & diagrams',
    keywords: ['code', 'codeblock', 'snippet', 'syntax', 'javascript', 'typescript', 'python', 'java', 'sql', '```'],
    shortcut: '```',
    Icon: CodeSquare,
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).toggleCodeBlock().run();
    },
  },
  {
    id: 'drawio',
    title: 'Diagram (draw.io)',
    description: 'Interactive flowchart or architecture diagram',
    category: 'Media & diagrams',
    keywords: ['diagram', 'drawio', 'flowchart', 'architecture', 'graph', 'chart', 'schema'],
    Icon: Workflow,
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).insertDrawioDiagram().run();
    },
  },
  {
    id: 'mermaid',
    title: 'Mermaid diagram',
    description: 'Text-driven diagrams and flowcharts',
    category: 'Media & diagrams',
    keywords: ['mermaid', 'chart', 'sequence', 'diagram', 'flowchart', 'graph'],
    Icon: Code,
    run: (editor, range) => {
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertContent({ type: 'mermaidBlock', attrs: { code: 'graph TD;\n  A-->B;' } })
        .run();
    },
  },

  // --- Panels & callouts ---
  {
    id: 'panel-info',
    title: 'Info panel',
    description: 'Highlight helpful informational notes',
    category: 'Panels & callouts',
    keywords: ['info', 'panel', 'callout', 'notice', 'information', 'blue', 'box'],
    Icon: Info,
    iconColor: 'var(--color-info)',
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).run();
      insertPanel(editor, 'info');
    },
  },
  {
    id: 'panel-warning',
    title: 'Warning panel',
    description: 'Highlight cautions, risks or warnings',
    category: 'Panels & callouts',
    keywords: ['warning', 'panel', 'alert', 'caution', 'risk', 'yellow', 'orange', 'box'],
    Icon: TriangleAlert,
    iconColor: 'var(--color-warning)',
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).run();
      insertPanel(editor, 'warning');
    },
  },
  {
    id: 'panel-note',
    title: 'Note panel',
    description: 'Primary highlighted note panel',
    category: 'Panels & callouts',
    keywords: ['note', 'panel', 'callout', 'highlight', 'primary', 'box'],
    Icon: StickyNote,
    iconColor: 'var(--color-primary)',
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).run();
      insertPanel(editor, 'note');
    },
  },
  {
    id: 'panel-tip',
    title: 'Tip panel',
    description: 'Share tips, best practices and insights',
    category: 'Panels & callouts',
    keywords: ['tip', 'panel', 'callout', 'hint', 'idea', 'success', 'green', 'box'],
    Icon: Lightbulb,
    iconColor: 'var(--color-success)',
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).run();
      insertPanel(editor, 'tip');
    },
  },

  // --- Layout & containers ---
  {
    id: 'expand',
    title: 'Expand section',
    description: 'Collapsible toggle section (Confluence Expand)',
    category: 'Layout & containers',
    keywords: ['expand', 'details', 'collapse', 'accordion', 'hidden', 'toggle', 'dropdown'],
    Icon: ChevronsUpDown,
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).run();
      insertExpandSection(editor, 'expand');
    },
  },
  {
    id: 'ui-expand',
    title: 'UI Expand section',
    description: 'Refined UI collapsible expand container',
    category: 'Layout & containers',
    keywords: ['ui-expand', 'expand', 'refined', 'collapse', 'accordion', 'toggle'],
    Icon: ChevronsUpDown,
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).run();
      insertExpandSection(editor, 'ui-expand');
    },
  },
  {
    id: 'layout-two-equal',
    title: '2 Columns',
    description: 'Two equal-width columns (50 / 50)',
    category: 'Layout & containers',
    keywords: ['column', 'columns', '2 columns', 'layout', 'grid', '50/50', 'two'],
    Icon: Columns2,
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).insertLayout({ layoutType: 'two-equal' }).run();
    },
  },
  {
    id: 'layout-three-equal',
    title: '3 Columns',
    description: 'Three equal-width columns (33 / 33 / 33)',
    category: 'Layout & containers',
    keywords: ['column', 'columns', '3 columns', 'layout', 'grid', 'three'],
    Icon: Columns3,
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).insertLayout({ layoutType: 'three-equal' }).run();
    },
  },

  // --- Confluence macros ---
  {
    id: 'toc',
    title: 'Table of Contents',
    description: 'Auto-generated page outline and navigation macro',
    category: 'Confluence macros',
    keywords: ['toc', 'table of contents', 'outline', 'contents', 'headings', 'navigation', 'macro'],
    Icon: ListTree,
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).insertContent({ type: 'confluenceToc' }).run();
    },
  },
  {
    id: 'status',
    title: 'Status badge',
    description: 'Colored status badge (e.g. IN PROGRESS, DONE)',
    category: 'Confluence macros',
    keywords: ['status', 'badge', 'label', 'tag', 'pill', 'state', 'macro'],
    Icon: Badge,
    run: (editor, range) => {
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertContent({
          type: 'confluenceStatus',
          attrs: { color: 'blue', label: 'STATUS' },
        })
        .run();
    },
  },
  {
    id: 'attachments',
    title: 'Attachments macro',
    description: 'Embed list of uploaded files and documents',
    category: 'Confluence macros',
    keywords: ['attachments', 'files', 'uploads', 'documents', 'paperclip', 'macro'],
    Icon: Paperclip,
    run: (editor, range) => {
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertContent({ type: 'confluenceAttachments', attrs: { upload: 'false', old: 'false' } })
        .run();
    },
  },
  {
    id: 'children',
    title: 'Child pages macro',
    description: 'List sub-pages and nested documents',
    category: 'Confluence macros',
    keywords: ['children', 'subpages', 'child pages', 'tree', 'nested', 'macro'],
    Icon: ListTree,
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).insertContent({ type: 'confluenceChildren' }).run();
    },
  },
  {
    id: 'figureIndex',
    title: 'List of figures',
    description: 'Index of all captioned figures',
    category: 'Confluence macros',
    keywords: ['figures', 'figure index', 'illustrations', 'images', 'index', 'macro'],
    Icon: Images,
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).insertContent({ type: 'figureIndex' }).run();
    },
  },
  {
    id: 'tableIndex',
    title: 'List of tables',
    description: 'Index of all captioned tables',
    category: 'Confluence macros',
    keywords: ['tables', 'table index', 'data', 'index', 'macro', 'tabels'],
    Icon: Table2,
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).insertContent({ type: 'tableIndex' }).run();
    },
  },
];

export function filterSlashCommands(
  items: readonly SlashCommandItem[],
  query: string,
): SlashCommandItem[] {
  const cleanQuery = query.toLowerCase().trim();
  if (!cleanQuery) return [...items];

  return items.filter((item) => {
    const titleMatch = item.title.toLowerCase().includes(cleanQuery);
    const descMatch = item.description.toLowerCase().includes(cleanQuery);
    const keywordMatch = item.keywords.some((kw) => kw.toLowerCase().includes(cleanQuery));
    const shortcutMatch = item.shortcut?.toLowerCase().includes(cleanQuery);
    return titleMatch || descMatch || keywordMatch || shortcutMatch;
  });
}
