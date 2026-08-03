/**
 * The shared document-upload affordance (#1131, presentational since #1154).
 *
 * What this component decides was deliberately narrowed: it no longer inspects
 * a file, extracts it, or refuses it. It picks one and reports it upward. So
 * what matters here is the reporting contract and what each variant renders —
 * the gates that used to live here are now `useAttachments`' job, and the cases
 * that covered them moved to `use-attachments.test.ts` (format acceptance, the
 * refusal message, the 20 MB ceiling, and the extraction-error toast).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { type DocumentFormat } from '@compendiq/contracts';
import { DocumentUploadZone, type DocumentUploadZoneProps } from './DocumentUploadZone';
import type { ExtractDocumentResult } from '../../hooks/use-extract-document';

const toastErrorMock = vi.fn();
vi.mock('sonner', () => ({
  toast: { error: (...args: unknown[]) => toastErrorMock(...args), success: vi.fn() },
}));

const onPickMock = vi.fn<(file: File) => void>();

function result(over: Partial<ExtractDocumentResult> = {}): ExtractDocumentResult {
  return {
    format: 'pdf',
    text: 'extracted text',
    fileSize: 2048,
    preview: 'extracted text',
    totalPages: 5,
    ...over,
  };
}

/** What the harness's stand-in parent attaches on the next pick. */
let nextResult: ExtractDocumentResult = result();

/**
 * Renders with parent-owned attachment state, the way both real callers do.
 *
 * The parent stands in for `useAttachments`: it takes whatever file the
 * component reports and attaches it unconditionally. That is the point — the
 * component is not consulted about acceptability any more.
 */
function Harness(props: Partial<DocumentUploadZoneProps>) {
  const [attached, setAttached] = useState<{ result: ExtractDocumentResult; filename: string } | null>(null);
  return (
    <div data-testid="outer">
      <DocumentUploadZone
        onPick={(file) => {
          onPickMock(file);
          setAttached({ result: nextResult, filename: file.name });
        }}
        isExtracting={false}
        extracted={attached?.result ?? null}
        filename={attached?.filename ?? null}
        onRemove={() => setAttached(null)}
        {...props}
      />
    </div>
  );
}

function pick(file: File, testId = 'document-file-input') {
  fireEvent.change(screen.getByTestId(testId), { target: { files: [file] } });
}

/** A file with the extension and MIME a browser would report for that format. */
const SAMPLE: Record<DocumentFormat, File> = {
  pdf: new File(['%PDF-1.4'], 'report.pdf', { type: 'application/pdf' }),
  docx: new File(['PK'], 'q3.docx', {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  }),
  // Markdown is the case that matters: Chrome reports an empty type for it on
  // some platforms, so only the extension can vouch for the file.
  md: new File(['# Notes'], 'notes.md', { type: '' }),
  txt: new File(['plain'], 'notes.txt', { type: 'text/plain' }),
  rtf: new File(['{\\rtf1'], 'memo.rtf', { type: '' }),
  odt: new File(['PK'], 'plan.odt', { type: 'application/vnd.oasis.opendocument.text' }),
};

describe('DocumentUploadZone', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nextResult = result();
  });

  describe('reporting the picked file', () => {
    /**
     * One format, not six. Since #1154 this component does not inspect the
     * file at all — it reports whatever it was handed — so six fixtures
     * exercised one code path six times and read as coverage of an acceptance
     * rule that no longer lives here. Every supported extension (with the
     * empty MIME type Chrome reports for `.md`) is parametrised in
     * `use-attachments.test.ts`, which is where acceptance is now decided.
     */
    it('hands a picked file straight to onPick', () => {
      render(<Harness />);
      pick(SAMPLE.pdf);

      expect(onPickMock).toHaveBeenCalledWith(SAMPLE.pdf);
    });

    /**
     * The refactor's whole reason for existing (#1154). This component used to
     * refuse a PNG with "Only PDF, DOCX… are accepted"; on a shared composer
     * drop target that would silently swallow every attached image. It must now
     * report the file and let `useAttachments` route it.
     */
    it('reports a file it does not offer, rather than refusing it', () => {
      const png = new File(['x'], 'diagram.png', { type: 'image/png' });
      render(<Harness />);
      pick(png);

      expect(onPickMock).toHaveBeenCalledWith(png);
      expect(toastErrorMock).not.toHaveBeenCalled();
    });

    /** Same, for a narrowed surface: `formats` is copy and a picker filter now. */
    it('reports a file outside its own formats list without complaining', () => {
      render(<Harness formats={['pdf']} />);
      pick(SAMPLE.txt);

      expect(onPickMock).toHaveBeenCalledWith(SAMPLE.txt);
      expect(toastErrorMock).not.toHaveBeenCalled();
    });

    it('offers every extension and MIME type in the accept attribute', () => {
      render(<Harness />);
      const accept = screen.getByTestId('document-file-input').getAttribute('accept') ?? '';

      for (const ext of ['.pdf', '.docx', '.md', '.markdown', '.txt', '.rtf', '.odt']) {
        expect(accept).toContain(ext);
      }
      expect(accept).toContain('application/pdf');
      expect(accept).toContain('application/vnd.oasis.opendocument.text');
    });

    /** The `accept` list still narrows what the picker offers, even though it
     *  no longer refuses anything that gets through it. */
    it('narrows the accept attribute to the formats it is given', () => {
      render(<Harness formats={['pdf']} />);
      const accept = screen.getByTestId('document-file-input').getAttribute('accept') ?? '';

      expect(accept).toContain('.pdf');
      expect(accept).not.toContain('.docx');
      expect(accept).not.toContain('.odt');
    });
  });

  describe('dropzone variant', () => {
    it('names the one format it offers, or "document" when it offers several', () => {
      const { unmount } = render(<Harness formats={['pdf']} />);
      expect(screen.getByText(/Drop a PDF here or click to browse/)).toBeInTheDocument();
      unmount();

      render(<Harness />);
      expect(screen.getByText(/Drop a document here or click to browse/)).toBeInTheDocument();
    });

    it('shows the page count for a paged format and the format name otherwise', async () => {
      const { unmount } = render(<Harness />);
      pick(SAMPLE.pdf);
      await waitFor(() => expect(screen.getByTestId('document-preview-card')).toBeInTheDocument());
      expect(screen.getByText('5 pages')).toBeInTheDocument();
      unmount();

      nextResult = result({ format: 'docx', totalPages: undefined });
      render(<Harness />);
      pick(SAMPLE.docx);
      await waitFor(() => expect(screen.getByTestId('document-preview-card')).toBeInTheDocument());
      expect(screen.getByText('DOCX')).toBeInTheDocument();
    });

    it('warns once the text passes the backend truncation threshold', async () => {
      nextResult = result({ text: 'x'.repeat(80_001) });

      render(<Harness />);
      pick(SAMPLE.pdf);

      await waitFor(() => {
        expect(screen.getByTestId('document-truncation-warning')).toBeInTheDocument();
      });
    });

    it('shows no truncation warning for a document under the threshold', async () => {
      render(<Harness />);
      pick(SAMPLE.pdf);

      await screen.findByTestId('document-preview-card');
      expect(screen.queryByTestId('document-truncation-warning')).not.toBeInTheDocument();
    });

    it('accepts a dropped file and clears it again', async () => {
      render(<Harness formats={['pdf']} />);

      const zone = screen.getByTestId('document-upload-zone');
      fireEvent.dragEnter(zone);
      fireEvent.drop(zone, { dataTransfer: { files: [SAMPLE.pdf] } });

      expect(onPickMock).toHaveBeenCalledWith(SAMPLE.pdf);
      await waitFor(() => expect(screen.getByTestId('document-preview-card')).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: 'Remove PDF' }));
      expect(screen.queryByTestId('document-preview-card')).not.toBeInTheDocument();
      expect(screen.getByTestId('document-upload-zone')).toBeInTheDocument();
    });

    /**
     * This variant IS its own drop target, so it keeps the counted drag state:
     * `dragleave` fires every time the pointer crosses into a child, and
     * toggling instead of counting would flicker the highlight off mid-drag.
     */
    it('holds its own drag highlight until the drag really leaves', () => {
      render(<Harness formats={['pdf']} />);
      const zone = screen.getByTestId('document-upload-zone');

      expect(zone.className).not.toContain('border-primary');

      fireEvent.dragEnter(zone);
      fireEvent.dragEnter(zone);
      expect(screen.getByTestId('document-upload-zone').className).toContain('border-primary');

      fireEvent.dragLeave(zone);
      expect(screen.getByTestId('document-upload-zone').className).toContain('border-primary');

      fireEvent.dragLeave(zone);
      expect(screen.getByTestId('document-upload-zone').className).not.toContain('border-primary');
    });

    it('prefixes every test id so a surface can keep its own names', () => {
      render(<Harness formats={['pdf']} testIdPrefix="pdf" />);
      expect(screen.getByTestId('pdf-upload-zone')).toBeInTheDocument();
      expect(screen.getByTestId('pdf-file-input')).toBeInTheDocument();
    });
  });

  describe('composer variant', () => {
    it('shows only a trigger until something is attached', () => {
      render(<Harness variant="composer" />);

      expect(screen.getByTestId('document-attach-button')).toBeInTheDocument();
      expect(screen.queryByTestId('document-attachment-card')).not.toBeInTheDocument();
      expect(screen.queryByTestId('document-upload-zone')).not.toBeInTheDocument();
    });

    it('takes its accessible name from the surface that mounts it', () => {
      render(<Harness variant="composer" triggerLabel="Attach a document as reference for Improve" />);

      expect(
        screen.getByRole('button', { name: 'Attach a document as reference for Improve' }),
      ).toBeInTheDocument();
    });

    it('reports the format, the size and what the document is for', async () => {
      nextResult = result({ format: 'docx', totalPages: undefined, fileSize: 12_800 });

      render(<Harness variant="composer" usageHint="reference for Improve" />);
      pick(SAMPLE.docx);

      const card = await screen.findByTestId('document-attachment-card');
      expect(card).toHaveTextContent('q3.docx');
      expect(card).toHaveTextContent('docx');
      expect(card).toHaveTextContent('12.5 KB');
      expect(card).toHaveTextContent('reference for Improve');
    });

    it('detaches the document', async () => {
      render(<Harness variant="composer" />);
      pick(SAMPLE.pdf);
      await screen.findByTestId('document-attachment-card');

      fireEvent.click(screen.getByRole('button', { name: 'Remove document' }));
      expect(screen.queryByTestId('document-attachment-card')).not.toBeInTheDocument();
    });

    it('spins and blocks the trigger while an extraction is in flight', () => {
      render(<Harness variant="composer" isExtracting />);
      expect(screen.getByTestId('document-attach-button')).toBeDisabled();
    });

    /**
     * The parent owns the composer drop target (#1154), so it owns the drag
     * state too — this component's own state only ever sees a drag over the
     * 28px paperclip, which is not what the user is aiming at.
     */
    it('shows the drop hint when the parent reports a drag over the composer', () => {
      const { rerender } = render(<Harness variant="composer" isDragOver={false} />);
      expect(screen.queryByTestId('document-drop-hint')).not.toBeInTheDocument();

      rerender(<Harness variant="composer" isDragOver />);
      expect(screen.getByTestId('document-drop-hint')).toBeInTheDocument();
    });

    /** The parent's answer wins: a drag over the trigger alone must not be able
     *  to contradict a parent that says no drag is in progress. */
    it('lets the parent state override its own', () => {
      render(<Harness variant="composer" isDragOver={false} />);
      fireEvent.dragEnter(screen.getByTestId('document-attach-button'));

      expect(screen.queryByTestId('document-drop-hint')).not.toBeInTheDocument();
    });

    /** With no parent state — any caller that does not own a drop target — it
     *  still falls back to its own. */
    it('falls back to its own drag state when the parent supplies none', () => {
      render(<Harness variant="composer" />);
      fireEvent.dragEnter(screen.getByTestId('document-attach-button'));

      expect(screen.getByTestId('document-drop-hint')).toBeInTheDocument();
    });

    /** The trigger keeps handling drops itself now that no ancestor prop can
     *  switch them off — a file let go directly on the paperclip must land, and
     *  exactly once. */
    it('accepts a file dropped on the trigger itself', () => {
      render(<Harness variant="composer" />);
      fireEvent.drop(screen.getByTestId('document-attach-button'), {
        dataTransfer: { files: [SAMPLE.docx] },
      });

      expect(onPickMock).toHaveBeenCalledTimes(1);
      expect(onPickMock).toHaveBeenCalledWith(SAMPLE.docx);
    });
  });
});
