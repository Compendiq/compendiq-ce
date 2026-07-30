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
 *
 * **Composer ordering.** This renders a fragment of two flex items — a
 * full-width card and a small trigger — so inside a `flex-wrap` composer the
 * card would sit between the host's other children in document order and strand
 * a trigger alone on a wrap line. The fragment therefore carries its own
 * `order-*`: `order-1` for the card, `order-2` for the trigger, matching
 * `DocumentUploadZone`'s composer variant so two zones interleave correctly.
 * A host must give its own children explicit orders from `order-3` up —
 * anything left without one defaults to `order: 0` and jumps ahead of the
 * cards. (Outside a flex container `order` is simply inert.)
 *
 * **Known limitation — focus order (WCAG 2.4.3).** `order` moves boxes, not
 * the tab sequence, so on a composer holding both zones Tab runs
 * doc-remove → doc-trigger → image-remove → image-trigger while the eye reads
 * doc card, image card, then the two triggers. Focus therefore crosses rows
 * rather than following them.
 *
 * It is recorded rather than fixed, deliberately. Nothing inside either zone
 * can repair it: a fragment of two flex items cannot be reordered from the
 * host, and reversing the fragment (trigger before card) only swaps which pair
 * ping-pongs. The one real fix is for the host to render the cards and the
 * triggers as two separate groups, which means splitting both zones into two
 * components and rewiring all three surfaces — a design change, not a
 * cleanup, and not a regression this branch introduced (the same order held
 * under the previous selector-based approach). What bounds the cost in the
 * meantime: there are at most four controls, each carries an explicit
 * accessible name ("Remove image", "Attach an image", …), and `tabindex` is
 * never used to paper over it — a positive `tabindex` would trade this for a
 * worse problem across the whole page.
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
 *
 * The three states are therefore four messages, because "no model yet" is not
 * the same claim as "this model's support is unconfirmed": `model` is `''`
 * until the models query resolves, which is every first paint on every
 * surface. Interpolating it there rendered "Image support for  isn't confirmed
 * yet" — a sentence with a hole in it, shown to every user before anything
 * useful is — so the empty case gets copy that is true of it.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function imageDisabledReason(vision: boolean | null, model: string): string | undefined {
  if (vision === true) return undefined;
  if (!model) {
    return 'Waiting for the chat model — images can be attached once it loads.';
  }
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
          className="nm-card order-1 flex w-full items-center gap-2 rounded-lg p-2"
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
          'nm-card-hover order-2 self-end rounded-lg border border-border-interactive p-2',
          'disabled:opacity-50',
        )}
        data-testid={`${testIdPrefix}-trigger`}
      >
        {isPreparing ? <Loader2 size={16} className="animate-spin" /> : <ImageIcon size={16} />}
      </button>
    </>
  );
}
