import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { ArticleReadToolbar } from './ArticleReadToolbar';
import type { PageDetail } from '../../hooks/use-pages';

const mockNavigate = vi.fn();
const mockExportPdfAsync = vi.fn();
const mockResyncMutate = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock('../../hooks/use-standalone', () => ({
  useExportPdf: () => ({ mutateAsync: mockExportPdfAsync, isPending: false }),
}));

vi.mock('../../hooks/use-pages', async () => {
  const actual = await vi.importActual('../../hooks/use-pages');
  return {
    ...actual,
    useResyncPage: () => ({ mutate: mockResyncMutate, isPending: false }),
  };
});

vi.mock('../../hooks/use-permission', () => ({
  usePermission: () => ({ allowed: true }),
}));

vi.mock('../../../features/pages/VersionHistory', () => ({
  VersionHistory: ({
    restoreAllowed,
    renderTrigger,
  }: {
    restoreAllowed: boolean;
    renderTrigger: (open: boolean) => React.ReactNode;
  }) => (
    <div data-testid="version-history-mock" data-restore-allowed={String(restoreAllowed)}>
      {renderTrigger(false)}
    </div>
  ),
}));

vi.mock('../../../features/pages/AutoTagger', () => ({
  AutoTagger: () => <div data-testid="auto-tagger-mount" />,
}));

vi.mock('../../../features/pages/RelocateDialog', () => ({
  RelocateDialog: ({ pageTitle }: { pageTitle: string }) => (
    <div role="dialog" data-testid="relocate-dialog-mock">
      Move {pageTitle}
    </div>
  ),
}));

const basePage: PageDetail = {
  id: '1',
  confluenceId: '98765432',
  title: 'Engineering handbook',
  spaceKey: 'ENG',
  source: 'confluence',
  pageType: 'page',
  visibility: 'shared',
  version: 7,
  parentId: null,
  labels: ['engineering', 'docs'],
  author: 'Reviewer',
  bodyHtml: '<h2>Introduction</h2>',
  bodyText: 'Introduction',
  hasChildren: false,
  lastModifiedAt: '2026-09-01T12:00:00Z',
  lastSynced: '2026-09-01T12:00:00Z',
  embeddingDirty: false,
  embeddingStatus: 'embedded',
  embeddedAt: '2026-09-01T12:00:00Z',
  embeddingError: null,
  qualityScore: 85,
  qualityStatus: 'analyzed',
  qualityError: null,
  verifiedAt: null,
  aiPolicy: 'all',
  isFrozen: false,
};

function renderToolbar(
  pageOverrides: Partial<PageDetail> = {},
  handlers: {
    onStartEditing?: () => void;
    onPinToggle?: () => void;
    onDelete?: () => void;
    isPinned?: boolean;
    confluenceUrl?: string | null;
  } = {},
) {
  const page = { ...basePage, ...pageOverrides };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: (
          <ArticleReadToolbar
            page={page}
            confluenceUrl={handlers.confluenceUrl ?? 'https://confluence.example.com'}
            mergedViewers={[]}
            saveInFlight={false}
            onStartEditing={handlers.onStartEditing ?? vi.fn()}
            isPinned={handlers.isPinned ?? false}
            onPinToggle={handlers.onPinToggle ?? vi.fn()}
            onDelete={handlers.onDelete ?? vi.fn()}
          />
        ),
      },
    ],
    { initialEntries: ['/'] },
  );
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

async function openMoreMenu() {
  const trigger = screen.getByTestId('article-read-more-btn');
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(trigger);
  return screen.findByRole('menu');
}

beforeEach(() => {
  mockNavigate.mockReset();
  mockExportPdfAsync.mockReset();
  mockResyncMutate.mockReset();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify({ model: 'tagger' }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ArticleReadToolbar', () => {
  it('renders labels, AI policy chip, direct Pin/History/Confluence buttons, and Edit', () => {
    const onPinToggle = vi.fn();
    const onStartEditing = vi.fn();
    renderToolbar({}, { onPinToggle, onStartEditing });

    expect(screen.getByTestId('article-tags-readonly')).toHaveTextContent('engineering');
    expect(screen.getByTestId('read-toolbar-pin-btn')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('read-toolbar-history-btn')).toBeInTheDocument();
    expect(screen.getByTestId('read-toolbar-confluence-link')).toHaveAttribute(
      'href',
      'https://confluence.example.com/pages/viewpage.action?pageId=98765432',
    );

    fireEvent.click(screen.getByTestId('read-toolbar-pin-btn'));
    expect(onPinToggle).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('edit-page-btn'));
    expect(onStartEditing).toHaveBeenCalledTimes(1);
  });

  it('offers graph, PDF export, auto-tag, resync, relocate, and delete inside the More menu for an editable page', async () => {
    const onDelete = vi.fn();
    renderToolbar({}, { onDelete });

    await openMoreMenu();
    expect(screen.getByTestId('show-in-graph-btn')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Export PDF' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Auto-tag' })).toBeInTheDocument();
    expect(screen.getByTestId('article-resync-btn')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Delete in Confluence…' })).toBeInTheDocument();
    expect(screen.getByTestId('relocate-local-btn')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('show-in-graph-btn'));
    expect(mockNavigate).toHaveBeenCalledWith('/graph?focus=1');
  });

  it('offers Move to trash and Move to Confluence for a standalone page', async () => {
    const onDelete = vi.fn();
    renderToolbar({ source: 'standalone', confluenceId: null }, { onDelete });

    expect(screen.queryByTestId('read-toolbar-confluence-link')).not.toBeInTheDocument();
    await openMoreMenu();

    expect(screen.getByTestId('relocate-btn')).toHaveTextContent('Move to Confluence…');
    expect(screen.queryByTestId('article-resync-btn')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to trash' }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('prompts for confirmation before pulling latest from Confluence', async () => {
    renderToolbar();
    await openMoreMenu();

    fireEvent.click(screen.getByTestId('article-resync-btn'));
    expect(await screen.findByTestId('confirm-dialog')).toHaveTextContent(
      'Pull the latest version from Confluence?',
    );
    expect(mockResyncMutate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    expect(mockResyncMutate).toHaveBeenCalledWith('1', expect.any(Object));
  });

  it('triggers PDF download from Export PDF', async () => {
    const fakeBlob = new Blob(['%PDF'], { type: 'application/pdf' });
    mockExportPdfAsync.mockResolvedValueOnce(fakeBlob);
    const createObjectURLSpy = vi.fn(() => 'blob:http://localhost/fake-url');
    const revokeObjectURLSpy = vi.fn();
    globalThis.URL.createObjectURL = createObjectURLSpy;
    globalThis.URL.revokeObjectURL = revokeObjectURLSpy;

    renderToolbar();
    await openMoreMenu();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Export PDF' }));
    await waitFor(() => expect(mockExportPdfAsync).toHaveBeenCalledWith(1));
    await waitFor(() => expect(createObjectURLSpy).toHaveBeenCalledWith(fakeBlob));
  });

  it('hides write actions and disables history restore when the article is frozen (#277)', async () => {
    renderToolbar({ source: 'standalone', confluenceId: null, isFrozen: true });

    expect(screen.getByTestId('article-frozen-status')).toBeInTheDocument();
    expect(screen.queryByTestId('edit-page-btn')).not.toBeInTheDocument();
    expect(screen.getByTestId('version-history-mock')).toHaveAttribute('data-restore-allowed', 'false');

    await openMoreMenu();
    expect(screen.getByTestId('show-in-graph-btn')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Export PDF' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Auto-tag' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('relocate-btn')).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Move to trash' })).not.toBeInTheDocument();
  });
});
