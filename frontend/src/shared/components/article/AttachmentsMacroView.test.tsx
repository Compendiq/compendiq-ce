import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AttachmentsMacroView } from './AttachmentsMacroView';
import type { NodeViewProps } from '@tiptap/react';

// Mock react-router-dom useParams
vi.mock('react-router-dom', () => ({
  useParams: () => ({ pageId: '12345' }),
}));

// Mock lucide-react icons to avoid render issues in jsdom
vi.mock('lucide-react', () => ({
  File: () => <span data-testid="icon-file" />,
  FileText: () => <span data-testid="icon-file-text" />,
  FileImage: () => <span data-testid="icon-file-image" />,
  FileArchive: () => <span data-testid="icon-file-archive" />,
  FileCode: () => <span data-testid="icon-file-code" />,
  Loader2: () => <span data-testid="icon-loader" />,
}));

function makeProps(overrides: Partial<NodeViewProps> = {}): NodeViewProps {
  return {
    node: {
      attrs: {
        upload: 'false',
        old: 'false',
      },
      ...overrides.node,
    },
    updateAttributes: vi.fn(),
    deleteNode: vi.fn(),
    editor: {
      isEditable: false,
      ...overrides.editor,
    },
    getPos: () => 0,
    extension: {} as NodeViewProps['extension'],
    HTMLAttributes: {},
    decorations: [],
    selected: false,
    ...overrides,
  } as unknown as NodeViewProps;
}

describe('AttachmentsMacroView', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders loading state initially', () => {
    // Never resolve fetch so we stay in loading state
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));

    render(<AttachmentsMacroView {...makeProps()} />);
    expect(screen.getByText('Loading attachments...')).toBeTruthy();
  });

  it('renders attachment list after successful fetch', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        attachments: [
          { filename: 'diagram.png', size: 1024, url: '/api/attachments/12345/diagram.png' },
          { filename: 'report.pdf', size: 2048576, url: '/api/attachments/12345/report.pdf' },
        ],
      }),
    } as Response);

    render(<AttachmentsMacroView {...makeProps()} />);

    await waitFor(() => {
      expect(screen.getByText('diagram.png')).toBeTruthy();
      expect(screen.getByText('report.pdf')).toBeTruthy();
    });

    // Check file sizes are formatted
    expect(screen.getByText('1.0 KB')).toBeTruthy();
    expect(screen.getByText('2.0 MB')).toBeTruthy();
  });

  it('renders empty state when no attachments', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ attachments: [] }),
    } as Response);

    render(<AttachmentsMacroView {...makeProps()} />);

    await waitFor(() => {
      expect(screen.getByText('No attachments found.')).toBeTruthy();
    });
  });

  it('renders error state on fetch failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
    } as Response);

    render(<AttachmentsMacroView {...makeProps()} />);

    await waitFor(() => {
      expect(screen.getByText('Failed to load attachments (500)')).toBeTruthy();
    });
  });

  it('renders download links in read-only mode', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        attachments: [
          { filename: 'doc.txt', size: 100, url: '/api/attachments/12345/doc.txt' },
        ],
      }),
    } as Response);

    render(<AttachmentsMacroView {...makeProps({ editor: { isEditable: false } as NodeViewProps['editor'] })} />);

    await waitFor(() => {
      const link = screen.getByText('doc.txt');
      expect(link.tagName).toBe('A');
      expect(link.getAttribute('href')).toBe('/api/attachments/12345/doc.txt');
    });
  });

  it('renders plain text (not links) in edit mode', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        attachments: [
          { filename: 'doc.txt', size: 100, url: '/api/attachments/12345/doc.txt' },
        ],
      }),
    } as Response);

    render(<AttachmentsMacroView {...makeProps({ editor: { isEditable: true } as NodeViewProps['editor'] })} />);

    await waitFor(() => {
      const el = screen.getByText('doc.txt');
      expect(el.tagName).toBe('SPAN');
    });
  });
});
