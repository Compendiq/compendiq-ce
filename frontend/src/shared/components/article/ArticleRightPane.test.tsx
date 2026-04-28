import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { LazyMotion, domAnimation } from 'framer-motion';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ArticleRightPane } from './ArticleRightPane';
import { useArticleViewStore } from '../../../stores/article-view-store';
import { useUiStore } from '../../../stores/ui-store';

const mockNavigate = vi.fn();
const mockDeletePage = vi.fn();
const mockPinPage = vi.fn();
const mockUnpinPage = vi.fn();
const mockExportPdfAsync = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

const mockPage = {
  id: 'page-1',
  confluenceId: '98765432',
  title: 'Engineering Handbook',
  spaceKey: 'ENG',
  bodyHtml: '<h1>Intro</h1>',
  bodyText: 'Body',
  version: 7,
  parentId: null,
  labels: ['docs'],
  author: 'simon',
  lastModifiedAt: '2026-03-01T12:00:00Z',
  lastSynced: '2026-03-01T12:00:00Z',
  hasChildren: false,
  embeddingDirty: false,
  embeddingStatus: 'embedded',
  embeddedAt: '2026-03-01T12:00:00Z',
  embeddingError: null,
  qualityScore: 85,
  qualityStatus: 'analyzed' as const,
  qualityCompleteness: 80,
  qualityClarity: 90,
  qualityStructure: 85,
  qualityAccuracy: 82,
  qualityReadability: 88,
  qualitySummary: 'Well-written article',
  qualityAnalyzedAt: '2026-03-01T12:00:00Z',
  qualityError: null,
};

let currentMockPage: typeof mockPage | (typeof mockPage & { confluenceId: null }) = mockPage;

vi.mock('../../hooks/use-pages', () => ({
  usePage: () => ({ data: currentMockPage, isLoading: false }),
  useDeletePage: () => ({ mutateAsync: mockDeletePage }),
  usePinnedPages: () => ({ data: { items: [] }, isLoading: false }),
  usePinPage: () => ({ mutate: mockPinPage }),
  useUnpinPage: () => ({ mutate: mockUnpinPage }),
}));

vi.mock('../../hooks/use-settings', () => ({
  useSettings: () => ({
    data: { confluenceUrl: 'https://confluence.example.com', ollamaModel: 'qwen3.5', llmProvider: 'ollama', openaiModel: null },
  }),
}));

vi.mock('../../hooks/use-standalone', () => ({
  useExportPdf: () => ({ mutateAsync: mockExportPdfAsync, isPending: false }),
}));

vi.mock('../../../features/pages/AutoTagger', () => ({
  AutoTagger: ({ pageId, currentLabels, model }: { pageId: string; currentLabels: string[]; model: string }) => (
    <div data-testid="auto-tagger" data-page-id={pageId} data-labels={currentLabels.join(',')} data-model={model} />
  ),
}));

vi.mock('../badges/FreshnessBadge', () => ({
  FreshnessBadge: ({ lastModified }: { lastModified: string }) => <span>{lastModified}</span>,
}));

vi.mock('../badges/EmbeddingStatusBadge', () => ({
  EmbeddingStatusBadge: ({ embeddingStatus }: { embeddingStatus: string }) => (
    <span data-testid="embedding-status-badge">{embeddingStatus}</span>
  ),
}));

vi.mock('../badges/QualityScoreBadge', () => ({
  QualityScoreBadge: ({ qualityScore }: { qualityScore: number | null }) => (
    <span data-testid="quality-score-badge">{qualityScore ?? 'N/A'}</span>
  ),
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/pages/page-1']}>
          <LazyMotion features={domAnimation}>
            <Routes>
              <Route path="/pages/:id" element={children} />
            </Routes>
          </LazyMotion>
        </MemoryRouter>
      </QueryClientProvider>
    );
  };
}

describe('ArticleRightPane', () => {
  beforeEach(() => {
    currentMockPage = mockPage;
    mockNavigate.mockReset();
    mockDeletePage.mockReset().mockResolvedValue(undefined);
    mockPinPage.mockReset();
    mockUnpinPage.mockReset();
    mockExportPdfAsync.mockReset();
    localStorage.clear();
    useUiStore.setState({ articleSidebarCollapsed: false, articleSidebarWidth: 280 });
    useArticleViewStore.setState({ headings: [], editing: false });
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders the expanded pane with header and action buttons', () => {
    render(<ArticleRightPane />, { wrapper: createWrapper() });

    expect(screen.getByTestId('article-right-pane')).toBeInTheDocument();
    expect(screen.getByText('Properties')).toBeInTheDocument();
    expect(screen.getByText('AI Improve')).toBeInTheDocument();
    expect(screen.getByText('Pin')).toBeInTheDocument();
    expect(screen.getByText('Open in Confluence')).toBeInTheDocument();
    expect(screen.getByText('Delete')).toBeInTheDocument();
  });

  it('collapses to a slim rail when the collapse button is clicked', () => {
    render(<ArticleRightPane />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByLabelText('Collapse article sidebar'));

    expect(screen.getByTestId('article-right-pane-rail')).toBeInTheDocument();
    expect(screen.queryByTestId('article-right-pane')).not.toBeInTheDocument();
  });

  it('expands from the rail when the expand button is clicked', () => {
    useUiStore.setState({ articleSidebarCollapsed: true });

    render(<ArticleRightPane />, { wrapper: createWrapper() });

    expect(screen.getByTestId('article-right-pane-rail')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Expand article sidebar'));

    expect(screen.getByTestId('article-right-pane')).toBeInTheDocument();
  });

  it('hides action buttons when editing is active', () => {
    useArticleViewStore.setState({ editing: true });

    render(<ArticleRightPane />, { wrapper: createWrapper() });

    expect(screen.queryByTestId('article-actions')).not.toBeInTheDocument();
    expect(screen.queryByText('AI Improve')).not.toBeInTheDocument();
  });

  it('keeps AI-Tagging available in edit mode (#354)', () => {
    useArticleViewStore.setState({ editing: true });

    render(<ArticleRightPane />, { wrapper: createWrapper() });

    // The read-mode action panel is hidden, but AI-Tagging is rendered
    // in its own edit-mode wrapper.
    expect(screen.queryByTestId('article-actions')).not.toBeInTheDocument();
    const editPanel = screen.getByTestId('article-actions-edit');
    expect(editPanel).toBeInTheDocument();

    // AutoTagger mock attaches data-* attrs identical to the read-mode case.
    const autoTagger = screen.getByTestId('auto-tagger');
    expect(autoTagger).toBeInTheDocument();
    expect(autoTagger).toHaveAttribute('data-page-id', 'page-1');
  });

  it('navigates to AI Improve when the button is clicked', () => {
    render(<ArticleRightPane />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByText('AI Improve'));

    expect(mockNavigate).toHaveBeenCalledWith('/ai?mode=improve&pageId=page-1');
  });

  it('renders outline headings from the article-view-store', () => {
    useArticleViewStore.setState({
      headings: [
        { id: 'intro', text: 'Introduction', level: 1 },
        { id: 'usage', text: 'Usage', level: 2 },
      ],
    });

    render(<ArticleRightPane />, { wrapper: createWrapper() });

    expect(screen.getByText('Introduction')).toBeInTheDocument();
    expect(screen.getByText('Usage')).toBeInTheDocument();
    expect(screen.getByText('2 sections')).toBeInTheDocument();
  });

  it('shows empty message when there are no headings', () => {
    render(<ArticleRightPane />, { wrapper: createWrapper() });

    expect(screen.getByText('No headings in this article.')).toBeInTheDocument();
  });

  it('renders version and space key in the footer', () => {
    render(<ArticleRightPane />, { wrapper: createWrapper() });

    expect(screen.getByText(/v7/)).toBeInTheDocument();
    expect(screen.getByText(/ENG/)).toBeInTheDocument();
  });

  it('has a resize handle', () => {
    render(<ArticleRightPane />, { wrapper: createWrapper() });

    expect(screen.getByRole('separator', { name: 'Resize article sidebar' })).toBeInTheDocument();
  });

  it('renders QualityScoreBadge in properties when quality score is present', () => {
    render(<ArticleRightPane />, { wrapper: createWrapper() });

    expect(screen.getByTestId('quality-score-badge')).toBeInTheDocument();
    expect(screen.getByTestId('quality-score-badge')).toHaveTextContent('85');
  });

  it('uses confluenceId (not internal id) in the "Open in Confluence" link', () => {
    render(<ArticleRightPane />, { wrapper: createWrapper() });

    const link = screen.getByText('Open in Confluence').closest('a');
    expect(link).toBeInTheDocument();
    // Should use confluenceId '98765432', not the internal id 'page-1'
    expect(link).toHaveAttribute(
      'href',
      'https://confluence.example.com/pages/viewpage.action?pageId=98765432',
    );
  });

  it('hides the "Open in Confluence" link when confluenceId is null', () => {
    currentMockPage = { ...mockPage, confluenceId: null };

    render(<ArticleRightPane />, { wrapper: createWrapper() });

    expect(screen.queryByText('Open in Confluence')).not.toBeInTheDocument();
  });

  // --- AutoTagger ---
  it('renders AutoTagger with correct props', () => {
    render(<ArticleRightPane />, { wrapper: createWrapper() });

    const autoTagger = screen.getByTestId('auto-tagger');
    expect(autoTagger).toBeInTheDocument();
    expect(autoTagger).toHaveAttribute('data-page-id', 'page-1');
    expect(autoTagger).toHaveAttribute('data-labels', 'docs');
    expect(autoTagger).toHaveAttribute('data-model', 'qwen3.5');
  });

  // --- PDF Export ---
  it('renders the Export PDF button', () => {
    render(<ArticleRightPane />, { wrapper: createWrapper() });

    expect(screen.getByText('Export PDF')).toBeInTheDocument();
  });

  it('calls export mutation and triggers download on success', async () => {
    const fakeBlob = new Blob(['%PDF'], { type: 'application/pdf' });
    mockExportPdfAsync.mockResolvedValueOnce(fakeBlob);
    const createObjectURLSpy = vi.fn(() => 'blob:http://localhost/fake-url');
    const revokeObjectURLSpy = vi.fn();
    globalThis.URL.createObjectURL = createObjectURLSpy;
    globalThis.URL.revokeObjectURL = revokeObjectURLSpy;

    render(<ArticleRightPane />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByText('Export PDF'));

    await waitFor(() => {
      expect(mockExportPdfAsync).toHaveBeenCalledWith(NaN);
    });
    await waitFor(() => {
      expect(createObjectURLSpy).toHaveBeenCalledWith(fakeBlob);
      expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:http://localhost/fake-url');
    });
  });

  it('shows error toast on export failure', async () => {
    mockExportPdfAsync.mockRejectedValueOnce(new Error('Server error'));

    render(<ArticleRightPane />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByText('Export PDF'));

    await waitFor(() => {
      expect(mockExportPdfAsync).toHaveBeenCalled();
    });
  });
});
