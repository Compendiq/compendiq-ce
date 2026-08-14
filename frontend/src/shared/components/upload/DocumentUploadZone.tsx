import { useCallback, useRef, useState } from 'react';
import { AlertTriangle, FileText, Loader2, Paperclip, Upload, X } from 'lucide-react';
import { SUPPORTED_DOCUMENT_FORMATS, type DocumentFormat } from '@compendiq/contracts';
import type { ExtractDocumentResult } from '../../hooks/use-extract-document';
import { documentReferenceTextWillTruncate } from '../../hooks/use-attachments';
import { cn } from '../../lib/cn';
import { composerRowClass } from './composer-row';

/**
 * Shared document-upload affordance (#1131).
 *
 * One component, two shapes, because the two surfaces that need it are not the
 * same room. `/ai`'s Generate mode has a full-width column and uploading is
 * half the point, so it gets `dropzone`: a standing dashed target. The docked
 * assistant is a ~420px column where attaching is a *rare* act next to a very
 * common one, so it gets `composer`: a paperclip inside the prompt box that
 * costs nothing until it is used, and a compact card once it is.
 *
 * **Presentational since #1154.** It picks a file and hands it to
 * {@link DocumentUploadZoneProps.onPick}; it no longer extracts anything, and it
 * decides nothing about which files are acceptable. Both gates — format and the
 * 20 MB ceiling — live in `useAttachments`, which is the only place that knows
 * whether a file is a document or an image. Putting either back here would mean
 * a PNG dropped on a shared composer target gets tested against a document-only
 * check and silently rejected, which is the bug this shape exists to prevent.
 */

interface DocumentFormatMeta {
  /** How the format is named in copy. Uppercase — these read as file types. */
  label: string;
  /** Accepted filename extensions, without the dot. */
  extensions: readonly string[];
  /**
   * MIME types browsers actually report. They only ever widen the `accept`
   * attribute — nothing here decides whether a file is acceptable, and the
   * gate that eventually does (`useAttachments`) matches on extension.
   */
  mimeTypes: readonly string[];
}

/**
 * Keyed by `DocumentFormat`, so adding a format to the contract fails the build
 * here until the UI knows how to offer it.
 */
const FORMAT_META: Record<DocumentFormat, DocumentFormatMeta> = {
  pdf: { label: 'PDF', extensions: ['pdf'], mimeTypes: ['application/pdf'] },
  docx: {
    label: 'DOCX',
    extensions: ['docx'],
    mimeTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  },
  md: { label: 'MD', extensions: ['md', 'markdown'], mimeTypes: ['text/markdown', 'text/x-markdown'] },
  txt: { label: 'TXT', extensions: ['txt', 'text'], mimeTypes: ['text/plain'] },
  rtf: { label: 'RTF', extensions: ['rtf'], mimeTypes: ['application/rtf', 'text/rtf'] },
  odt: {
    label: 'ODT',
    extensions: ['odt'],
    mimeTypes: ['application/vnd.oasis.opendocument.text'],
  },
  yaml: {
    label: 'YAML',
    extensions: ['yml', 'yaml'],
    mimeTypes: ['application/yaml', 'text/yaml', 'application/x-yaml'],
  },
};

/**
 * The `accept` attribute: extensions *and* MIME types, so both file pickers
 * behave.
 *
 * Listing both is not belt-and-braces, it is the whole point: browsers disagree
 * wildly about the MIME type of a `.md`, `.rtf` or `.odt` — Chrome reports `''`
 * for Markdown on some platforms — so an accept list of MIME types alone would
 * grey out legitimate files in the picker. This is a filter on what the picker
 * offers, never a gate: `useAttachments` decides what is actually accepted, and
 * the bytes are re-sniffed server-side after that.
 *
 * (Until #1154 the same extension-or-MIME looseness also backed an `isAccepted`
 * guard in this component. That guard is gone, not relaxed — the gate moved to
 * `useAttachments`, which matches on extension.)
 */
function acceptAttribute(formats: readonly DocumentFormat[]): string {
  return formats
    .flatMap((f) => [
      ...FORMAT_META[f].mimeTypes,
      ...FORMAT_META[f].extensions.map((ext) => `.${ext}`),
    ])
    .join(',');
}

/** Human-readable size. */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface DocumentUploadZoneProps {
  /**
   * Which formats this surface offers. Drives the `accept` attribute and every
   * string the component renders.
   *
   * **It no longer gates anything** (#1154) — the parent's `useAttachments`
   * decides what is accepted, so narrowing this list changes the copy and the
   * picker's filter but will NOT refuse a dropped file of another supported
   * type. To actually narrow what is accepted, the gate has to move to
   * `useAttachments` too.
   *
   * Defaults to every format the backend supports.
   */
  formats?: readonly DocumentFormat[];
  /**
   * Hand the picked file to the parent's `useAttachments` router, which decides
   * document-vs-image. This component no longer extracts anything itself: with a
   * shared composer drop target, a dropped PNG would otherwise be tested against
   * this component's document-only format check and silently rejected.
   */
  onPick: (file: File) => void;
  /** Reports all files selected in one picker action or dropped together. */
  onPickFiles?: (files: readonly File[]) => void;
  /** `isExtracting` from the parent's `useAttachments`, for the busy state. */
  isExtracting: boolean;
  /** The extracted document currently attached, or `null`. Parent owns it. */
  extracted: ExtractDocumentResult | null;
  /** Filename of the attached document, or `null`. */
  filename: string | null;
  /** Multiple extracted documents currently attached, in display order. */
  documents?: readonly { result: ExtractDocumentResult; filename: string }[];
  /** Clear the attachment. */
  onRemove: (index?: number) => void;
  /** Blocks the trigger — e.g. while a stream is in flight. */
  disabled?: boolean;
  /**
   * `dropzone` (default) is a standing full-width dashed target with a preview
   * card. `composer` is a paperclip button plus a compact attachment card,
   * meant to sit inside an `nm-composer` that has `flex-wrap`.
   *
   * The `composer` variant contributes exactly one flex item: a row holding the
   * card (or drop hint) and this zone's own trigger together, per
   * {@link composerRowClass}. `ImageAttachZone` takes the same shape, so two
   * zones stack as two rows instead of interleaving. That structure is what
   * makes tab order match reading order (WCAG 2.4.3) — see `composerRowClass`
   * for why the `order-*` convention it replaced could not.
   */
  variant?: 'dropzone' | 'composer';
  /** Accessible name and tooltip for the `composer` trigger. */
  triggerLabel?: string;
  /** `composer` only: one line naming what consumes the document. */
  usageHint?: string;
  /**
   * #1154: drag state supplied by the parent's `useAttachments`, which owns a
   * shared drop target spanning the whole composer.
   *
   * Supplying it means **the parent owns the drop**, not merely the highlight:
   * this component then attaches no drag or drop listeners of its own. It has
   * to be all-or-nothing. `useAttachments` listens natively on an ancestor
   * while React delegates to its root container, so on one bubbling drop the
   * ancestor fires *first* and this component's handler second — two intakes of
   * one file, which `stopPropagation` cannot undo after the fact. A test in
   * `GenerateMode.image.test.tsx` pins the extraction count at one.
   *
   * Omit it and the component keeps its own state and its own listeners, which
   * is what a standalone `dropzone` needs — there it IS the drop target.
   *
   * **No shipped surface omits it today** (#1154). Generate passes it on the
   * `dropzone` variant too, so the internal `dragDepth`/`enterDrag`/`leaveDrag`/
   * `handleDrop` path is exercised only by this component's own tests. It is
   * kept deliberately: this is a shared component, and a standalone dropzone
   * with no `useAttachments` above it is the configuration it was built for. It
   * is a supported fallback, not a live dependency of anything on screen.
   */
  isDragOver?: boolean;
  /** Prefix for every `data-testid` this renders. */
  testIdPrefix?: string;
}

export function DocumentUploadZone({
  formats = SUPPORTED_DOCUMENT_FORMATS,
  onPick,
  onPickFiles,
  isExtracting,
  extracted,
  filename,
  documents,
  onRemove,
  disabled = false,
  variant = 'dropzone',
  triggerLabel,
  usageHint,
  isDragOver: isDragOverProp,
  testIdPrefix = 'document',
}: DocumentUploadZoneProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [internalIsDragOver, setInternalIsDragOver] = useState(false);

  // The parent's state wins when it has one: only it can see a drag over the
  // whole composer. Falling back rather than replacing keeps the `dropzone`
  // variant — which is its own drop target — working with no prop at all.
  const isDragOver = isDragOverProp ?? internalIsDragOver;

  // A single-format surface names that format everywhere it would otherwise
  // say "document": pass `formats={['pdf']}` and every string reads "PDF". No
  // surface does today — both take all supported formats since #1132 — and note that this
  // changes only the copy and the picker's filter: since #1154 narrowing
  // `formats` does not narrow what is actually accepted. See the prop's doc.
  const only = formats.length === 1 ? formats[0] : undefined;
  const noun = only ? FORMAT_META[only].label : 'document';

  // Drag state is counted, not toggled: `dragleave` fires every time the
  // pointer crosses into a child, so a composer full of children would flicker
  // the hint off under a drag that never actually left.
  const dragDepth = useRef(0);
  const enterDrag = useCallback(() => {
    dragDepth.current += 1;
    setInternalIsDragOver(true);
  }, []);
  const leaveDrag = useCallback(() => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setInternalIsDragOver(false);
  }, []);
  const endDrag = useCallback(() => {
    dragDepth.current = 0;
    setInternalIsDragOver(false);
  }, []);

  const reportFiles = useCallback((files: readonly File[]) => {
    if (!files.length) return;
    if (onPickFiles) {
      onPickFiles(files);
    } else {
      files.forEach(onPick);
    }
  }, [onPick, onPickFiles]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    endDrag();
    reportFiles(Array.from(e.dataTransfer.files));
  }, [endDrag, reportFiles]);

  // Attached only when this component owns the drop. A parent that passes
  // `isDragOver` has a `useAttachments` drop target on an ancestor, and that
  // listener already sees this element's drops — see the prop's doc for why
  // both listening means the file is taken in twice.
  const dragProps = isDragOverProp !== undefined ? {} : {
    onDragEnter: enterDrag,
    onDragLeave: leaveDrag,
    // Without preventDefault the browser navigates to the dropped file.
    onDragOver: (e: React.DragEvent) => e.preventDefault(),
    onDrop: handleDrop,
  };

  const blocked = disabled || isExtracting;

  const fileInput = (
    <input
      ref={fileInputRef}
      type="file"
      accept={acceptAttribute(formats)}
      className="hidden"
      onChange={(e) => {
        reportFiles(Array.from(e.target.files ?? []));
        // Reset so re-selecting the same file triggers onChange
        e.target.value = '';
      }}
      multiple
      data-testid={`${testIdPrefix}-file-input`}
    />
  );

  const attachedDocuments = documents ?? (
    extracted && filename ? [{ result: extracted, filename }] : []
  );
  const isTruncated = documentReferenceTextWillTruncate(attachedDocuments);
  const truncationWarning = (
    <p
      className="mt-1 flex items-start gap-1 text-xs text-warning"
      data-testid={`${testIdPrefix}-truncation-warning`}
    >
      <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden />
      Document will be truncated to ~80K characters for the LLM
    </p>
  );

  const removeButton = (index: number, noun: string, extraClass: string) => (
    <button
      type="button"
      onClick={() => onRemove(index)}
      disabled={disabled}
      aria-label={`Remove ${noun}`}
      className={cn(
        'shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
        extraClass,
      )}
      data-testid={`${testIdPrefix}-remove-button`}
    >
      <X size={14} />
    </button>
  );

  // -------------------------------------------------------------------------
  // composer — the docked assistant
  // -------------------------------------------------------------------------

  if (variant === 'composer') {
    return (
      <div
        className={composerRowClass(isDragOver || attachedDocuments.length > 0)}
        data-testid={`${testIdPrefix}-row`}
      >
        {fileInput}

        {isDragOver ? (
          <div
            className="flex min-w-0 flex-1 items-center justify-center gap-2 rounded-md border border-dashed border-primary bg-primary/10 px-2 py-2 text-xs font-medium text-primary-ink"
            data-testid={`${testIdPrefix}-drop-hint`}
          >
            <Upload size={13} aria-hidden />
            Drop to attach
          </div>
        ) : attachedDocuments.length > 0 ? (
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            {attachedDocuments.map((document, index) => (
              <div
                key={`${document.filename}-${index}`}
                className="flex min-w-0 items-start gap-2 rounded-md border border-border bg-background/40 px-2 py-1.5"
                data-testid={`${testIdPrefix}-attachment-card${index === 0 ? '' : `-${index}`}`}
              >
                <FileText size={14} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-foreground" title={document.filename}>
                    {document.filename}
                  </p>
                  <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                    <span className="font-mono uppercase">{document.result.format}</span>
                    {' · '}
                    <span className="font-mono">{formatFileSize(document.result.fileSize)}</span>
                    {usageHint ? ` · ${usageHint}` : ''}
                  </p>
                  {isTruncated && attachedDocuments.length === 1 && truncationWarning}
                </div>
                {removeButton(
                  index,
                  attachedDocuments.length === 1 ? noun : document.filename,
                  '-mr-0.5 -mt-0.5',
                )}
              </div>
            ))}
            {isTruncated && attachedDocuments.length > 1 && truncationWarning}
          </div>
        ) : null}

        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          {...dragProps}
          disabled={blocked}
          aria-label={triggerLabel ?? `Attach a ${noun}`}
          title={triggerLabel ?? `Attach a ${noun}`}
          className={cn(
            // The transparent border is load-bearing: it makes this exactly as
            // tall as the bordered send button, so when this row holds nothing
            // but the trigger the two icons share the composer's last line and
            // one optical centre. (The row owns `self-end`, not the button.)
            'flex shrink-0 items-center rounded-md border border-transparent px-2 py-2',
            'text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            'disabled:pointer-events-none disabled:opacity-50',
            (isDragOver || attachedDocuments.length > 0) && 'text-primary-ink',
          )}
          data-testid={`${testIdPrefix}-attach-button`}
        >
          {isExtracting
            ? <Loader2 size={16} className="animate-spin" aria-hidden />
            : <Paperclip size={16} aria-hidden />}
        </button>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // dropzone — /ai Generate
  // -------------------------------------------------------------------------

  if (attachedDocuments.length > 0) {
    return (
      <div className="flex flex-col gap-2" data-testid={`${testIdPrefix}-preview-list`}>
        {fileInput}
        {attachedDocuments.map((document, index) => (
          <div
            key={`${document.filename}-${index}`}
            className="flex items-start gap-3 rounded-lg border border-border bg-background/50 p-3"
            data-testid={`${testIdPrefix}-preview-card${index === 0 ? '' : `-${index}`}`}
          >
            <FileText size={20} className="mt-0.5 shrink-0 text-primary" aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm font-medium">
                <span className="truncate">{document.filename}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatFileSize(document.result.fileSize)}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {document.result.totalPages === undefined
                    ? FORMAT_META[document.result.format].label
                    : `${document.result.totalPages} ${document.result.totalPages === 1 ? 'page' : 'pages'}`}
                </span>
              </div>
              <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                {document.result.preview}
              </p>
              {isTruncated && attachedDocuments.length === 1 && truncationWarning}
            </div>
            {removeButton(index, attachedDocuments.length === 1 ? noun : document.filename, '')}
          </div>
        ))}
        {isTruncated && attachedDocuments.length > 1 && truncationWarning}
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={blocked}
          className={cn(
            'flex w-full items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-2 text-sm transition-colors',
            'border-border text-muted-foreground hover:border-border hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
          )}
          data-testid={`${testIdPrefix}-add-button`}
        >
          {isExtracting ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Paperclip size={16} aria-hidden />}
          Attach another {noun}
        </button>
      </div>
    );
  }

  return (
    <div>
      {fileInput}
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        {...dragProps}
        disabled={blocked}
        className={cn(
          'flex w-full items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-3 text-sm transition-colors',
          isDragOver
            ? 'border-primary bg-primary/10 text-primary-ink'
            : 'border-border text-muted-foreground hover:border-border hover:text-foreground',
          blocked && 'pointer-events-none opacity-50',
        )}
        data-testid={`${testIdPrefix}-upload-zone`}
      >
        {isExtracting ? (
          <>
            <Loader2 size={16} className="animate-spin" aria-hidden />
            Extracting text...
          </>
        ) : (
          <>
            <Upload size={16} aria-hidden />
            Drop a {noun} here or click to browse (max 20 MB)
          </>
        )}
      </button>
    </div>
  );
}
