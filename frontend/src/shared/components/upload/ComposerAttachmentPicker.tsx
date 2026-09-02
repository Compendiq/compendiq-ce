import { useRef } from 'react';
import { Paperclip } from 'lucide-react';
import { SUPPORTED_DOCUMENT_FORMATS, SUPPORTED_IMAGE_FORMATS } from '@compendiq/contracts';

// This filter helps native file pickers offer the full attachment surface. It
// does not decide what is accepted: `useAttachments` routes and validates the
// selected files, including the chat model's vision capability.
const ATTACHMENT_ACCEPT = [
  ...SUPPORTED_DOCUMENT_FORMATS.map((format) => `.${format}`),
  '.markdown', '.text', '.yml', '.yaml',
  ...SUPPORTED_IMAGE_FORMATS.map((format) => `image/${format}`),
  '.png', '.jpg', '.jpeg', '.webp', '.gif',
].join(',');

/**
 * One trigger for both attachment kinds.
 *
 * Extracted from the dock (#1131) when `/ai`'s Ask composer adopted the same
 * shape: two adjacent triggers made the reader choose a *route* for their file
 * before the app had looked at it, and `useAttachments` already routes
 * document-vs-image itself — including the vision gate, whose refusal reason it
 * surfaces as a toast. The zones (`DocumentUploadZone`, `ImageAttachZone`) stay
 * mounted with `showTrigger={false}` beside this button: they own the staged
 * cards, the drop hint and removal, and contribute no DOM until there is
 * something to show.
 */
export function ComposerAttachmentPicker({
  onPickFiles,
  disabled,
  label = 'Attach a document or image',
  testIdPrefix,
}: {
  onPickFiles: (files: readonly File[]) => void;
  disabled: boolean;
  /** Accessible name and tooltip; name what the file will be used for. */
  label?: string;
  /** Distinguishes the two composers' pickers in tests and in the DOM. */
  testIdPrefix: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="flex shrink-0 items-center self-end">
      <input
        ref={inputRef}
        type="file"
        accept={ATTACHMENT_ACCEPT}
        multiple
        className="hidden"
        onChange={(event) => {
          onPickFiles(Array.from(event.target.files ?? []));
          event.target.value = '';
        }}
        data-testid={`${testIdPrefix}-file-input`}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
        aria-label={label}
        title={label}
        className="flex shrink-0 items-center rounded-md border border-transparent px-2 py-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
        data-testid={`${testIdPrefix}-button`}
      >
        <Paperclip size={16} aria-hidden />
      </button>
    </div>
  );
}
