import { useEffect, useRef, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Popover from '@radix-ui/react-popover';
import { useEditorState } from '@tiptap/react';
import type { Editor as EditorType } from '@tiptap/react';
import {
  Bold, Italic, Underline, Strikethrough, Code, Code2,
  List, ListOrdered, CheckSquare, Quote, Minus, Undo2, Redo2, ChevronDown, Plus,
  Table as TableIcon, Image as ImageIcon, CodeSquare, Columns2, Workflow, Badge,
  ChevronsUpDown, Paperclip, ListTree, ImagePlus, Table2,
  Images, Captions, Info, TriangleAlert, StickyNote, Lightbulb,
  Baseline, Highlighter,
  AlignLeft, AlignCenter, AlignRight, AlignJustify,
  Smile, MoreHorizontal,
} from 'lucide-react';
import {
  LAYOUT_PRESETS,
  insertPanel,
  insertExpandSection,
  captionSelectedImage,
} from './article-extensions';
import { ToolbarButton, ToolbarSeparator, ToolbarGroup, LayoutPreview } from './editor-toolbar-primitives';
import { TOOLBAR_ITEM_ATTR, useToolbarRovingFocus } from './use-toolbar-roving-focus';
import { insertTableCaption } from './table-cell-selection';
import { BlockTypeMenu } from './BlockTypeMenu';
import { EmojiPicker, EmojiPickerContent } from './EmojiPicker';
export { EmojiPicker };
import { absorbPortalEscape } from '../../lib/absorb-portal-escape';
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
  'text-muted-foreground outline-none ' +
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
    'inline-flex h-8 items-center gap-1.5 rounded-md border px-2 text-[13px] transition-colors duration-75',
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
type PendingPrompt = 'image' | 'status' | 'emoji' | null;

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

                <DropdownMenu.Item
                  onSelect={() =>
                    editor
                      .chain()
                      .focus()
                      .insertContent({ type: 'mermaidBlock', attrs: { code: 'graph TD;\n  A-->B;' } })
                      .run()
                  }
                  className={MENU_ITEM}
                >
                  <Code2 size={15} className="shrink-0" />
                  Mermaid diagram
                </DropdownMenu.Item>

                <DropdownMenu.Item onSelect={() => requestPrompt('status')} className={MENU_ITEM}>
                  <Badge size={15} className="shrink-0" />
                  Status label…
                </DropdownMenu.Item>

                <DropdownMenu.Item onSelect={() => requestPrompt('emoji')} className={MENU_ITEM}>
                  <Smile size={15} className="shrink-0" />
                  Emoji…
                </DropdownMenu.Item>

                <DropdownMenu.Item onSelect={() => editor.chain().focus().toggleBlockquote().run()} className={MENU_ITEM}>
                  <Quote size={15} className="shrink-0" />
                  Quote
                </DropdownMenu.Item>

                <DropdownMenu.Item onSelect={() => editor.chain().focus().toggleCodeBlock().run()} className={MENU_ITEM}>
                  <CodeSquare size={15} className="shrink-0" />
                  Code block
                </DropdownMenu.Item>

                <DropdownMenu.Item onSelect={() => editor.chain().focus().setHorizontalRule().run()} className={MENU_ITEM}>
                  <Minus size={15} className="shrink-0" />
                  Divider
                </DropdownMenu.Item>

                <DropdownMenu.Item onSelect={() => insertExpandSection(editor, 'expand')} className={MENU_ITEM}>
                  <ChevronsUpDown size={15} className="shrink-0" />
                  Expand section
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
                  onSelect={() => insertTableCaption(editor)}
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
          className={cn(
            'z-50 nm-card-elevated outline-none',
            pending === 'emoji' ? 'w-80 p-2.5 rounded-lg border border-border' : 'w-64 p-3',
          )}
          aria-label={
            pending === 'image'
              ? 'Insert image'
              : pending === 'status'
                ? 'Insert status label'
                : 'Emoji Picker'
          }
          onOpenAutoFocus={(e) => {
            // Focus the field, not the panel. Radix's default lands on the
            // content box, which costs a Tab before typing on the one surface
            // whose entire purpose is a text field.
            e.preventDefault();
            const el = e.currentTarget as HTMLElement;
            el.querySelector<HTMLInputElement>('input')?.focus();
          }}
          onEscapeKeyDown={(e) => absorbPortalEscape(e, closePrompt)}
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

          {pending === 'emoji' && (
            <EmojiPickerContent editor={editor} onClose={closePrompt} />
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

/**
 * A colour picker rendered as `DropdownMenu.Sub` content, for use INSIDE
 * `MoreFormattingMenu`. Deliberately not `ColorPickerDropdown` (a separate
 * `Popover.Root`) nested inside another menu's content: two independent
 * Radix overlay roots nested that way is the classic trap where the outer
 * menu's outside-click detection treats the inner Popover's portalled
 * content as "outside" and closes prematurely. `DropdownMenu.Sub` is the
 * primitive built for nesting inside one root — the same pattern already
 * proven here by the Insert menu's Panel and Column-layout submenus.
 */
function ColorSwatchSub({
  icon,
  label,
  activeColor,
  onSelect,
  onReset,
  onDone,
}: {
  icon: React.ReactNode;
  label: string;
  activeColor: string | undefined;
  onSelect: (color: string) => void;
  onReset: () => void;
  onDone: () => void;
}) {
  return (
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger className={MENU_ITEM}>
        {icon}
        {label}
        <ChevronDown size={13} className="ml-auto -rotate-90 opacity-60" />
      </DropdownMenu.SubTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.SubContent sideOffset={4} className={cn(MENU_CONTENT, 'w-auto p-2.5')}>
          <div className="grid grid-cols-4 gap-1.5">
            {PRESET_COLORS.map((c) => (
              <button
                key={c.value}
                type="button"
                title={c.label}
                aria-label={c.label}
                aria-pressed={activeColor === c.value}
                onClick={() => { onSelect(c.value); onDone(); }}
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
            onClick={() => { onReset(); onDone(); }}
            className="mt-2 w-full rounded-md px-2 py-1 text-xs text-muted-foreground outline-2 outline-offset-2 outline-transparent transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-ring"
          >
            Reset
          </button>
        </DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
  );
}

/**
 * The overflow home for controls the responsive fold has no other place to
 * put. Quote/Code block/Divider and Emoji already live in the Insert menu
 * unconditionally, so hiding their toolbar buttons costs nothing — but
 * Strikethrough, Inline Code, Task List, Alignment, Text Color and Highlight
 * had NO other home: at the app's own default 1440px layout (both side
 * panels open, ~645px of toolbar width) all six vanished with no way to
 * reach them at all (#P2). This renders nothing when every one of them is
 * already visible as its own button.
 */
function MoreFormattingMenu({
  editor,
  activeState,
  showTaskList,
  showCode,
  showStrike,
  showAlign,
  showColors,
}: {
  editor: EditorType;
  activeState: {
    taskList: boolean;
    code: boolean;
    strike: boolean;
    textColor: string | undefined;
    highlightColor: string | undefined;
  };
  showTaskList: boolean;
  showCode: boolean;
  showStrike: boolean;
  showAlign: boolean;
  showColors: boolean;
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  const alignState = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      alignLeft: e.isActive({ textAlign: 'left' }),
      alignCenter: e.isActive({ textAlign: 'center' }),
      alignRight: e.isActive({ textAlign: 'right' }),
      alignJustify: e.isActive({ textAlign: 'justify' }),
    }),
  });

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          {...{ [TOOLBAR_ITEM_ATTR]: '' }}
          data-testid="more-formatting-trigger"
          title="More formatting"
          aria-label="More formatting"
          className={menuTriggerClass(open)}
        >
          <MoreHorizontal size={15} className="shrink-0" />
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={6} className={MENU_CONTENT}>
          {!showTaskList && (
            <DropdownMenu.Item
              onSelect={() => editor.chain().focus().toggleTaskList().run()}
              className={cn(MENU_ITEM, activeState.taskList && 'bg-foreground/[0.06] font-medium text-foreground')}
            >
              <CheckSquare size={15} className="shrink-0" />
              Task List
            </DropdownMenu.Item>
          )}
          {!showCode && (
            <DropdownMenu.Item
              onSelect={() => editor.chain().focus().toggleCode().run()}
              className={cn(MENU_ITEM, activeState.code && 'bg-foreground/[0.06] font-medium text-foreground')}
            >
              <Code size={15} className="shrink-0" />
              Inline Code
            </DropdownMenu.Item>
          )}
          {!showStrike && (
            <DropdownMenu.Item
              onSelect={() => editor.chain().focus().toggleStrike().run()}
              className={cn(MENU_ITEM, activeState.strike && 'bg-foreground/[0.06] font-medium text-foreground')}
            >
              <Strikethrough size={15} className="shrink-0" />
              Strikethrough
            </DropdownMenu.Item>
          )}

          {!showAlign && (
            <DropdownMenu.Sub>
              <DropdownMenu.SubTrigger className={MENU_ITEM}>
                <AlignLeft size={15} className="shrink-0" />
                Alignment
                <ChevronDown size={13} className="ml-auto -rotate-90 opacity-60" />
              </DropdownMenu.SubTrigger>
              <DropdownMenu.Portal>
                <DropdownMenu.SubContent sideOffset={4} className={MENU_CONTENT}>
                  <DropdownMenu.Item
                    onSelect={() => editor.chain().focus().setTextAlign('left').run()}
                    className={cn(MENU_ITEM, alignState.alignLeft && 'bg-foreground/[0.06] font-medium text-foreground')}
                  >
                    <AlignLeft size={15} className="shrink-0" />
                    Align Left
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    onSelect={() => editor.chain().focus().setTextAlign('center').run()}
                    className={cn(MENU_ITEM, alignState.alignCenter && 'bg-foreground/[0.06] font-medium text-foreground')}
                  >
                    <AlignCenter size={15} className="shrink-0" />
                    Align Center
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    onSelect={() => editor.chain().focus().setTextAlign('right').run()}
                    className={cn(MENU_ITEM, alignState.alignRight && 'bg-foreground/[0.06] font-medium text-foreground')}
                  >
                    <AlignRight size={15} className="shrink-0" />
                    Align Right
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    onSelect={() => editor.chain().focus().setTextAlign('justify').run()}
                    className={cn(MENU_ITEM, alignState.alignJustify && 'bg-foreground/[0.06] font-medium text-foreground')}
                  >
                    <AlignJustify size={15} className="shrink-0" />
                    Justify
                  </DropdownMenu.Item>
                </DropdownMenu.SubContent>
              </DropdownMenu.Portal>
            </DropdownMenu.Sub>
          )}

          {!showColors && (
            <>
              <ColorSwatchSub
                icon={<Baseline size={15} className="shrink-0" />}
                label="Text Color"
                activeColor={activeState.textColor}
                onSelect={(color) => editor.chain().focus().setColor(color).run()}
                onReset={() => editor.chain().focus().unsetColor().run()}
                onDone={close}
              />
              <ColorSwatchSub
                icon={<Highlighter size={15} className="shrink-0" />}
                label="Highlight"
                activeColor={activeState.highlightColor}
                onSelect={(color) => editor.chain().focus().toggleHighlight({ color }).run()}
                onReset={() => editor.chain().focus().unsetHighlight().run()}
                onDone={close}
              />
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/* --------------------------------------------------------------- toolbar -- */

function useToolbarContainerWidth(ref: React.RefObject<HTMLDivElement | null>) {
  // Default to 1200 so tests (in jsdom) and initial SSR render include all controls.
  const [width, setWidth] = useState<number>(1200);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (el.clientWidth > 0) {
      setWidth(el.clientWidth);
    }

    if (typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const measured = entry.contentRect?.width || el.clientWidth;
        if (measured > 0) {
          setWidth(measured);
        }
      }
    });

    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);

  return width;
}

export function EditorToolbar({
  editor,
  headerNumbering,
  onToggleHeaderNumbering,
  actions,
}: {
  editor: EditorType;
  headerNumbering?: boolean;
  onToggleHeaderNumbering?: () => void;
  actions?: React.ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const containerWidth = useToolbarContainerWidth(containerRef);

  const rootRef = useRef<HTMLDivElement>(null);
  const roving = useToolbarRovingFocus(rootRef);

  // Responsive folding based on actual available toolbar container width:
  // Thresholds start folding secondary tools early so Save/Cancel actions and tags
  // on the right always remain fully visible and accessible across all container widths.
  const showBlockActions = containerWidth >= 1060;
  const showAlign = containerWidth >= 980;
  const showColors = containerWidth >= 900;
  const showTaskList = containerWidth >= 820;
  const showCode = containerWidth >= 820;
  const showStrike = containerWidth >= 760;
  const showEmojiButton = containerWidth >= 700;
  const showOrderedList = containerWidth >= 640;
  const showUnderline = containerWidth >= 640;

  // Strikethrough, Inline Code, Task List, Alignment, Text Color and
  // Highlight have no other home when the fold hides them — unlike Quote/
  // Code block/Divider/Emoji, which always live in the Insert menu too.
  const showMoreFormatting = !(showTaskList && showCode && showStrike && showAlign && showColors);

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
    // Single non-wrapping row: actions live on the right, formatting tools on
    // the left. When the container is narrow, secondary controls gracefully fold
    // into the Insert dropdown and BlockTypeMenu so the toolbar never generates
    // horizontal scrollbars or expands the document width.
    <div
      ref={containerRef}
      className="flex h-[calc(3rem-1px)] min-h-[calc(3rem-1px)] w-full flex-nowrap items-center justify-between gap-x-1 sm:gap-x-2 py-1 px-1"
    >
      <div
        ref={rootRef}
        role="toolbar"
        aria-label="Page editor toolbar"
        // `min-w-0` lets the flex algorithm shrink this group below its
        // content's natural width when the row is too narrow for the
        // actions group beside it; without `overflow-x-auto` that shrunk
        // box does not clip its own children — the default `overflow:
        // visible` lets them keep painting at full size past the box's
        // right edge, landing on top of Save/Cancel/Tags rather than
        // simply overflowing off-screen (#P0 mobile edit toolbar).
        className="flex min-w-0 flex-nowrap items-center gap-x-0.5 overflow-x-auto sm:gap-x-1"
        onKeyDown={roving.onKeyDown}
        onFocus={roving.onFocus}
      >
        <ToolbarGroup name="history">
          <ToolbarButton onClick={() => editor.chain().focus().undo().run()} disabled={!editor.can().undo()} title="Undo">
            <Undo2 size={15} />
          </ToolbarButton>
          <ToolbarButton onClick={() => editor.chain().focus().redo().run()} disabled={!editor.can().redo()} title="Redo">
            <Redo2 size={15} />
          </ToolbarButton>
        </ToolbarGroup>

        <ToolbarSeparator />

        <ToolbarGroup name="block-type">
          <BlockTypeMenu
            editor={editor}
            headerNumbering={headerNumbering}
            onToggleHeaderNumbering={onToggleHeaderNumbering}
          />
        </ToolbarGroup>

        <ToolbarSeparator />

        <ToolbarGroup name="inline">
          <ToolbarButton onClick={() => editor.chain().focus().toggleBold().run()} active={activeState.bold} title="Bold (Ctrl+B)">
            <Bold size={15} />
          </ToolbarButton>
          <ToolbarButton onClick={() => editor.chain().focus().toggleItalic().run()} active={activeState.italic} title="Italic (Ctrl+I)">
            <Italic size={15} />
          </ToolbarButton>
          {showUnderline && (
            <ToolbarButton onClick={() => editor.chain().focus().toggleUnderline().run()} active={activeState.underline} title="Underline (Ctrl+U)">
              <Underline size={15} />
            </ToolbarButton>
          )}
          {showStrike && (
            <ToolbarButton onClick={() => editor.chain().focus().toggleStrike().run()} active={activeState.strike} title="Strikethrough (Ctrl+Shift+X)">
              <Strikethrough size={15} />
            </ToolbarButton>
          )}
          {showCode && (
            <ToolbarButton onClick={() => editor.chain().focus().toggleCode().run()} active={activeState.code} title="Inline Code (Ctrl+E)">
              <Code size={15} />
            </ToolbarButton>
          )}
        </ToolbarGroup>

        <ToolbarSeparator />

        <ToolbarGroup name="lists">
          <ToolbarButton onClick={() => editor.chain().focus().toggleBulletList().run()} active={activeState.bulletList} title="Bullet List (Ctrl+Shift+8)">
            <List size={15} />
          </ToolbarButton>
          {showOrderedList && (
            <ToolbarButton onClick={() => editor.chain().focus().toggleOrderedList().run()} active={activeState.orderedList} title="Ordered List (Ctrl+Shift+7)">
              <ListOrdered size={15} />
            </ToolbarButton>
          )}
          {showTaskList && (
            <ToolbarButton onClick={() => editor.chain().focus().toggleTaskList().run()} active={activeState.taskList} title="Task List">
              <CheckSquare size={15} />
            </ToolbarButton>
          )}
          {showAlign && (
            <AlignMenuDropdown editor={editor} />
          )}
        </ToolbarGroup>

        {showMoreFormatting && (
          <>
            <ToolbarSeparator />
            <ToolbarGroup name="more-formatting">
              <MoreFormattingMenu
                editor={editor}
                activeState={activeState}
                showTaskList={showTaskList}
                showCode={showCode}
                showStrike={showStrike}
                showAlign={showAlign}
                showColors={showColors}
              />
            </ToolbarGroup>
          </>
        )}

        {showBlockActions && (
          <>
            <ToolbarSeparator />
            <ToolbarGroup name="block-actions">
              <ToolbarButton
                onClick={() => editor.chain().focus().toggleBlockquote().run()}
                active={activeState.blockquote}
                title="Quote"
              >
                <Quote size={15} />
              </ToolbarButton>
              <ToolbarButton
                onClick={() => editor.chain().focus().toggleCodeBlock().run()}
                active={activeState.codeBlock}
                title="Code Block"
              >
                <CodeSquare size={15} />
              </ToolbarButton>
              <ToolbarButton
                onClick={() => editor.chain().focus().setHorizontalRule().run()}
                title="Divider"
              >
                <Minus size={15} />
              </ToolbarButton>
            </ToolbarGroup>
          </>
        )}

        {showColors && (
          <>
            <ToolbarSeparator />
            <ToolbarGroup name="colors">
              <ColorPickerDropdown
                icon={<Baseline size={15} />}
                title="Text Color"
                activeColor={activeState.textColor}
                onSelect={(color) => editor.chain().focus().setColor(color).run()}
                onReset={() => editor.chain().focus().unsetColor().run()}
              />
              <ColorPickerDropdown
                icon={<Highlighter size={15} />}
                title="Highlight (Ctrl+Shift+H)"
                activeColor={activeState.highlightColor}
                onSelect={(color) => editor.chain().focus().toggleHighlight({ color }).run()}
                onReset={() => editor.chain().focus().unsetHighlight().run()}
              />
            </ToolbarGroup>
          </>
        )}

        <ToolbarSeparator />

        <ToolbarGroup name="insert">
          {showEmojiButton && (
            <EmojiPicker editor={editor} />
          )}
          <InsertMenu editor={editor} />
        </ToolbarGroup>
      </div>

      {actions && (
        <div role="group" aria-label="Page actions" className="ml-auto flex flex-nowrap shrink-0 items-center gap-1.5 pl-2">
          {actions}
        </div>
      )}
    </div>
  );
}
