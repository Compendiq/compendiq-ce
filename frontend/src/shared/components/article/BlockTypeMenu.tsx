import { useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useEditorState } from '@tiptap/react';
import type { Editor as EditorType } from '@tiptap/react';
import { Heading1, Heading2, Heading3, Heading4, Type, ChevronDown, Hash, Check } from 'lucide-react';
import { TOOLBAR_ITEM_ATTR } from './use-toolbar-roving-focus';
import { formatKeysForPlatform } from '../../lib/shortcut-registry';
import { isMac } from '../../lib/platform';
import { cn } from '../../lib/cn';

const MENU_CONTENT =
  'z-50 min-w-[13rem] nm-card-elevated p-1 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95';

const MENU_ITEM =
  'flex cursor-pointer select-none items-center gap-2.5 rounded-md px-2.5 py-1.5 text-xs ' +
  'text-foreground/90 outline-none transition-colors ' +
  'hover:bg-accent/70 hover:text-foreground ' +
  'data-[highlighted]:bg-accent/70 data-[highlighted]:text-foreground ' +
  'data-[state=open]:bg-accent/70 data-[state=open]:text-foreground';

const menuTriggerClass = (open: boolean) =>
  cn(
    'inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors select-none',
    'outline-2 outline-offset-2 outline-transparent focus-visible:outline-ring',
    open
      ? 'border-border-interactive bg-accent text-foreground shadow-sm'
      : 'border-border/60 bg-muted/40 text-foreground/90 hover:border-border hover:bg-accent/70 hover:text-foreground',
  );

function MenuShortcut({ keys }: { keys: string }) {
  return (
    <kbd className="ml-auto pl-2 font-mono text-[11px] text-muted-foreground/70 bg-muted/40 px-1.5 py-0.5 rounded border border-border/30">
      {formatKeysForPlatform(keys, isMac())}
    </kbd>
  );
}

interface BlockTypeOption {
  key: string;
  label: string;
  Icon: typeof Type;
  keys?: string;
}

const BLOCK_TYPE_OPTIONS: readonly BlockTypeOption[] = [
  { key: 'h1', label: 'Heading 1', Icon: Heading1, keys: 'ctrl+alt+1' },
  { key: 'h2', label: 'Heading 2', Icon: Heading2, keys: 'ctrl+alt+2' },
  { key: 'h3', label: 'Heading 3', Icon: Heading3, keys: 'ctrl+alt+3' },
  { key: 'h4', label: 'Heading 4', Icon: Heading4, keys: 'ctrl+alt+4' },
  { key: 'paragraph', label: 'Text', Icon: Type },
];

function resolveActiveKey(
  editor: EditorType,
  getRange?: () => { from: number; to: number } | null,
): string | null {
  if (getRange) {
    const range = getRange();
    if (range) {
      const parentNode = editor.state.doc.resolve(range.from).parent;
      if (parentNode.type.name === 'heading') {
        return `h${parentNode.attrs.level}`;
      }
      if (parentNode.type.name === 'paragraph') {
        return 'paragraph';
      }
    }
  }
  if (editor.isActive('heading', { level: 1 })) return 'h1';
  if (editor.isActive('heading', { level: 2 })) return 'h2';
  if (editor.isActive('heading', { level: 3 })) return 'h3';
  if (editor.isActive('heading', { level: 4 })) return 'h4';
  if (editor.isActive('paragraph')) return 'paragraph';
  return null;
}

function runBlockType(
  editor: EditorType,
  key: string,
  getRange?: () => { from: number; to: number } | null,
) {
  const chain = editor.chain().focus();
  if (getRange) {
    const range = getRange();
    if (range) {
      chain.setTextSelection(range);
    }
  }
  if (key === 'h1') chain.setHeading({ level: 1 }).run();
  else if (key === 'h2') chain.setHeading({ level: 2 }).run();
  else if (key === 'h3') chain.setHeading({ level: 3 }).run();
  else if (key === 'h4') chain.setHeading({ level: 4 }).run();
  else if (key === 'paragraph') chain.setParagraph().run();
}

export function BlockTypeMenu({
  editor,
  getRange,
  className,
  headerNumbering,
  onToggleHeaderNumbering,
}: {
  editor: EditorType;
  getRange?: () => { from: number; to: number } | null;
  className?: string;
  /** The toolbar's document-level heading-numbering preference. */
  headerNumbering?: boolean;
  onToggleHeaderNumbering?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { activeKey } = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      activeKey: resolveActiveKey(e, getRange),
    }),
  });

  const current = BLOCK_TYPE_OPTIONS.find((t) => t.key === activeKey);
  const CurrentIcon = current?.Icon ?? Type;

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          {...{ [TOOLBAR_ITEM_ATTR]: '' }}
          data-testid="block-type-trigger"
          title="Text style"
          aria-label={`Text style: ${current?.label ?? 'Text'}`}
          className={cn(menuTriggerClass(open), 'w-[6.5rem] justify-start', className)}
        >
          <CurrentIcon size={15} className="shrink-0 text-muted-foreground" />
          <span className="truncate">{current?.label ?? 'Text'}</span>
          <ChevronDown size={13} className="ml-auto shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={6} className={MENU_CONTENT}>
          {BLOCK_TYPE_OPTIONS.map(({ key, label, Icon, keys }) => {
            const isCurrent = key === activeKey;
            return (
              <DropdownMenu.Item
                key={key}
                onSelect={() => runBlockType(editor, key, getRange)}
                className={cn(
                  MENU_ITEM,
                  isCurrent && 'bg-primary/10 font-semibold text-primary hover:bg-primary/15 data-[highlighted]:bg-primary/15 data-[highlighted]:text-primary',
                )}
              >
                <Icon size={15} className={cn('shrink-0', isCurrent ? 'text-primary' : 'text-muted-foreground')} />
                <span>{label}</span>
                {keys && <MenuShortcut keys={keys} />}
                {isCurrent && <Check size={14} className="ml-1.5 text-primary shrink-0" />}
              </DropdownMenu.Item>
            );
          })}
          {onToggleHeaderNumbering && (
            <>
              <DropdownMenu.Separator className="my-1 h-px bg-border/60" />
              <DropdownMenu.CheckboxItem
                checked={headerNumbering}
                onCheckedChange={onToggleHeaderNumbering}
                className={MENU_ITEM}
              >
                <Hash size={15} className="shrink-0 text-muted-foreground" />
                <span>Number headings</span>
                <DropdownMenu.ItemIndicator className="ml-auto text-foreground">
                  <span aria-hidden="true">✓</span>
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.CheckboxItem>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
