import { useRef, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Popover from '@radix-ui/react-popover';
import { useEditorState } from '@tiptap/react';
import type { Editor as EditorType } from '@tiptap/react';
import { TextSelection } from '@tiptap/pm/state';
import {
  Bold, Italic, Underline, Strikethrough, Code,
  List, ListOrdered, CheckSquare, Quote, Minus, Undo2, Redo2, ChevronDown, Plus,
  Table as TableIcon, Image as ImageIcon, CodeSquare, Columns2, Workflow, Badge,
  ChevronsUpDown, Hash, Paperclip, ListTree, ImagePlus, Table2,
  Images, Captions, Info, TriangleAlert, StickyNote, Lightbulb,
  Palette, Highlighter,
  AlignLeft, AlignCenter, AlignRight, AlignJustify,
} from 'lucide-react';
import { LAYOUT_PRESETS } from './article-extensions';
import { ToolbarButton, ToolbarSeparator, ToolbarGroup, LayoutPreview } from './editor-toolbar-primitives';
import { TOOLBAR_ITEM_ATTR, useToolbarRovingFocus } from './use-toolbar-roving-focus';
import { cn } from '../../lib/cn';

/**
 * The page editor's toolbar.
 *
 * It used to be 31 icon-only buttons in seven flat groups — every insert, every
 * caption tool and every heading level competing at the same visual weight, so
 * nothing in it told you that Undo is reached forty times an hour and "Insert
 * List of Tables" perhaps twice a year. Two of those icons were even the same
 * glyph for different actions.
 *
 * It is now twelve, plus undo/redo. The frequent operations stay on the surface
 * — marks, lists, colours — and the long tail moves behind two menus that say
 * what they are in words. Nothing was removed: every action the flat row
 * offered is still here, and the two menus put a NAME beside each one, which
 * the icon wall never did.
 *
 * The block-type control is the one genuinely new affordance. The old row
 * showed heading state only as "which of these three icons is lit"; the trigger
 * now reads the caret's block back to you in words.
 */

/* ------------------------------------------------------------------ menus -- */

/** Radix menu surface. `nm-card-elevated` is the app's one real shadow. */
const MENU_CONTENT = 'z-50 min-w-[13rem] nm-card-elevated p-1.5';

/**
 * A menu row. Denser than `UserMenu`'s (13px/6px against its 14px/8px) because
 * that menu holds five items and the Insert menu holds twelve; 13px on a 28px
 * row is ADR-010's own list-row density, not a new metric.
 */
const MENU_ITEM =
  'flex cursor-pointer select-none items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] ' +
  'text-muted-foreground outline-none transition-colors ' +
  'data-[highlighted]:bg-foreground/10 data-[highlighted]:text-foreground ' +
  'data-[state=open]:bg-foreground/10 data-[state=open]:text-foreground';

/**
 * Section heading inside a menu. Not focusable, not selectable — a signpost.
 * 12px, not 11: `ui-text-legibility.test.ts` holds uppercase to a higher floor
 * than body text, because capitals give up the ascender and descender cues that
 * carry small lowercase type.
 */
const MENU_LABEL =
  'px-2.5 pb-1 pt-2 text-[12px] font-medium uppercase tracking-wider text-muted-foreground';

/** Trigger shell shared by the two labelled menus, so they cannot drift apart. */
const menuTriggerClass = (open: boolean) =>
  cn(
    'inline-flex h-8 items-center gap-1.5 rounded-md border px-2 text-[13px] transition-colors',
    'outline-2 outline-offset-2 outline-transparent focus-visible:outline-ring',
    open
      ? 'border-border-interactive bg-background text-foreground'
      : 'border-transparent text-muted-foreground hover:bg-accent hover:text-foreground',
  );

/* ------------------------------------------------------------- insertions -- */

const STATUS_COLORS = [
  { label: 'Grey', value: 'grey', bg: '#6b7280' },
  { label: 'Blue', value: 'blue', bg: '#3b82f6' },
  { label: 'Green', value: 'green', bg: '#22c55e' },
  { label: 'Yellow', value: 'yellow', bg: '#eab308' },
  { label: 'Red', value: 'red', bg: '#ef4444' },
];

/**
 * The four Confluence panel macros, in the same order the content converter and
 * the `.panel-*` stylesheet rules use. `swatch` points at the very token each
 * panel is rendered with, so the picker cannot drift from the box the author
 * ends up looking at. Every entry pairs its colour with an icon and a text
 * label — the type must stay distinguishable without relying on hue.
 */
const PANEL_TYPES = [
  { value: 'info', label: 'Info', Icon: Info, swatch: 'var(--color-info)' },
  { value: 'warning', label: 'Warning', Icon: TriangleAlert, swatch: 'var(--color-warning)' },
  { value: 'note', label: 'Note', Icon: StickyNote, swatch: 'var(--color-primary)' },
  { value: 'tip', label: 'Tip', Icon: Lightbulb, swatch: 'var(--color-success)' },
] as const;

type PanelType = (typeof PANEL_TYPES)[number]['value'];

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

/**
 * Inserts `node` and leaves the caret inside its first child, so the author
 * types straight into the new box instead of underneath it.
 *
 * `insertContent` parks the caret *after* the new block whenever content
 * follows it. Finding the block again afterwards has one subtlety: both
 * containers this is used for **nest** (`Panel.content` is 'block+',
 * `Details.content` is 'detailsSummary block*'), so stopping descent at the
 * first matching node lands the caret in the *outer* container when one is
 * inserted inside an existing one (#1140). Visiting every descendant and
 * keeping the last match at-or-before the selection finds the innermost
 * instead: a nested node starts at a higher position than its parent, so it is
 * visited — and overwrites the match — after it.
 *
 * `+ 2` is inside the first child: one past the container's own boundary is
 * that child, one more is its text. Same transaction as the insert, so a single
 * undo removes the whole thing.
 */
function insertBlockWithCaret(editor: EditorType, typeName: string, node: Record<string, unknown>) {
  editor
    .chain()
    .focus()
    .insertContent(node)
    .command(({ tr, dispatch }) => {
      if (!dispatch) return true;
      const { from } = tr.selection;
      let caret: number | null = null;
      tr.doc.descendants((child, pos) => {
        if (child.type.name === typeName && pos <= from) {
          caret = pos + 2;
        }
        return true;
      });
      if (caret !== null) {
        tr.setSelection(TextSelection.create(tr.doc, caret));
      }
      return true;
    })
    .run();
}

/**
 * Inserts an empty panel and leaves the caret inside it, so the author types
 * straight into the box instead of clearing out placeholder copy first.
 */
function insertPanel(editor: EditorType, panelType: PanelType) {
  insertBlockWithCaret(editor, 'panel', {
    type: 'panel',
    attrs: { panelType },
    content: [{ type: 'paragraph' }],
  });
}

/**
 * Inserts an expand section with an EMPTY summary and leaves the caret in it.
 *
 * #1227: the summary used to be seeded with the literal `Click to expand`,
 * which an editor save then wrote to Confluence as a real `title` parameter —
 * the same fabricated title the backend fix removes, just sourced from the
 * toolbar instead of the converter. An untitled section now shows the macro's
 * default label as a decoration (article-extensions.ts) and stores nothing, so
 * a user who types gets a real title and a user who moves on to the body gets a
 * genuinely untitled section.
 */
function insertExpandSection(editor: EditorType, macroName: 'expand' | 'ui-expand' = 'expand') {
  insertBlockWithCaret(editor, 'details', {
    type: 'details',
    // A bare details node defaults to the native Atlassian expand for backwards
    // compatibility. Stamping macroName explicitly ensures htmlToConfluence
    // writes ac:name="expand" or ac:name="ui-expand" accordingly on save.
    attrs: { macroName },
    content: [
      { type: 'detailsSummary' },
      { type: 'paragraph', content: [{ type: 'text', text: 'Content here...' }] },
    ],
  });
}

/** Wrap the image at the caret in a `figure` so it can carry a caption. */
function captionSelectedImage(editor: EditorType) {
  const { from } = editor.state.selection;
  const node = editor.state.doc.nodeAt(from);
  if (node?.type.name !== 'image') return;
  editor
    .chain()
    .deleteRange({ from, to: from + node.nodeSize })
    .insertContentAt(from, {
      type: 'figure',
      content: [{ type: 'image', attrs: node.attrs }, { type: 'figcaption' }],
    })
    .run();
}

import { BlockTypeMenu } from './BlockTypeMenu';

/* ----------------------------------------------------------- insert menu -- */

/**
 * Two of the insert actions need a value from the user before they can run: an
 * image needs a URL, a status label needs its text and colour.
 *
 * They are Popovers opened FROM the menu rather than forms inside it, and that
 * is not a style choice. A Radix menu is `role="menu"`, whose typeahead
 * swallows printable keystrokes — the same trap documented for the editor block
 * menu, where a free-form Improve input inside a context menu could not be
 * typed into. Anything with a text field has to leave the menu.
 */
type PendingPrompt = 'image' | 'status' | null;

function InsertMenu({ editor }: { editor: EditorType }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<PendingPrompt>(null);
  // Read during the menu's close-autofocus, which fires before the state commit
  // is observable there. Without it Radix returns focus to the trigger at the
  // same moment the popover autofocuses its input, and the input loses.
  const pendingRef = useRef<PendingPrompt>(null);

  const [imageUrl, setImageUrl] = useState('');
  const [statusText, setStatusText] = useState('');
  const [statusColor, setStatusColor] = useState('blue');

  const requestPrompt = (kind: Exclude<PendingPrompt, null>) => {
    pendingRef.current = kind;
    setPending(kind);
  };

  const closePrompt = () => {
    pendingRef.current = null;
    setPending(null);
    setImageUrl('');
    setStatusText('');
    editor.commands?.focus?.();
  };

  const insertImage = () => {
    const url = imageUrl.trim();
    if (!url) return;
    editor.chain().focus().setImage({ src: url }).run();
    closePrompt();
  };

  const insertStatus = () => {
    editor
      .chain()
      .focus()
      .insertContent({
        type: 'confluenceStatus',
        attrs: { color: statusColor, label: statusText.trim() || 'STATUS' },
      })
      .run();
    closePrompt();
  };

  return (
    <Popover.Root open={pending !== null} onOpenChange={(next) => { if (!next) closePrompt(); }}>
      <Popover.Anchor asChild>
        <div className="relative">
          <DropdownMenu.Root open={open} onOpenChange={setOpen}>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                {...{ [TOOLBAR_ITEM_ATTR]: '' }}
                data-testid="insert-menu-trigger"
                title="Insert"
                aria-label="Insert"
                className={menuTriggerClass(open)}
              >
                <Plus size={15} className="shrink-0" />
                Insert
                <ChevronDown size={13} className="shrink-0 opacity-60" />
              </button>
            </DropdownMenu.Trigger>

            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="start"
                sideOffset={6}
                className={MENU_CONTENT}
                onCloseAutoFocus={(e) => {
                  // A prompt is about to take over; let it own the focus.
                  if (pendingRef.current) e.preventDefault();
                }}
              >
                <DropdownMenu.Item
                  onSelect={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
                  className={MENU_ITEM}
                >
                  <TableIcon size={15} className="shrink-0" />
                  Table
                </DropdownMenu.Item>

                {/* Trailing ellipsis: the platform convention for "this opens a
                    form", and here the honest signal that a URL is still owed. */}
                <DropdownMenu.Item onSelect={() => requestPrompt('image')} className={MENU_ITEM}>
                  <ImageIcon size={15} className="shrink-0" />
                  Image…
                </DropdownMenu.Item>

                <DropdownMenu.Item
                  onSelect={() => editor.chain().focus().insertDrawioDiagram().run()}
                  className={MENU_ITEM}
                >
                  <Workflow size={15} className="shrink-0" />
                  Diagram
                </DropdownMenu.Item>

                <DropdownMenu.Item onSelect={() => requestPrompt('status')} className={MENU_ITEM}>
                  <Badge size={15} className="shrink-0" />
                  Status label…
                </DropdownMenu.Item>

                <DropdownMenu.Item onSelect={() => insertExpandSection(editor, 'expand')} className={MENU_ITEM}>
                  <ChevronsUpDown size={15} className="shrink-0" />
                  Expand section
                </DropdownMenu.Item>

                <DropdownMenu.Item
                  onSelect={() => insertExpandSection(editor, 'ui-expand')}
                  className={MENU_ITEM}
                >
                  <ChevronsUpDown size={15} className="shrink-0" />
                  UI Expand section
                </DropdownMenu.Item>

                <DropdownMenu.Sub>
                  <DropdownMenu.SubTrigger className={MENU_ITEM}>
                    <Info size={15} className="shrink-0" />
                    Panel
                    <ChevronDown size={13} className="ml-auto -rotate-90 opacity-60" />
                  </DropdownMenu.SubTrigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.SubContent sideOffset={4} className={MENU_CONTENT}>
                      {PANEL_TYPES.map(({ value, label, Icon, swatch }) => (
                        <DropdownMenu.Item
                          key={value}
                          title={label}
                          onSelect={() => insertPanel(editor, value)}
                          className={MENU_ITEM}
                        >
                          <Icon size={15} className="shrink-0" style={{ color: swatch }} />
                          {label}
                        </DropdownMenu.Item>
                      ))}
                    </DropdownMenu.SubContent>
                  </DropdownMenu.Portal>
                </DropdownMenu.Sub>

                <DropdownMenu.Sub>
                  <DropdownMenu.SubTrigger className={MENU_ITEM}>
                    <Columns2 size={15} className="shrink-0" />
                    Column layout
                    <ChevronDown size={13} className="ml-auto -rotate-90 opacity-60" />
                  </DropdownMenu.SubTrigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.SubContent sideOffset={4} className={MENU_CONTENT}>
                      {LAYOUT_PRESETS.map((preset) => (
                        <DropdownMenu.Item
                          key={preset.type}
                          title={preset.label}
                          onSelect={() => editor.chain().focus().insertLayout({ layoutType: preset.type }).run()}
                          className={MENU_ITEM}
                        >
                          <LayoutPreview bars={preset.bars} className="shrink-0" />
                          {preset.label}
                        </DropdownMenu.Item>
                      ))}
                    </DropdownMenu.SubContent>
                  </DropdownMenu.Portal>
                </DropdownMenu.Sub>

                <DropdownMenu.Separator className="my-1 h-px bg-border" />

                <DropdownMenu.Item
                  onSelect={() =>
                    editor.chain().focus()
                      .insertContent({ type: 'confluenceAttachments', attrs: { upload: 'false', old: 'false' } })
                      .run()
                  }
                  className={MENU_ITEM}
                >
                  <Paperclip size={15} className="shrink-0" />
                  Attachments
                </DropdownMenu.Item>

                <DropdownMenu.Item
                  onSelect={() => editor.chain().focus().insertContent({ type: 'confluenceChildren' }).run()}
                  className={MENU_ITEM}
                >
                  <ListTree size={15} className="shrink-0" />
                  Child pages
                </DropdownMenu.Item>

                {/* A labelled SECTION, not a third submenu. A submenu earns its
                    hover-traverse only when the parent names one thing and the
                    children are its variants — "a panel" and "a layout" are
                    that; these four are unrelated actions that merely share a
                    subject. Flattening them also keeps the menu honest about
                    its own depth: two levels, not a tree. */}
                <DropdownMenu.Label className={MENU_LABEL}>Captions &amp; indexes</DropdownMenu.Label>

                <DropdownMenu.Item onSelect={() => captionSelectedImage(editor)} className={MENU_ITEM}>
                  <ImagePlus size={15} className="shrink-0" />
                  Caption for selected image
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  onSelect={() => editor.chain().focus().insertContent({ type: 'tableCaption' }).run()}
                  className={MENU_ITEM}
                >
                  <Captions size={15} className="shrink-0" />
                  Table caption
                </DropdownMenu.Item>
                {/* `Images`, not `ListTree`. The flat row gave this the same
                    glyph as "Child pages" two groups away — two different
                    actions, one icon, and no label to tell them apart. */}
                <DropdownMenu.Item
                  onSelect={() => editor.chain().focus().insertContent({ type: 'figureIndex' }).run()}
                  className={MENU_ITEM}
                >
                  <Images size={15} className="shrink-0" />
                  List of figures
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  onSelect={() => editor.chain().focus().insertContent({ type: 'tableIndex' }).run()}
                  className={MENU_ITEM}
                >
                  <Table2 size={15} className="shrink-0" />
                  List of tables
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </Popover.Anchor>

      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          className="z-50 w-64 nm-card-elevated p-3 outline-none"
          aria-label={pending === 'image' ? 'Insert image' : 'Insert status label'}
          onOpenAutoFocus={(e) => {
            // Focus the field, not the panel. Radix's default lands on the
            // content box, which costs a Tab before typing on the one surface
            // whose entire purpose is a text field.
            e.preventDefault();
            const el = e.currentTarget as HTMLElement;
            el.querySelector<HTMLInputElement>('input')?.focus();
          }}
        >
          {pending === 'image' && (
            <>
              <label htmlFor="editor-insert-image-url" className="mb-1.5 block text-[12px] font-medium text-foreground">
                Image URL
              </label>
              <input
                id="editor-insert-image-url"
                type="url"
                value={imageUrl}
                onChange={(e) => setImageUrl(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && insertImage()}
                placeholder="https://example.com/diagram.png"
                className="nm-input w-full text-[13px]"
              />
              <div className="mt-2.5 flex justify-end gap-2">
                <button type="button" onClick={closePrompt} aria-label="Cancel image" className="nm-button-ghost">
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={insertImage}
                  disabled={!imageUrl.trim()}
                  aria-label="Insert image"
                  className="nm-button-primary"
                >
                  Insert
                </button>
              </div>
            </>
          )}

          {pending === 'status' && (
            <>
              <span className="mb-1.5 block text-[12px] font-medium text-foreground">Status color</span>
              <div
                role="radiogroup"
                aria-label="Status color"
                className="mb-2.5 flex gap-1.5"
              >
                {STATUS_COLORS.map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    role="radio"
                    aria-checked={statusColor === c.value}
                    aria-label={c.label}
                    title={c.label}
                    onClick={() => setStatusColor(c.value)}
                    // 24px hit target (WCAG 2.5.5) with a 16px swatch drawn
                    // inside it, so selection has somewhere to land without
                    // growing the row or moving the box.
                    className={cn(
                      'flex h-6 w-6 items-center justify-center rounded-full border-2 transition-colors',
                      'outline-2 outline-offset-2 outline-transparent focus-visible:outline-ring',
                      statusColor === c.value ? 'border-foreground' : 'border-transparent',
                    )}
                  >
                    <span
                      className="block h-4 w-4 rounded-full"
                      style={{ backgroundColor: c.bg }}
                    />
                  </button>
                ))}
              </div>
              <label htmlFor="editor-insert-status-text" className="mb-1.5 block text-[12px] font-medium text-foreground">
                Label
              </label>
              <input
                id="editor-insert-status-text"
                type="text"
                value={statusText}
                onChange={(e) => setStatusText(e.target.value.toUpperCase())}
                onKeyDown={(e) => e.key === 'Enter' && insertStatus()}
                placeholder="IN PROGRESS"
                className="nm-input w-full text-[13px] uppercase"
              />
              <div className="mt-2.5 flex justify-end gap-2">
                <button type="button" onClick={closePrompt} aria-label="Cancel status label" className="nm-button-ghost">
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={insertStatus}
                  aria-label="Insert status label"
                  className="nm-button-primary"
                >
                  Insert
                </button>
              </div>
            </>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/* --------------------------------------------------------------- colours -- */

/**
 * #353: built on Radix Popover so keyboard / screen-reader users get proper
 * focus management (Escape to close, focus returns to trigger, click-outside
 * dismiss). The trigger is now 32px like every other control in the row rather
 * than the 36px it used to be — still clear of WCAG 2.5.5's 24×24 floor, and no
 * longer the two odd-sized boxes in the toolbar.
 *
 * The applied colour shows as a bar under the glyph rather than as a pressed
 * box: it has to say WHICH colour is applied, which a state fill cannot.
 */
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

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          {...{ [TOOLBAR_ITEM_ATTR]: '' }}
          title={title}
          aria-label={title}
          aria-haspopup="dialog"
          data-testid="color-picker-trigger"
          className="nm-icon-button"
        >
          <span className="relative flex items-center justify-center">
            {icon}
            {activeColor && (
              <span
                aria-hidden
                className="absolute -bottom-1.5 left-0 right-0 h-[3px] rounded-full"
                style={{ backgroundColor: activeColor }}
              />
            )}
          </span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          aria-label={`${title} swatches`}
          className="z-50 nm-card-elevated p-2.5 outline-none"
        >
          <div className="grid grid-cols-4 gap-1.5">
            {PRESET_COLORS.map((c) => (
              <button
                key={c.value}
                type="button"
                title={c.label}
                aria-label={c.label}
                aria-pressed={activeColor === c.value}
                data-testid="color-picker-swatch"
                onClick={() => {
                  onSelect(c.value);
                  setOpen(false);
                }}
                className={cn(
                  'h-7 w-7 rounded-md border outline-2 outline-offset-2 outline-transparent focus-visible:outline-ring',
                  activeColor === c.value ? 'border-foreground' : 'border-border',
                )}
                style={{ backgroundColor: c.value }}
              />
            ))}
          </div>
          <button
            type="button"
            onClick={() => {
              onReset();
              setOpen(false);
            }}
            className="mt-2 w-full rounded-md px-2 py-1 text-xs text-muted-foreground outline-2 outline-offset-2 outline-transparent transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-ring"
          >
            Reset
          </button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function AlignMenuDropdown({ editor }: { editor: EditorType }) {
  const [open, setOpen] = useState(false);
  const activeState = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      alignLeft: e.isActive({ textAlign: 'left' }),
      alignCenter: e.isActive({ textAlign: 'center' }),
      alignRight: e.isActive({ textAlign: 'right' }),
      alignJustify: e.isActive({ textAlign: 'justify' }),
    }),
  });

  const CurrentIcon = activeState.alignCenter
    ? AlignCenter
    : activeState.alignRight
      ? AlignRight
      : activeState.alignJustify
        ? AlignJustify
        : AlignLeft;

  const currentLabel = activeState.alignCenter
    ? 'Align Center'
    : activeState.alignRight
      ? 'Align Right'
      : activeState.alignJustify
        ? 'Justify'
        : 'Align Left';

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          {...{ [TOOLBAR_ITEM_ATTR]: '' }}
          data-testid="align-menu-trigger"
          title={`Text alignment: ${currentLabel}`}
          aria-label={`Text alignment: ${currentLabel}`}
          className={menuTriggerClass(open)}
        >
          <CurrentIcon size={15} className="shrink-0" />
          <ChevronDown size={13} className="shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={6} className={MENU_CONTENT}>
          <DropdownMenu.Item
            onSelect={() => editor.chain().focus().setTextAlign('left').run()}
            className={cn(MENU_ITEM, activeState.alignLeft && 'bg-foreground/[0.06] font-medium text-foreground')}
          >
            <AlignLeft size={15} className="shrink-0" />
            Align Left
          </DropdownMenu.Item>
          <DropdownMenu.Item
            onSelect={() => editor.chain().focus().setTextAlign('center').run()}
            className={cn(MENU_ITEM, activeState.alignCenter && 'bg-foreground/[0.06] font-medium text-foreground')}
          >
            <AlignCenter size={15} className="shrink-0" />
            Align Center
          </DropdownMenu.Item>
          <DropdownMenu.Item
            onSelect={() => editor.chain().focus().setTextAlign('right').run()}
            className={cn(MENU_ITEM, activeState.alignRight && 'bg-foreground/[0.06] font-medium text-foreground')}
          >
            <AlignRight size={15} className="shrink-0" />
            Align Right
          </DropdownMenu.Item>
          <DropdownMenu.Item
            onSelect={() => editor.chain().focus().setTextAlign('justify').run()}
            className={cn(MENU_ITEM, activeState.alignJustify && 'bg-foreground/[0.06] font-medium text-foreground')}
          >
            <AlignJustify size={15} className="shrink-0" />
            Justify
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/* --------------------------------------------------------------- toolbar -- */

export function EditorToolbar({
  editor,
  headerNumbering,
  onToggleHeaderNumbering,
}: {
  editor: EditorType;
  headerNumbering?: boolean;
  onToggleHeaderNumbering?: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const roving = useToolbarRovingFocus(rootRef);

  // Subscribe to editor state so the toggles re-render on selection and
  // formatting changes (#16).
  const activeState = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      strike: e.isActive('strike'),
      underline: e.isActive('underline'),
      code: e.isActive('code'),
      blockquote: e.isActive('blockquote'),
      codeBlock: e.isActive('codeBlock'),
      bulletList: e.isActive('bulletList'),
      orderedList: e.isActive('orderedList'),
      taskList: e.isActive('taskList'),
      textColor: e.getAttributes('textStyle').color as string | undefined,
      highlightColor: e.getAttributes('highlight').color as string | undefined,
    }),
  });

  return (
    // Reading order is the shape of a sentence about the document: what this
    // block IS, then how the words look, then how they are listed, then their
    // colour, then what else can go here. Utilities are pushed to the far end
    // because undo/redo act on the session rather than on the selection.
    <div
      ref={rootRef}
      role="toolbar"
      aria-label="Page editor toolbar"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1.5 sm:gap-x-0.5"
      onKeyDown={roving.onKeyDown}
      onFocus={roving.onFocus}
    >
      <ToolbarGroup name="block">
        <BlockTypeMenu editor={editor} />
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
          active={activeState.blockquote}
          title="Quote"
        >
          <Quote size={16} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleCodeBlock().run()}
          active={activeState.codeBlock}
          title="Code Block"
        >
          <CodeSquare size={16} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().setHorizontalRule().run()}
          title="Divider"
        >
          <Minus size={16} />
        </ToolbarButton>
      </ToolbarGroup>

      <ToolbarSeparator />

      <ToolbarGroup name="inline">
        <ToolbarButton onClick={() => editor.chain().focus().toggleBold().run()} active={activeState.bold} title="Bold (Ctrl+B)">
          <Bold size={16} />
        </ToolbarButton>
        <ToolbarButton onClick={() => editor.chain().focus().toggleItalic().run()} active={activeState.italic} title="Italic (Ctrl+I)">
          <Italic size={16} />
        </ToolbarButton>
        <ToolbarButton onClick={() => editor.chain().focus().toggleUnderline().run()} active={activeState.underline} title="Underline (Ctrl+U)">
          <Underline size={16} />
        </ToolbarButton>
        <ToolbarButton onClick={() => editor.chain().focus().toggleStrike().run()} active={activeState.strike} title="Strikethrough (Ctrl+Shift+X)">
          <Strikethrough size={16} />
        </ToolbarButton>
        <ToolbarButton onClick={() => editor.chain().focus().toggleCode().run()} active={activeState.code} title="Inline Code (Ctrl+E)">
          <Code size={16} />
        </ToolbarButton>
      </ToolbarGroup>

      <ToolbarSeparator />

      <ToolbarGroup name="align">
        <AlignMenuDropdown editor={editor} />
      </ToolbarGroup>

      <ToolbarSeparator />

      <ToolbarGroup name="lists">
        <ToolbarButton onClick={() => editor.chain().focus().toggleBulletList().run()} active={activeState.bulletList} title="Bullet List (Ctrl+Shift+8)">
          <List size={16} />
        </ToolbarButton>
        <ToolbarButton onClick={() => editor.chain().focus().toggleOrderedList().run()} active={activeState.orderedList} title="Ordered List (Ctrl+Shift+7)">
          <ListOrdered size={16} />
        </ToolbarButton>
        <ToolbarButton onClick={() => editor.chain().focus().toggleTaskList().run()} active={activeState.taskList} title="Task List">
          <CheckSquare size={16} />
        </ToolbarButton>
      </ToolbarGroup>

      <ToolbarSeparator />

      <ToolbarGroup name="colors">
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
      </ToolbarGroup>

      <ToolbarSeparator />

      <ToolbarGroup name="insert">
        <InsertMenu editor={editor} />
      </ToolbarGroup>

      <div className="hidden flex-1 sm:block" />

      <ToolbarGroup name="utilities">
        {onToggleHeaderNumbering && (
          <ToolbarButton
            onClick={onToggleHeaderNumbering}
            active={headerNumbering}
            title={headerNumbering ? 'Header Numbering (On)' : 'Header Numbering (Off)'}
            label={headerNumbering ? 'Header Numbering (On)' : 'Header Numbering (Off)'}
          >
            <Hash size={16} />
          </ToolbarButton>
        )}
        <ToolbarButton onClick={() => editor.chain().focus().undo().run()} disabled={!editor.can().undo()} title="Undo">
          <Undo2 size={16} />
        </ToolbarButton>
        <ToolbarButton onClick={() => editor.chain().focus().redo().run()} disabled={!editor.can().redo()} title="Redo">
          <Redo2 size={16} />
        </ToolbarButton>
      </ToolbarGroup>
    </div>
  );
}
