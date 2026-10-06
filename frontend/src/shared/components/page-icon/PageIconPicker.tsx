import { useEffect, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Smile, Shapes, ImagePlus, Trash2, Hexagon } from 'lucide-react';
import {
  PRESET_TEXT_COLORS,
  getPageBrandIcon,
  type PageIcon as PageIconValue,
  type PageIconColor,
  type SettablePageIcon,
} from '@compendiq/contracts';
import { BrandIconGrid } from './BrandIconGrid';
import { EmojiPickerContent } from '../article/EmojiPicker';
import { absorbPortalEscape } from '../../lib/absorb-portal-escape';
import { LucideIconGrid } from './LucideIconGrid';
import { BrandMark } from './BrandMark';
import { getPageLucideIcon } from './page-lucide-icons';
import { cn } from '../../lib/cn';
import { Button } from '../Button';

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
  const [filled, setFilled] = useState<boolean>(() =>
    icon?.kind === 'lucide' ? Boolean(icon.filled) : false,
  );
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (icon?.kind === 'lucide') {
      setFilled(Boolean(icon.filled));
    }
  }, [icon]);

  const handleFilledChange = (nextFilled: boolean) => {
    setFilled(nextFilled);
    if (icon?.kind === 'lucide') {
      onSelect({
        kind: 'lucide',
        value: icon.value,
        ...(icon.color ? { color: icon.color } : {}),
        ...(nextFilled ? { filled: true } : {}),
      });
    }
  };

  const tintable = asTintable(icon);

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={8}
          className="nm-popover-glass z-50 w-96 p-2.5"
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
              filled={filled}
              onFilledChange={handleFilledChange}
              onPick={(value) => {
                const color = keptTint(icon);
                onSelect({
                  kind: 'lucide',
                  value,
                  ...(color ? { color } : {}),
                  ...(filled ? { filled: true } : {}),
                });
              }}
            />
          )}

          {tab === 'logos' && (
            <BrandIconGrid
              selected={icon?.kind === 'brand' ? icon.value : null}
              onPick={(value) => {
                const color = keptTint(icon);
                onSelect(color ? { kind: 'brand', value, color } : { kind: 'brand', value });
              }}
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
              <Button
                type="button"
                variant="primary"
                size="sm"
                className="w-full"
                disabled={uploading}
                isLoading={uploading}
                onClick={() => fileRef.current?.click()}
              >
                {uploading ? 'Uploading…' : 'Choose image'}
              </Button>
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

          {(tab === 'icons' || tab === 'logos') && tintable && (
            <IconColorRow
              icon={tintable}
              filled={tab === 'icons' && filled}
              onPick={(color) =>
                onSelect(
                  tintable.kind === 'lucide'
                    ? {
                        kind: 'lucide',
                        value: tintable.value,
                        ...(color ? { color } : {}),
                        ...(filled ? { filled: true } : {}),
                      }
                    : color
                      ? { kind: 'brand', value: tintable.value, color }
                      : { kind: 'brand', value: tintable.value },
                )
              }
            />
          )}

          {icon && (
            <Button
              type="button"
              variant="destructive-ghost"
              size="sm"
              className="nm-action-destructive mt-2 w-full justify-start"
              onClick={onRemove}
              leftIcon={<Trash2 size={14} aria-hidden />}
              data-testid="page-icon-remove"
            >
              Remove icon
            </Button>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function asTintable(icon: PageIconValue | null | undefined): TintableIcon | null {
  if (icon?.kind === 'lucide') {
    return { kind: 'lucide', value: icon.value, color: icon.color, filled: icon.filled };
  }
  if (icon?.kind === 'brand') {
    return { kind: 'brand', value: icon.value, color: icon.color };
  }
  return null;
}

function keptTint(icon: PageIconValue | null | undefined): PageIconColor | undefined {
  return asTintable(icon)?.color;
}

type TintableIcon =
  | { kind: 'lucide'; value: string; color?: PageIconColor; filled?: boolean }
  | { kind: 'brand'; value: string; color?: PageIconColor };

function IconColorRow({
  icon,
  filled = false,
  onPick,
}: {
  icon: TintableIcon;
  filled?: boolean;
  onPick: (color?: PageIconColor) => void;
}) {
  const Glyph = icon.kind === 'lucide' ? getPageLucideIcon(icon.value) : null;
  const brand = icon.kind === 'brand' ? getPageBrandIcon(icon.value) : null;
  const swatches: Array<{ label: string; value?: PageIconColor }> = [
    { label: 'Default' },
    ...PRESET_TEXT_COLORS,
  ];

  return (
    <div
      role="group"
      aria-label="Icon color"
      className="mt-2 grid grid-cols-6 gap-1"
      data-testid="page-icon-color-row"
    >
      {swatches.map((swatch) => {
        const selected = (icon.color ?? undefined) === swatch.value;
        return (
          <button
            key={swatch.label}
            type="button"
            title={swatch.label}
            aria-label={`${swatch.label} icon`}
            aria-pressed={selected}
            className={cn(
              'nm-focus-ring flex size-10 items-center justify-center rounded-md border',
              selected
                ? 'border-border-interactive bg-foreground/8'
                : 'border-transparent hover:bg-foreground/5',
            )}
            style={swatch.value ? { color: swatch.value } : undefined}
            onClick={() => onPick(swatch.value)}
          >
            {Glyph ? (
              <Glyph
                size={18}
                aria-hidden
                fill={filled ? 'currentColor' : 'none'}
                className={cn(!swatch.value && 'text-foreground', filled && 'page-icon-filled')}
              />
            ) : brand ? (
              <span className={!swatch.value ? 'text-foreground' : undefined}>
                <BrandMark path={brand.path} size={18} />
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
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
