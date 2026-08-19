import { useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Smile, Shapes, ImagePlus, Trash2, Hexagon } from 'lucide-react';
import { BrandIconGrid } from './BrandIconGrid';
import type { PageIcon as PageIconValue, SettablePageIcon } from '@compendiq/contracts';
import { EmojiPickerContent } from '../article/EmojiPicker';
import { absorbPortalEscape } from '../../lib/absorb-portal-escape';
import { LucideIconGrid } from './LucideIconGrid';
import { cn } from '../../lib/cn';

type PickerTab = 'emoji' | 'icons' | 'logos' | 'upload';

export function PageIconPicker({
  icon,
  open,
  onOpenChange,
  onSelect,
  onUpload,
  onRemove,
  uploading = false,
  uploadError = null,
  trigger,
}: {
  icon: PageIconValue | null | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (icon: SettablePageIcon) => void;
  onUpload: (file: File) => void;
  onRemove: () => void;
  uploading?: boolean;
  uploadError?: string | null;
  trigger: React.ReactNode;
}) {
  const [tab, setTab] = useState<PickerTab>('icons');
  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={8}
          className="nm-card-elevated z-50 w-96 p-2.5"
          onEscapeKeyDown={(event) => absorbPortalEscape(event, () => onOpenChange(false))}
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <div className="mb-2 flex items-center gap-1" role="tablist" aria-label="Icon type">
            <TabButton current={tab} id="icons" onSelect={setTab} icon={Shapes} label="Icons" />
            <TabButton current={tab} id="logos" onSelect={setTab} icon={Hexagon} label="Logos" />
            <TabButton current={tab} id="emoji" onSelect={setTab} icon={Smile} label="Emoji" />
            <TabButton current={tab} id="upload" onSelect={setTab} icon={ImagePlus} label="Upload" />
          </div>

          {tab === 'emoji' && (
            <EmojiPickerContent onPick={(emoji) => onSelect({ kind: 'emoji', value: emoji })} onClose={() => onOpenChange(false)} />
          )}

          {tab === 'icons' && (
            <LucideIconGrid
              selected={icon?.kind === 'lucide' ? icon.value : null}
              onPick={(value) => onSelect({ kind: 'lucide', value })}
            />
          )}

          {tab === 'logos' && (
            <BrandIconGrid
              selected={icon?.kind === 'brand' ? icon.value : null}
              onPick={(value) => onSelect({ kind: 'brand', value })}
            />
          )}

          {tab === 'upload' && (
            <div className="space-y-2 py-1">
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="sr-only"
                data-testid="page-icon-file"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) onUpload(file);
                  event.target.value = '';
                }}
              />
              <button
                type="button"
                className="nm-button-ghost h-8 w-full text-sm"
                disabled={uploading}
                onClick={() => fileRef.current?.click()}
              >
                {uploading ? 'Uploading…' : 'Choose image'}
              </button>
              <p className="text-muted-foreground text-xs">
                PNG, JPEG, or WebP. Shown square at the title and as a small mark in lists.
              </p>
              {uploadError && (
                <p className="text-sm" role="alert">
                  {uploadError}
                </p>
              )}
            </div>
          )}

          {icon && (
            <button
              type="button"
              className="nm-action-destructive mt-2 inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs"
              onClick={onRemove}
              data-testid="page-icon-remove"
            >
              <Trash2 size={14} aria-hidden />
              Remove icon
            </button>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function TabButton({
  current,
  id,
  onSelect,
  icon: Icon,
  label,
}: {
  current: PickerTab;
  id: PickerTab;
  onSelect: (id: PickerTab) => void;
  icon: typeof Smile;
  label: string;
}) {
  const selected = current === id;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      className={cn(
        'nm-focus-ring inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md border text-xs font-medium',
        selected
          ? 'border-border-interactive bg-background text-foreground'
          : 'hover:bg-muted hover:text-foreground border-transparent text-muted-foreground',
      )}
      onClick={() => onSelect(id)}
    >
      <Icon size={14} aria-hidden />
      {label}
    </button>
  );
}
