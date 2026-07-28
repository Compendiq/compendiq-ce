/**
 * The shared document-upload affordance (#1131).
 *
 * Rendered for real with a stubbed `extract` — the network boundary is the
 * hook, and it is tested separately in `use-extract-document.test.ts`. What
 * matters here is everything the component decides on its own: which files it
 * lets through, what it says when it refuses one, and what each variant shows.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { SUPPORTED_DOCUMENT_FORMATS, type DocumentFormat } from '@compendiq/contracts';
import { DocumentUploadZone, type DocumentUploadZoneProps } from './DocumentUploadZone';
import type { ExtractDocumentResult } from '../../hooks/use-extract-document';

const toastErrorMock = vi.fn();
vi.mock('sonner', () => ({
  toast: { error: (...args: unknown[]) => toastErrorMock(...args), success: vi.fn() },
}));

const extractMock = vi.fn<(file: File) => Promise<ExtractDocumentResult>>();

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

/** Renders with parent-owned attachment state, the way both real callers do. */
function Harness(props: Partial<DocumentUploadZoneProps>) {
  const [extracted, setExtracted] = useState<ExtractDocumentResult | null>(null);
  const [filename, setFilename] = useState<string | null>(null);
  return (
    <div data-testid="outer">
      <DocumentUploadZone
        extract={extractMock}
        isExtracting={false}
        onExtracted={(r, name) => {
          setExtracted(r);
          setFilename(name);
        }}
        extracted={extracted}
        filename={filename}
        onRemove={() => {
          setExtracted(null);
          setFilename(null);
        }}
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
    extractMock.mockResolvedValue(result());
  });

  describe('accepted formats', () => {
    it.each(SUPPORTED_DOCUMENT_FORMATS)('uploads a %s when all formats are offered', async (format) => {
      render(<Harness />);
      pick(SAMPLE[format]);

      await waitFor(() => expect(extractMock).toHaveBeenCalledWith(SAMPLE[format]));
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

    it('names every offered format when it refuses a file', async () => {
      render(<Harness />);
      pick(new File(['x'], 'photo.png', { type: 'image/png' }));

      await waitFor(() => {
        expect(toastErrorMock).toHaveBeenCalledWith(
          'Only PDF, DOCX, MD, TXT, RTF and ODT files are accepted',
        );
      });
      expect(extractMock).not.toHaveBeenCalled();
    });

    // The prop that keeps Generate PDF-only while the endpoint behind it is not.
    it('restricts to the formats it is given, and says so', async () => {
      render(<Harness formats={['pdf']} />);
      pick(SAMPLE.txt);

      await waitFor(() => {
        expect(toastErrorMock).toHaveBeenCalledWith('Only PDF files are accepted');
      });
      expect(extractMock).not.toHaveBeenCalled();

      pick(SAMPLE.pdf);
      await waitFor(() => expect(extractMock).toHaveBeenCalledWith(SAMPLE.pdf));
    });

    it('accepts a file whose extension matches even when the browser reports no MIME type', async () => {
      render(<Harness formats={['md']} />);
      pick(SAMPLE.md);

      await waitFor(() => expect(extractMock).toHaveBeenCalled());
    });

    it('refuses a file over 20 MB without contacting the server', async () => {
      const huge = new File(['x'], 'huge.pdf', { type: 'application/pdf' });
      Object.defineProperty(huge, 'size', { value: 21 * 1024 * 1024 });

      render(<Harness formats={['pdf']} />);
      pick(huge);

      await waitFor(() => {
        expect(toastErrorMock).toHaveBeenCalledWith('File exceeds 20 MB limit');
      });
      expect(extractMock).not.toHaveBeenCalled();
    });

    it('surfaces the extraction error', async () => {
      extractMock.mockRejectedValue(new Error('PDF contains no extractable text'));

      render(<Harness formats={['pdf']} />);
      pick(SAMPLE.pdf);

      await waitFor(() => {
        expect(toastErrorMock).toHaveBeenCalledWith('PDF contains no extractable text');
      });
      expect(screen.queryByTestId('document-preview-card')).not.toBeInTheDocument();
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

      extractMock.mockResolvedValue(result({ format: 'docx', totalPages: undefined }));
      render(<Harness />);
      pick(SAMPLE.docx);
      await waitFor(() => expect(screen.getByTestId('document-preview-card')).toBeInTheDocument());
      expect(screen.getByText('DOCX')).toBeInTheDocument();
    });

    it('warns once the text passes the backend truncation threshold', async () => {
      extractMock.mockResolvedValue(result({ text: 'x'.repeat(80_001) }));

      render(<Harness />);
      pick(SAMPLE.pdf);

      await waitFor(() => {
        expect(screen.getByTestId('document-truncation-warning')).toBeInTheDocument();
      });
    });

    it('accepts a dropped file and clears it again', async () => {
      render(<Harness formats={['pdf']} />);

      const zone = screen.getByTestId('document-upload-zone');
      fireEvent.dragEnter(zone);
      fireEvent.drop(zone, { dataTransfer: { files: [SAMPLE.pdf] } });

      await waitFor(() => expect(screen.getByTestId('document-preview-card')).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: 'Remove PDF' }));
      expect(screen.queryByTestId('document-preview-card')).not.toBeInTheDocument();
      expect(screen.getByTestId('document-upload-zone')).toBeInTheDocument();
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
      extractMock.mockResolvedValue(result({ format: 'docx', totalPages: undefined, fileSize: 12_800 }));

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

    it('offers the whole composer as a drop target when given one', async () => {
      function Wrapper() {
        const [box, setBox] = useState<HTMLDivElement | null>(null);
        return (
          <div ref={setBox} data-testid="composer-box">
            {/* A plain object ref, which is what a real `useRef` hands over. */}
            <Harness variant="composer" dropTargetRef={{ current: box }} />
            <textarea aria-label="prompt" />
          </div>
        );
      }
      render(<Wrapper />);

      const box = screen.getByTestId('composer-box');
      fireEvent.dragEnter(box);
      expect(await screen.findByTestId('document-drop-hint')).toBeInTheDocument();

      fireEvent.drop(box, { dataTransfer: { files: [SAMPLE.docx] } });
      await waitFor(() => expect(extractMock).toHaveBeenCalledTimes(1));
      expect(screen.queryByTestId('document-drop-hint')).not.toBeInTheDocument();
    });

    it('keeps the hint up while the pointer crosses the composer’s children', async () => {
      function Wrapper() {
        const [box, setBox] = useState<HTMLDivElement | null>(null);
        return (
          <div ref={setBox} data-testid="composer-box">
            <Harness variant="composer" dropTargetRef={{ current: box }} />
            <textarea aria-label="prompt" />
          </div>
        );
      }
      render(<Wrapper />);

      const box = screen.getByTestId('composer-box');
      const child = screen.getByLabelText('prompt');

      fireEvent.dragEnter(box);
      // Crossing into a child: the child's dragenter bubbles up while the
      // previous target's dragleave fires. Net zero — the hint must survive.
      fireEvent.dragEnter(child);
      fireEvent.dragLeave(box);
      expect(await screen.findByTestId('document-drop-hint')).toBeInTheDocument();

      fireEvent.dragLeave(child);
      await waitFor(() => {
        expect(screen.queryByTestId('document-drop-hint')).not.toBeInTheDocument();
      });
    });
  });
});
