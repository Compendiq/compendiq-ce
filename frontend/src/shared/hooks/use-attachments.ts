import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { SUPPORTED_DOCUMENT_FORMATS, SUPPORTED_IMAGE_FORMATS } from '@compendiq/contracts';
import { useExtractDocument, type ExtractDocumentResult } from './use-extract-document';
import { usePrepareImage, type PreparedImage } from './use-prepare-image';
import { refusedImageReason } from '../lib/downscale-image';

/**
 * One owner for all document attachments and the image attachment on the AI
 * composer surfaces.
 *
 * The reason this exists rather than each surface holding its own state: there
 * would otherwise be several pieces of hand-rolled state and copies of the drop
 * routing. More importantly, a shared drop target has to
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

/** Matches the server-side prompt budget for uploaded source material. */
export const MAX_DOCUMENT_TEXT_FOR_LLM = 80_000;

/** Combines attached sources while keeping filename boundaries for the model. */
export function buildDocumentReferenceText(
  documents: readonly AttachedDocument[],
): string | undefined {
  if (documents.length === 0) return undefined;
  if (documents.length === 1) {
    return documents[0]!.result.text.slice(0, MAX_DOCUMENT_TEXT_FOR_LLM);
  }

  let combined = '';
  for (const document of documents) {
    const section = `\n\n--- ${document.filename} ---\n${document.result.text}`;
    const remaining = MAX_DOCUMENT_TEXT_FOR_LLM - combined.length;
    if (remaining <= 0) break;
    combined += section.slice(0, remaining);
  }
  return combined.trim();
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

  const [documents, setDocuments] = useState<AttachedDocument[]>([]);
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
  const documentEpochRef = useRef(0);

  // Counted, not toggled: `dragleave` fires every time the pointer crosses into
  // a child, so a composer full of children would flicker the hint off under a
  // drag that never actually left (mirrors DocumentUploadZone.tsx).
  const dragDepthRef = useRef(0);

  // Removing an image invalidates its in-flight staging result, and clearAll
  // also advances the document epoch so an extraction from the previous page
  // cannot re-attach itself after navigation.
  const removeImage = useCallback(() => {
    prepareRequestIdRef.current += 1;
    setImage((current) => {
      if (current) URL.revokeObjectURL(current.previewUrl);
      return null;
    });
  }, []);

  const removeDocument = useCallback((index = 0) => {
    setDocuments((current) => current.filter((_document, documentIndex) => documentIndex !== index));
  }, []);

  const clearAll = useCallback(() => {
    removeImage();
    documentEpochRef.current += 1;
    setDocuments([]);
  }, [removeImage]);

  useEffect(() => () => {
    if (imageRef.current) URL.revokeObjectURL(imageRef.current.previewUrl);
  }, []);

  const pickFiles = useCallback(async (files: readonly File[]) => {
    if (disabled) return;
    const documentEpoch = documentEpochRef.current;

    await Promise.all(files.map(async (file) => {
      if (looksLikeImage(file)) {
        if (!imageEnabled) {
          toast.error(imageDisabledReason ?? 'Images cannot be attached right now.');
          return;
        }
        const refusal = refusedImageReason(file);
        if (refusal) {
          toast.error(refusal);
          return;
        }
        const requestId = ++prepareRequestIdRef.current;
        try {
          const prepared = await prepareImage(file);
          if (!mountedRef.current || requestId !== prepareRequestIdRef.current) {
            URL.revokeObjectURL(prepared.previewUrl);
            return;
          }
          setImage((previous) => {
            if (previous) URL.revokeObjectURL(previous.previewUrl);
            return prepared;
          });
        } catch (err) {
          if (!mountedRef.current || requestId !== prepareRequestIdRef.current) return;
          toast.error(err instanceof Error ? err.message : 'Could not attach that image.');
        }
        return;
      }

      const name = file.name.toLowerCase();
      const isDocument = SUPPORTED_DOCUMENT_FORMATS.some((f) => name.endsWith(`.${f}`))
        || name.endsWith('.markdown') || name.endsWith('.text') || name.endsWith('.yml');
      if (!isDocument) {
        toast.error(unsupportedMessage());
        return;
      }
      if (file.size > MAX_DOCUMENT_BYTES) {
        toast.error('File exceeds 20 MB limit');
        return;
      }

      try {
        const result = await extractDocument(file);
        if (!mountedRef.current || documentEpoch !== documentEpochRef.current) return;
        setDocuments((current) => [...current, { result, filename: file.name }]);
      } catch (err) {
        if (!mountedRef.current || documentEpoch !== documentEpochRef.current) return;
        toast.error(err instanceof Error ? err.message : 'Document extraction failed');
      }
    }));
  }, [disabled, imageEnabled, imageDisabledReason, prepareImage, extractDocument]);

  const pickFile = useCallback(async (file: File) => {
    await pickFiles([file]);
  }, [pickFiles]);

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
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (!files.length) return;
      void pickFiles(files);
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
      void pickFiles([file]);
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
  }, [dropTargetRef, disabled, pickFiles]);

  return {
    documents,
    /** Backwards-compatible first-document view for callers not yet multi-file aware. */
    document: documents[0] ?? null,
    image,
    pickFile,
    pickFiles,
    removeDocument,
    removeImage,
    clearAll,
    isBusy: isExtracting || isPreparing,
    isExtracting,
    isPreparing,
    isDragOver,
  };
}
