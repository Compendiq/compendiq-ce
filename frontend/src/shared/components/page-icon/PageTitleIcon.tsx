import { useState } from 'react';
import type { PageIcon as PageIconValue, SettablePageIcon } from '@compendiq/contracts';
import { useCanHover } from '../../hooks/use-can-hover';
import { cn } from '../../lib/cn';
import { PageIcon } from './PageIcon';
import { PageIconPicker } from './PageIconPicker';

export function PageTitleIcon({
  icon,
  pageId,
  editable,
  onSelect,
  onUpload,
  onRemove,
  uploading = false,
  uploadError = null,
}: {
  icon: PageIconValue | null | undefined;
  pageId: string | number;
  editable: boolean;
  onSelect: (icon: SettablePageIcon) => void;
  onUpload: (file: File) => void;
  onRemove: () => void;
  uploading?: boolean;
  uploadError?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const canHover = useCanHover();

  if (!editable && !icon) return null;

  const trigger = icon ? (
    <button
      type="button"
      className={cn(
        'nm-focus-ring mt-1 inline-flex shrink-0 rounded-md',
        editable && 'hover:bg-foreground/5',
      )}
      aria-label="Change page icon"
      data-testid="page-title-icon"
      disabled={!editable}
    >
      <PageIcon icon={icon} pageId={pageId} size="title" />
    </button>
  ) : (
    <button
      type="button"
      className={cn(
        'nm-focus-ring text-muted-foreground mt-1 inline-flex h-8 shrink-0 items-center rounded-md px-2 text-xs font-medium',
        canHover && !open
          ? 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
          : 'opacity-100',
      )}
      aria-label="Add icon"
      data-testid="page-title-add-icon"
    >
      Add icon
    </button>
  );

  if (!editable) {
    return (
      <div className="mt-1 shrink-0" data-testid="page-title-icon">
        <PageIcon icon={icon} pageId={pageId} size="title" />
      </div>
    );
  }

  return (
    <PageIconPicker
      icon={icon}
      open={open}
      onOpenChange={setOpen}
      onSelect={(next) => {
        onSelect(next);
        setOpen(false);
      }}
      onUpload={(file) => {
        onUpload(file);
      }}
      onRemove={() => {
        onRemove();
        setOpen(false);
      }}
      uploading={uploading}
      uploadError={uploadError}
      trigger={trigger}
    />
  );
}
