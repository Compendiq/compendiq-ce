import { useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useEditorState } from '@tiptap/react';
import type { Editor as EditorType } from '@tiptap/react';
import { Heading1, Heading2, Heading3, Type, ChevronDown } from 'lucide-react';
import { TOOLBAR_ITEM_ATTR } from './use-toolbar-roving-focus';
import { formatKeysForPlatform } from '../../lib/shortcut-registry';
import { isMac } from '../../lib/platform';
import { cn } from '../../lib/cn';

const MENU_CONTENT = 'z-50 min-w-[13rem] nm-card-elevated p-1.5';

const MENU_ITEM =
  'flex cursor-pointer select-none items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] ' +
  'text-muted-foreground outline-none transition-colors ' +
  'data-[highlighted]:bg-foreground/10 data-[highlighted]:text-foreground ' +
  'data-[state=open]:bg-foreground/10 data-[state=open]:text-foreground';

const menuTriggerClass = (open: boolean) =>
  cn(
    'inline-flex h-8 items-center gap-1.5 rounded-md border px-2 text-[13px] transition-colors',
    'outline-2 outline-offset-2 outline-transparent focus-visible:outline-ring',
    open
      ? 'border-border-interactive bg-background text-foreground'
      : 'border-transparent text-muted-foreground hover:bg-accent hover:text-foreground',
  );

function MenuShortcut({ keys }: { keys: string }) {
  return (
    <span className="ml-auto pl-4 font-mono text-[11px] text-muted-foreground/60">
      {formatKeysForPlatform(keys, isMac())}
    </span>
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
  else if (key === 'paragraph') chain.setParagraph().run();
}

export function BlockTypeMenu({
  editor,
  getRange,
  className,
}: {
  editor: EditorType;
  getRange?: () => { from: number; to: number } | null;
  className?: string;
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
          className={cn(menuTriggerClass(open), 'w-[8.25rem] justify-start', className)}
        >
          <CurrentIcon size={15} className="shrink-0" />
          <span className="truncate">{current?.label ?? 'Text'}</span>
          <ChevronDown size={13} className="ml-auto shrink-0 opacity-60" />
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
                className={cn(MENU_ITEM, isCurrent && 'bg-foreground/[0.06] font-medium text-foreground')}
              >
                <Icon size={15} className="shrink-0" />
                {label}
                {keys && <MenuShortcut keys={keys} />}
              </DropdownMenu.Item>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
