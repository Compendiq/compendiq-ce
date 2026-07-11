import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AttachmentsMacroView } from './AttachmentsMacroView';
import type { NodeViewProps } from '@tiptap/react';

// Mock react-router-dom useParams. The real router only ever exposes `:id`
// (the internal integer PK) — there is no `:pageId` route param. #876.
vi.mock('react-router-dom', () => ({
  useParams: () => ({ id: '123' }),
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

// Mock the shared authenticated api helper. The component must use apiFetch
// (which attaches the Authorization header) rather than a bare fetch().
// usePage (via the mocked module) and the attachments-list call both route
// through this single mock, so it dispatches by URL.
const mockApiFetch = vi.fn();
vi.mock('../../lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

interface Attachment {
  filename: string;
  size: number;
  url: string;
}

/**
 * Configure the apiFetch mock to dispatch by URL:
 *  - a `/pages/:id` request resolves the page detail (drives usePage keying)
 *  - any other (the attachments-list) request resolves the list, an error,
 *    or a never-resolving promise.
 */
function mockApi(opts: {
  page?: { id: number; confluenceId: string | null };
  attachments?: Attachment[] | Error | 'pending';
}) {
  const page = opts.page ?? { id: 123, confluenceId: '99001' };
  mockApiFetch.mockImplementation((url: string) => {
    if (url.startsWith('/pages/')) {
      return Promise.resolve(page);
    }
    // attachments-list request
    if (opts.attachments === 'pending') return new Promise(() => {});
    if (opts.attachments instanceof Error) return Promise.reject(opts.attachments);
    return Promise.resolve({ attachments: opts.attachments ?? [] });
  });
}

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

function renderView(props: NodeViewProps = makeProps()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AttachmentsMacroView {...props} />
    </QueryClientProvider>,
  );
}

describe('AttachmentsMacroView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keys a Confluence page by its confluence_id, not the internal PK (#876)', async () => {
    mockApi({ page: { id: 123, confluenceId: '99001' }, attachments: [] });

    renderView();

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/attachments/99001/list');
    });
    // The internal PK must never be sent to the Confluence list route — the
    // backend resolves confluence_id only, so keying by PK would 404 (or worse,
    // list the wrong page's attachments if the PK collides with a confluence_id).
    expect(mockApiFetch).not.toHaveBeenCalledWith('/attachments/123/list');
  });

  it('keys a standalone page by its internal PK against /local-attachments (#876)', async () => {
    mockApi({ page: { id: 123, confluenceId: null }, attachments: [] });

    renderView();

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/local-attachments/123/list');
    });
    expect(mockApiFetch).not.toHaveBeenCalledWith('/attachments/123/list');
  });

  it('renders loading state initially', () => {
    // Neither the page nor the attachments list resolves — stay in loading.
    mockApiFetch.mockImplementation(() => new Promise(() => {}));

    renderView();
    expect(screen.getByText('Loading attachments...')).toBeTruthy();
  });

  it('renders attachment list after successful fetch', async () => {
    mockApi({
      page: { id: 123, confluenceId: '99001' },
      attachments: [
        { filename: 'diagram.png', size: 1024, url: '/api/attachments/99001/diagram.png' },
        { filename: 'report.pdf', size: 2048576, url: '/api/attachments/99001/report.pdf' },
      ],
    });

    renderView();

    await waitFor(() => {
      expect(screen.getByText('diagram.png')).toBeTruthy();
      expect(screen.getByText('report.pdf')).toBeTruthy();
    });

    // Check file sizes are formatted
    expect(screen.getByText('1.0 KB')).toBeTruthy();
    expect(screen.getByText('2.0 MB')).toBeTruthy();
  });

  it('renders empty state when no attachments', async () => {
    mockApi({ page: { id: 123, confluenceId: '99001' }, attachments: [] });

    renderView();

    await waitFor(() => {
      expect(screen.getByText('No attachments found.')).toBeTruthy();
    });
  });

  it('renders error state on fetch failure', async () => {
    mockApi({
      page: { id: 123, confluenceId: '99001' },
      attachments: new Error('Failed to load attachments'),
    });

    renderView();

    await waitFor(() => {
      expect(screen.getByText('Failed to load attachments')).toBeTruthy();
    });
  });

  it('renders download links in read-only mode', async () => {
    mockApi({
      page: { id: 123, confluenceId: '99001' },
      attachments: [
        { filename: 'doc.txt', size: 100, url: '/api/attachments/99001/doc.txt' },
      ],
    });

    renderView(makeProps({ editor: { isEditable: false } as NodeViewProps['editor'] }));

    await waitFor(() => {
      const link = screen.getByText('doc.txt');
      expect(link.tagName).toBe('A');
      expect(link.getAttribute('href')).toBe('/api/attachments/99001/doc.txt');
    });
  });

  it('renders plain text (not links) in edit mode', async () => {
    mockApi({
      page: { id: 123, confluenceId: '99001' },
      attachments: [
        { filename: 'doc.txt', size: 100, url: '/api/attachments/99001/doc.txt' },
      ],
    });

    renderView(makeProps({ editor: { isEditable: true } as NodeViewProps['editor'] }));

    await waitFor(() => {
      const el = screen.getByText('doc.txt');
      expect(el.tagName).toBe('SPAN');
    });
  });
});
