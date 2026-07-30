import { useRef } from 'react';
import { Image as ImageIcon, Loader2, X } from 'lucide-react';
import { SUPPORTED_IMAGE_FORMATS } from '@compendiq/contracts';
import type { PreparedImage } from '../../hooks/use-prepare-image';
import { cn } from '../../lib/cn';

/**
 * #1154: the image half of the composer's attach affordance.
 *
 * Purely presentational — picking, downscaling and staging all live in
 * `useAttachments`. The trigger is always rendered, even when the model cannot
 * accept images, so the capability is discoverable: hiding it means a user on a
 * text-only model never learns image input exists or that switching models
 * unlocks it. It is disabled with a reason instead.
 */

/** `.png,.jpg,…` plus MIME types, so both native pickers behave. */
const ACCEPT = [
  ...SUPPORTED_IMAGE_FORMATS.map((f) => `image/${f}`),
  '.png', '.jpg', '.jpeg', '.webp', '.gif',
].join(',');

/**
 * Why the image trigger is disabled, or `undefined` when it is not.
 *
 * `false` and `null` deliberately differ. `null` means the server has not
 * established capability, and telling the user the model "cannot accept images"
 * would assert something it never checked — the same distinction the backend's
 * own 422 messages make.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function imageDisabledReason(vision: boolean | null, model: string): string | undefined {
  if (vision === true) return undefined;
  if (vision === false) {
    return `${model} can't read images — assign a vision-capable model in Settings → LLM.`;
  }
  return `Image support for ${model} isn't confirmed yet — try again shortly.`;
}

export interface ImageAttachZoneProps {
  vision: boolean | null;
  model: string;
  image: PreparedImage | null;
  onPick: (file: File) => void;
  onRemove: () => void;
  isPreparing: boolean;
  disabled?: boolean;
  testIdPrefix?: string;
}

export function ImageAttachZone({
  vision, model, image, onPick, onRemove, isPreparing,
  disabled = false, testIdPrefix = 'image-attach',
}: ImageAttachZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const reason = imageDisabledReason(vision, model);
  const blocked = disabled || isPreparing || reason !== undefined;

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onPick(file);
          e.target.value = '';   // re-selecting the same file must re-fire onChange
        }}
        data-testid={`${testIdPrefix}-file-input`}
      />

      {image && (
        <div
          className="nm-card flex w-full items-center gap-2 rounded-lg p-2"
          data-testid={`${testIdPrefix}-card`}
        >
          <img
            src={image.previewUrl}
            alt=""
            className="h-10 w-10 shrink-0 rounded object-cover"
            data-testid={`${testIdPrefix}-thumb`}
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs">Attached image</p>
            <p className="font-mono text-[11px] text-muted-foreground">
              {image.width}×{image.height} · {(image.fileSize / 1024).toFixed(0)} KB
              {image.format === 'gif' ? ' · first frame' : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={onRemove}
            aria-label="Remove image"
            className="nm-card-hover shrink-0 rounded p-1"
            data-testid={`${testIdPrefix}-remove`}
          >
            <X size={14} />
          </button>
        </div>
      )}

      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={blocked}
        title={reason ?? 'Attach an image'}
        aria-label="Attach an image"
        className={cn(
          'nm-card-hover self-end rounded-lg border border-border-interactive p-2',
          'disabled:opacity-50',
        )}
        data-testid={`${testIdPrefix}-trigger`}
      >
        {isPreparing ? <Loader2 size={16} className="animate-spin" /> : <ImageIcon size={16} />}
      </button>
    </>
  );
}
