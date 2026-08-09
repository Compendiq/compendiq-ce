import { useRef } from 'react';
import { Image as ImageIcon, Loader2, X } from 'lucide-react';
import { SUPPORTED_IMAGE_FORMATS } from '@compendiq/contracts';
import type { PreparedImage } from '../../hooks/use-prepare-image';
import { cn } from '../../lib/cn';
import { composerRowClass } from './composer-row';

/**
 * #1154: the image half of the composer's attach affordance.
 *
 * Purely presentational — picking, downscaling and staging all live in
 * `useAttachments`. The trigger is always rendered, even when the model cannot
 * accept images, so the capability is discoverable: hiding it means a user on a
 * text-only model never learns image input exists or that switching models
 * unlocks it. It is disabled with a reason instead.
 *
 * **Not yet a visual sibling of `DocumentUploadZone`.** The two zones sit in the
 * same composer but differ in border, radius and card treatment, because each
 * was built to its own surface's brief. Only the off-contract part was corrected
 * here: `nm-card-hover` composes over `--surface-card` and therefore painted the
 * full card gradient into a 22px control. Reconciling the rest is a design
 * decision about both components at once, not a fix — deliberately left.
 *
 * **Composer layout.** This contributes exactly one flex item: a row holding the
 * card and this zone's own trigger together, per {@link composerRowClass}. That
 * shape is what makes tab order match reading order (WCAG 2.4.3) — see that
 * function for why the earlier `order-*` convention could not, and why no
 * `order-*` may come back to a composer.
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
 * the same claim as "this model's support is unconfirmed": `visionModel` is `''`
 * until the chat use-case default resolves, which is every first paint on every
 * surface. Interpolating it there rendered "Image support for  isn't confirmed
 * yet" — a sentence with a hole in it, shown to every user before anything
 * useful is — so the empty case gets copy that is true of it.
 *
 * The verdict and the name must come from the same place, and that place is the
 * **chat use-case default** — never `/ai`'s model dropdown. `/llm/generate` and
 * `/llm/improve` both resolve the image gate with `resolveUsecase('chat')` and
 * ignore the body's `model` entirely, so a message naming the dropdown's
 * selection would attribute the server's verdict to a model it is not about.
 * Hence the "assigned to chat" clause, which mirrors the backend's own 422 text:
 * on `/ai` the two names can differ on screen, and the copy has to say which one
 * it means.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function imageDisabledReason(
  vision: boolean | null,
  visionModel: string,
): string | undefined {
  if (vision === true) return undefined;
  if (!visionModel) {
    return 'Waiting for the chat model — images can be attached once it loads.';
  }
  if (vision === false) {
    return `The model assigned to chat (${visionModel}) can't read images — `
      + 'assign a vision-capable model in Settings → LLM.';
  }
  return `Image support for the model assigned to chat (${visionModel}) isn't `
    + 'confirmed yet — try again shortly.';
}

export interface ImageAttachZoneProps {
  vision: boolean | null;
  /**
   * The model the `vision` verdict is about — the **chat use-case default**,
   * not whatever a surface's model dropdown is showing. Named apart from
   * `model` for that reason: both are in scope on `/ai`, and they diverge.
   */
  visionModel: string;
  image: PreparedImage | null;
  onPick: (file: File) => void;
  onRemove: () => void;
  isPreparing: boolean;
  disabled?: boolean;
  /**
   * Accessible name and tooltip for the trigger. The default says only that an
   * image can be attached; a surface where the image feeds one action rather
   * than the next message must say so here — see `usageHint`.
   */
  triggerLabel?: string;
  /**
   * One line on the attachment card naming what consumes the image.
   *
   * Load-bearing where the composer's Send button does *not* carry the image:
   * the dock's `ask()` posts to `/llm/ask`, which accepts no image at all, so
   * only the Improve chip uses it. Without this the user attaches, types, sends,
   * and gets an answer that never saw the picture. `DocumentUploadZone` carries
   * the same hint for the same asymmetry.
   */
  usageHint?: string;
  testIdPrefix?: string;
}

export function ImageAttachZone({
  vision, visionModel, image, onPick, onRemove, isPreparing,
  disabled = false, triggerLabel, usageHint, testIdPrefix = 'image-attach',
}: ImageAttachZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const reason = imageDisabledReason(vision, visionModel);
  const label = triggerLabel ?? 'Attach an image';
  const blocked = disabled || isPreparing || reason !== undefined;

  return (
    <div className={composerRowClass(image !== null)} data-testid={`${testIdPrefix}-row`}>
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
          className="nm-card flex min-w-0 flex-1 items-center gap-2 rounded-lg p-2"
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
            {/* Dimensions and size are data figures, so they take the mono
                face. The usage hint after them is prose and must not — and it
                is the honest part: where Send does not carry the image, saying
                what does beats letting the user assume the next message will. */}
            <p className="text-[11px] text-muted-foreground">
              <span className="font-mono">
                {image.width}×{image.height} · {(image.fileSize / 1024).toFixed(0)} KB
                {image.format === 'gif' ? ' · first frame' : ''}
              </span>
              {usageHint ? ` · ${usageHint}` : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={onRemove}
            disabled={disabled}
            aria-label="Remove image"
            // Matches `DocumentUploadZone`'s remove button rather than tinting
            // with `nm-card-hover`: that utility restates `--surface-card` as
            // its lower layer, so on a 22px control it painted the whole card
            // gradient into the button on hover. Every other use in the app
            // pairs it with `nm-card`, which is the surface it is composed for.
            className={cn(
              'shrink-0 rounded p-1 text-muted-foreground transition-colors',
              'hover:bg-foreground/10 hover:text-foreground',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              'disabled:opacity-50',
            )}
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
        title={reason ?? label}
        aria-label={label}
        // Tinted the way the document trigger beside it is, not with
        // `nm-card-hover` — see the remove button above for why that utility
        // does not belong on a control this size.
        className={cn(
          'shrink-0 rounded-lg border border-border-interactive p-2',
          'text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          'disabled:opacity-50',
        )}
        data-testid={`${testIdPrefix}-trigger`}
      >
        {isPreparing ? <Loader2 size={16} className="animate-spin" /> : <ImageIcon size={16} />}
      </button>
    </div>
  );
}
