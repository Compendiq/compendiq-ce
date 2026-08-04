import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { SUPPORTED_DOCUMENT_FORMATS, SUPPORTED_IMAGE_FORMATS } from '@compendiq/contracts';
import { useExtractDocument, type ExtractDocumentResult } from './use-extract-document';
import { usePrepareImage, type PreparedImage } from './use-prepare-image';
import { refusedImageReason } from '../lib/downscale-image';

/**
 * #1154: one owner for both attachment slots on the AI composer surfaces.
 *
 * The reason this exists rather than each surface holding its own state: with two
 * slots across three surfaces there would be six pieces of hand-rolled state and
 * three copies of the drop routing. More importantly, a shared drop target has to
 * decide *once* whether a dropped file is a document or an image. If both zones
 * listened, a PNG dropped on the composer would reach whichever of them the event
 * happened to hit first, and each zone knows only its own half — so which one won
 * would be emergent rather than designed.
 *
 * So the acceptance rules live here, in one place that sees both halves:
 * `looksLikeImage` first, then the document branch's extension match. The zones
 * own no rules at all — they report the file they were given and render what they
 * are handed.
 *
 * This hook owns the shared drop target and the paste listener too, for the same
 * reason: both are places a file arrives without either zone being involved.
 */

export interface AttachedDocument {
  result: ExtractDocumentResult;
  filename: string;
}

export interface UseAttachmentsOptions {
  /** Ancestor element that accepts drops — normally the `nm-composer` box. */
  dropTargetRef?: React.RefObject<HTMLElement | null>;
  /** False while the resolved chat model is not known vision-capable. */
  imageEnabled?: boolean;
  /** Shown when an image arrives by drop or paste while `imageEnabled` is false. */
  imageDisabledReason?: string;
  /** Blocks all intake — e.g. while a stream is in flight. */
  disabled?: boolean;
}

// HEIC/HEIF included even though the browser MIME for them is unreliable (often
// `''`): without the extension fallback they'd fall through to the document
// branch and get the generic "Unsupported file" message instead of the
// HEIC-specific, actionable one `downscaleImage` throws.
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'heic', 'heif'] as const;

/**
 * Mirrors the server's multipart cap in `routes/llm/extract-document.ts`, so a
 * doomed POST is never sent.
 *
 * Lives here rather than in `DocumentUploadZone` (#1154) for the same reason the
 * format check does: this hook is the only place that knows a file is a document
 * at all. Images are bounded separately and far higher — see
 * `MAX_SOURCE_IMAGE_BYTES`, which caps the *source* of a decode rather than an
 * upload.
 */
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

function looksLikeImage(file: File): boolean {
  if (file.type.startsWith('image/')) return true;
  const name = file.name.toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => name.endsWith(`.${ext}`));
}

/** Copy for the one "we don't take that" message, derived from the contracts. */
function unsupportedMessage(): string {
  const docs = SUPPORTED_DOCUMENT_FORMATS.map((f) => f.toUpperCase()).join(', ');
  const images = SUPPORTED_IMAGE_FORMATS.map((f) => f.toUpperCase()).join(', ');
  return `Unsupported file. Documents: ${docs}. Images: ${images}.`;
}

export function useAttachments(options: UseAttachmentsOptions = {}) {
  const { dropTargetRef, imageEnabled = false, imageDisabledReason, disabled = false } = options;

  const [document_, setDocument] = useState<AttachedDocument | null>(null);
  const [image, setImage] = useState<PreparedImage | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  const { extractDocument, isExtracting } = useExtractDocument();
  const { prepareImage, isPreparing } = usePrepareImage();

  // Revoking on unmount needs the current value without making the effect depend
  // on it, or every new attachment would revoke the URL it just created.
  const imageRef = useRef<PreparedImage | null>(null);
  imageRef.current = image;

  // Guards two races around the async `prepareImage` call: (a) the component
  // unmounts while it's in flight, and (b) a second pick starts and resolves
  // before an earlier one does. Without these, either can set state after it
  // stopped being valid — an unmount write, or an old image silently
  // clobbering a newer one — and in both cases the losing `previewUrl` would
  // never be revoked because it was never stored.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const prepareRequestIdRef = useRef(0);
  const extractRequestIdRef = useRef(0);

  // Counted, not toggled: `dragleave` fires every time the pointer crosses into
  // a child, so a composer full of children would flicker the hint off under a
  // drag that never actually left (mirrors DocumentUploadZone.tsx).
  const dragDepthRef = useRef(0);

  // Removing invalidates whatever is in flight, not just what is on screen.
  // Bumping the request id is what makes "clear" mean cancel: `pickFile`'s
  // guard then sees a stale id, discards the result and revokes its own object
  // URL. Without it the only trigger was a *new* pick, so clearing during
  // staging left the result free to arrive and re-attach itself afterwards —
  // and `clearAll` runs from `DockPanel`'s page-change effect, so that
  // resurrected image would land on a document the user had already left.
  const removeImage = useCallback(() => {
    prepareRequestIdRef.current += 1;
    setImage((current) => {
      if (current) URL.revokeObjectURL(current.previewUrl);
      return null;
    });
  }, []);

  const removeDocument = useCallback(() => {
    extractRequestIdRef.current += 1;
    setDocument(null);
  }, []);

  const clearAll = useCallback(() => {
    removeImage();
    removeDocument();
  }, [removeImage, removeDocument]);

  useEffect(() => () => {
    if (imageRef.current) URL.revokeObjectURL(imageRef.current.previewUrl);
  }, []);

  const pickFile = useCallback(async (file: File) => {
    if (disabled) return;

    if (looksLikeImage(file)) {
      if (!imageEnabled) {
        toast.error(imageDisabledReason ?? 'Images cannot be attached right now.');
        return;
      }
      // Refused here, ahead of `prepareImage`, using the same reason function
      // `downscaleImage` uses internally so there is exactly one copy of the
      // message. Refusing at the door — rather than letting the real decode
      // reject it — avoids a pointless `isPreparing` flicker for a file that
      // never had a chance, and keeps the refusal visible in this routing
      // layer, where a reader debugging "why didn't my SVG attach" is looking.
      const refusal = refusedImageReason(file);
      if (refusal) {
        toast.error(refusal);
        return;
      }
      const requestId = ++prepareRequestIdRef.current;
      try {
        const prepared = await prepareImage(file);
        if (!mountedRef.current || requestId !== prepareRequestIdRef.current) {
          // Unmounted, or superseded by a newer pick that started before this
          // one resolved. Either way this result lost and is never stored, so
          // its object URL must be revoked here or it leaks.
          URL.revokeObjectURL(prepared.previewUrl);
          return;
        }
        // Replace rather than accumulate: one image per request by design.
        setImage((previous) => {
          if (previous) URL.revokeObjectURL(previous.previewUrl);
          return prepared;
        });
      } catch (err) {
        if (!mountedRef.current || requestId !== prepareRequestIdRef.current) return;
        // ImageDecodeError already carries user-facing copy (SVG, HEIC, too big).
        const message = err instanceof Error ? err.message : 'Could not attach that image.';
        toast.error(message);
      }
      return;
    }

    // Documents are matched by extension only, unlike `looksLikeImage`, which
    // consults the MIME type first. That is not an oversight: browsers report
    // `''` for `.md` and often `.rtf`, so a MIME-first rule would reject the
    // formats most likely to be dropped here.
    //
    // The narrowing it does cost — an extension-less file with a correct
    // `application/pdf` MIME used to be accepted by the component's old
    // extension-OR-MIME check and is now refused — is knowingly accepted. The
    // MIME table that would restore it lives in `DocumentUploadZone`'s
    // `FORMAT_META`, and giving this hook a second copy would put the same
    // data under two owners, which is the defect the #1154 refactor set out to
    // remove. The user is told what is accepted and can rename the file; the
    // server re-sniffs the bytes either way.
    const name = file.name.toLowerCase();
    const isDocument = SUPPORTED_DOCUMENT_FORMATS.some((f) => name.endsWith(`.${f}`))
      || name.endsWith('.markdown') || name.endsWith('.text');
    if (!isDocument) {
      toast.error(unsupportedMessage());
      return;
    }
    if (file.size > MAX_DOCUMENT_BYTES) {
      toast.error('File exceeds 20 MB limit');
      return;
    }

    // Same two guards the image path uses, and for the same reasons: the shared
    // drop target accepts a second file while the first is still extracting, so
    // a slow earlier request must not clobber a newer document, and neither may
    // write state after the surface has gone. No object URL to revoke on the
    // losing path here — a discarded extraction is just text.
    const requestId = ++extractRequestIdRef.current;
    try {
      const result = await extractDocument(file);
      if (!mountedRef.current || requestId !== extractRequestIdRef.current) return;
      setDocument({ result, filename: file.name });
    } catch (err) {
      if (!mountedRef.current || requestId !== extractRequestIdRef.current) return;
      toast.error(err instanceof Error ? err.message : 'Document extraction failed');
    }
  }, [disabled, imageEnabled, imageDisabledReason, prepareImage, extractDocument]);

  // Shared drop target + paste. Native listeners rather than React props, because
  // the element belongs to the caller's tree.
  //
  // Registered even while `disabled` (the only thing that skips registration is
  // having no target at all): a drop event must always be preventDefault'd, or
  // the browser runs its default action and navigates the tab to the dropped
  // file — destroying whatever the user had typed — regardless of whether the
  // hook is currently willing to act on it (mirrors the same note in
  // DocumentUploadZone.tsx). `disabled` therefore gates only whether `pickFile`
  // is called, never whether the event is swallowed.
  useEffect(() => {
    const target = dropTargetRef?.current;
    if (!target) return;

    const onDragEnter = () => {
      dragDepthRef.current += 1;
      setIsDragOver(true);
    };
    const onDragLeave = () => {
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) setIsDragOver(false);
    };
    const onDragOver = (e: DragEvent) => e.preventDefault();
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      dragDepthRef.current = 0;
      setIsDragOver(false);
      if (disabled) return;
      const file = e.dataTransfer?.files[0];
      if (!file) return;
      void pickFile(file);
    };
    const onPaste = (e: Event) => {
      if (disabled) return;
      const clipboard = (e as ClipboardEvent).clipboardData;
      const items = Array.from(clipboard?.items ?? []);
      const imageItem = items.find((i) => i.type.startsWith('image/'));
      if (!imageItem) return;   // let text paste reach the textarea untouched
      const file = imageItem.getAsFile();
      if (!file) return;
      e.preventDefault();
      void pickFile(file);
    };

    target.addEventListener('dragenter', onDragEnter);
    target.addEventListener('dragleave', onDragLeave);
    target.addEventListener('dragover', onDragOver);
    target.addEventListener('drop', onDrop);
    target.addEventListener('paste', onPaste);
    return () => {
      target.removeEventListener('dragenter', onDragEnter);
      target.removeEventListener('dragleave', onDragLeave);
      target.removeEventListener('dragover', onDragOver);
      target.removeEventListener('drop', onDrop);
      target.removeEventListener('paste', onPaste);
    };
  }, [dropTargetRef, disabled, pickFile]);

  return {
    document: document_,
    image,
    pickFile,
    removeDocument,
    removeImage,
    clearAll,
    isBusy: isExtracting || isPreparing,
    isExtracting,
    isPreparing,
    isDragOver,
  };
}
