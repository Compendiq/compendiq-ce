import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, FileText, Loader2, Paperclip, Upload, X } from 'lucide-react';
import { toast } from 'sonner';
import { SUPPORTED_DOCUMENT_FORMATS, type DocumentFormat } from '@compendiq/contracts';
import type { ExtractDocumentResult } from '../../hooks/use-extract-document';
import { cn } from '../../lib/cn';

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
 * Everything else is shared and lives here exactly once — client-side
 * validation, the 20 MB gate, extraction error handling, and the copy, all of
 * which are derived from {@link DocumentUploadZoneProps.formats} rather than
 * written twice.
 */

/** Server-side upload ceiling, mirrored here so a doomed POST is never sent. */
const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** Above this the backend truncates the document for the model's context window. */
const DOCUMENT_TEXT_TRUNCATION_THRESHOLD = 80_000;

interface DocumentFormatMeta {
  /** How the format is named in copy. Uppercase — these read as file types. */
  label: string;
  /** Accepted filename extensions, without the dot. */
  extensions: readonly string[];
  /** MIME types browsers actually report. Advisory only — see `isAccepted`. */
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
};

/** "PDF", "PDF and DOCX", "PDF, DOCX and MD" — copy, not a machine list. */
function formatList(formats: readonly DocumentFormat[]): string {
  const labels = formats.map((f) => FORMAT_META[f].label);
  if (labels.length <= 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/** The `accept` attribute: extensions *and* MIME types, so both file pickers behave. */
function acceptAttribute(formats: readonly DocumentFormat[]): string {
  return formats
    .flatMap((f) => [
      ...FORMAT_META[f].mimeTypes,
      ...FORMAT_META[f].extensions.map((ext) => `.${ext}`),
    ])
    .join(',');
}

/**
 * Extension *or* MIME match, not both.
 *
 * Browsers disagree wildly about the MIME type of a `.md`, `.rtf` or `.odt` —
 * Chrome reports `''` for Markdown on some platforms — so requiring the MIME to
 * match would reject legitimate files. The bytes are re-sniffed server-side
 * regardless; this check exists only to fail fast and locally.
 */
function isAccepted(file: File, formats: readonly DocumentFormat[]): boolean {
  const name = file.name.toLowerCase();
  return formats.some((f) => {
    const meta = FORMAT_META[f];
    return meta.extensions.some((ext) => name.endsWith(`.${ext}`)) ||
      (file.type !== '' && meta.mimeTypes.includes(file.type));
  });
}

/** Human-readable size. */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface DocumentUploadZoneProps {
  /**
   * Which formats this surface offers. Drives the `accept` attribute, the
   * client-side check, and every string the component renders — a single-format
   * list says "Only PDF files are accepted", a longer one names them all.
   *
   * Defaults to every format the backend supports.
   */
  formats?: readonly DocumentFormat[];
  /**
   * `extractDocument` from a `useExtractDocument()` instance. Pass the parent's
   * instance together with its `isExtracting`, never a second one (#940).
   */
  extract: (file: File) => Promise<ExtractDocumentResult>;
  /** `isExtracting` from that same instance. */
  isExtracting: boolean;
  /** Called with the extraction result and the original filename. */
  onExtracted: (result: ExtractDocumentResult, filename: string) => void;
  /** The extracted document currently attached, or `null`. Parent owns it. */
  extracted: ExtractDocumentResult | null;
  /** Filename of the attached document, or `null`. */
  filename: string | null;
  /** Clear the attachment. */
  onRemove: () => void;
  /** Blocks the trigger — e.g. while a stream is in flight. */
  disabled?: boolean;
  /**
   * `dropzone` (default) is a standing full-width dashed target with a preview
   * card. `composer` is a paperclip button plus a compact attachment card, and
   * renders as a **fragment** meant to sit inside an `nm-composer` that has
   * `flex-wrap` — its full-width rows then stack above the textarea.
   */
  variant?: 'dropzone' | 'composer';
  /** Accessible name and tooltip for the `composer` trigger. */
  triggerLabel?: string;
  /** `composer` only: one line naming what consumes the document. */
  usageHint?: string;
  /**
   * An **ancestor** element that should accept drops instead of the trigger —
   * the dock passes its composer, so a file can be let go anywhere on the
   * prompt box rather than onto a 28px paperclip. Must contain the trigger:
   * when it is set the trigger stops handling drops itself, so that one drop
   * is not extracted twice.
   */
  dropTargetRef?: React.RefObject<HTMLElement | null>;
  /** Prefix for every `data-testid` this renders. */
  testIdPrefix?: string;
}

export function DocumentUploadZone({
  formats = SUPPORTED_DOCUMENT_FORMATS,
  extract,
  isExtracting,
  onExtracted,
  extracted,
  filename,
  onRemove,
  disabled = false,
  variant = 'dropzone',
  triggerLabel,
  usageHint,
  dropTargetRef,
  testIdPrefix = 'document',
}: DocumentUploadZoneProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  // A single-format surface names that format everywhere it would otherwise
  // say "document": pass `formats={['pdf']}` and every string reads "PDF". No
  // surface does today — both take all six since #1132 — but the copy stays
  // derived rather than hardcoded so narrowing one is a one-line change.
  const only = formats.length === 1 ? formats[0] : undefined;
  const noun = only ? FORMAT_META[only].label : 'document';

  const handleFile = useCallback(async (file: File) => {
    if (!isAccepted(file, formats)) {
      toast.error(`Only ${formatList(formats)} files are accepted`);
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      toast.error('File exceeds 20 MB limit');
      return;
    }
    try {
      const result = await extract(file);
      onExtracted(result, file.name);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `${noun} extraction failed`);
    }
  }, [extract, onExtracted, formats, noun]);

  // Drag state is counted, not toggled: `dragleave` fires every time the
  // pointer crosses into a child, so a composer full of children would flicker
  // the hint off under a drag that never actually left.
  const dragDepth = useRef(0);
  const enterDrag = useCallback(() => {
    dragDepth.current += 1;
    setIsDragOver(true);
  }, []);
  const leaveDrag = useCallback(() => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setIsDragOver(false);
  }, []);
  const endDrag = useCallback(() => {
    dragDepth.current = 0;
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    endDrag();
    const file = e.dataTransfer.files[0];
    if (file) void handleFile(file);
  }, [endDrag, handleFile]);

  // When an ancestor is handling drops, the trigger must not handle them too:
  // the ancestor's native listener and this element's React handler would both
  // see the same bubbling event and extract the file twice.
  const dragProps = dropTargetRef ? {} : {
    onDragEnter: enterDrag,
    onDragLeave: leaveDrag,
    // Without preventDefault the browser navigates to the dropped file.
    onDragOver: (e: React.DragEvent) => e.preventDefault(),
    onDrop: handleDrop,
  };

  // Widen the drop target to a parent-owned element. Native listeners rather
  // than cloned props, because the element belongs to the caller's tree.
  const blocked = disabled || isExtracting;
  useEffect(() => {
    const target = dropTargetRef?.current;
    if (!target || blocked) return;

    const onDragOver = (e: DragEvent) => e.preventDefault();
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      endDrag();
      const file = e.dataTransfer?.files[0];
      if (file) void handleFile(file);
    };

    target.addEventListener('dragenter', enterDrag);
    target.addEventListener('dragleave', leaveDrag);
    target.addEventListener('dragover', onDragOver);
    target.addEventListener('drop', onDrop);
    return () => {
      target.removeEventListener('dragenter', enterDrag);
      target.removeEventListener('dragleave', leaveDrag);
      target.removeEventListener('dragover', onDragOver);
      target.removeEventListener('drop', onDrop);
    };
  }, [dropTargetRef, blocked, enterDrag, leaveDrag, endDrag, handleFile]);

  const fileInput = (
    <input
      ref={fileInputRef}
      type="file"
      accept={acceptAttribute(formats)}
      className="hidden"
      onChange={(e) => {
        const file = e.target.files?.[0];
        if (file) void handleFile(file);
        // Reset so re-selecting the same file triggers onChange
        e.target.value = '';
      }}
      data-testid={`${testIdPrefix}-file-input`}
    />
  );

  const isTruncated = (extracted?.text.length ?? 0) > DOCUMENT_TEXT_TRUNCATION_THRESHOLD;
  const truncationWarning = (
    <p
      className="mt-1 flex items-start gap-1 text-xs text-warning"
      data-testid={`${testIdPrefix}-truncation-warning`}
    >
      <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden />
      Document will be truncated to ~80K characters for the LLM
    </p>
  );

  const removeButton = (extraClass: string) => (
    <button
      type="button"
      onClick={onRemove}
      disabled={disabled}
      aria-label={`Remove ${noun}`}
      className={cn(
        'shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50',
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
      <>
        {fileInput}

        {isDragOver ? (
          <div
            className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-primary bg-primary/10 px-2 py-2 text-xs font-medium text-primary-ink"
            data-testid={`${testIdPrefix}-drop-hint`}
          >
            <Upload size={13} aria-hidden />
            Drop to attach
          </div>
        ) : extracted && filename ? (
          <div
            className="flex w-full items-start gap-2 rounded-md border border-border bg-background/40 px-2 py-1.5"
            data-testid={`${testIdPrefix}-attachment-card`}
          >
            <FileText size={14} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium text-foreground" title={filename}>
                {filename}
              </p>
              {/* Format and size are data figures, so they take the mono face.
                  The hint after them is the honest part: this document feeds
                  one action, and saying so beats letting the user assume the
                  next message carries it. */}
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                <span className="font-mono uppercase">{extracted.format}</span>
                {' · '}
                <span className="font-mono">{formatFileSize(extracted.fileSize)}</span>
                {usageHint ? ` · ${usageHint}` : ''}
              </p>
              {isTruncated && truncationWarning}
            </div>
            {removeButton('-mr-0.5 -mt-0.5')}
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
            // tall as the bordered send button beside it, so two self-end icons
            // on the composer's last line share one optical centre.
            'flex shrink-0 self-end items-center rounded-md border border-transparent px-2 py-2',
            'text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
            'disabled:pointer-events-none disabled:opacity-50',
            (isDragOver || extracted) && 'text-primary-ink',
          )}
          data-testid={`${testIdPrefix}-attach-button`}
        >
          {isExtracting
            ? <Loader2 size={16} className="animate-spin" aria-hidden />
            : <Paperclip size={16} aria-hidden />}
        </button>
      </>
    );
  }

  // -------------------------------------------------------------------------
  // dropzone — /ai Generate
  // -------------------------------------------------------------------------

  if (extracted && filename) {
    return (
      <div
        className="flex items-start gap-3 rounded-lg border border-border/40 bg-background/50 p-3"
        data-testid={`${testIdPrefix}-preview-card`}
      >
        <FileText size={20} className="mt-0.5 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm font-medium">
            <span className="truncate">{filename}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {formatFileSize(extracted.fileSize)}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {/* Paged formats report a page count; the rest name themselves
                  rather than claim a page count they do not have. */}
              {extracted.totalPages === undefined
                ? FORMAT_META[extracted.format].label
                : `${extracted.totalPages} ${extracted.totalPages === 1 ? 'page' : 'pages'}`}
            </span>
          </div>
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
            {extracted.preview}
          </p>
          {isTruncated && truncationWarning}
        </div>
        {removeButton('')}
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
            : 'border-border/40 text-muted-foreground hover:border-border/60 hover:text-foreground',
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
