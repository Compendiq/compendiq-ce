/**
 * Protected-write entry points on a frozen article (#277).
 *
 * The article route has more than one way into a content change, and Edit is
 * only the obvious one. These cases cover the paths that are reachable from
 * READ mode — the draw.io overlay, which `DrawioEditor` offers no read-only
 * form of, and the empty-article "Add content" call to action — plus the race
 * the whole design turns on: a freeze that lands while a person already has
 * the diagram open.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { LazyMotion, domAnimation } from 'framer-motion';
import { toast } from 'sonner';
import { PageViewPage } from './PageViewPage';
import { useAuthStore } from '../../stores/auth-store';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const DIAGRAM_HTML =
  '<p>Body</p><div class="confluence-drawio" data-diagram-name="flow"><img alt="flow" src="/api/local-attachments/42/flow.png" /></div>';

const basePage = {
  id: '42',
  confluenceId: null,
  title: 'Frozen article',
  spaceKey: null,
  pageType: 'page',
  bodyHtml: DIAGRAM_HTML,
  bodyText: 'Body',
  version: 3,
  parentId: null,
  labels: [],
  author: 'me',
  lastModifiedAt: '2026-09-20T12:00:00.000Z',
  lastSynced: '2026-09-20T12:00:00.000Z',
  hasChildren: false,
  descendantCount: 0,
  embeddingDirty: false,
  embeddingStatus: 'embedded',
  embeddedAt: '2026-09-20T12:00:00.000Z',
  embeddingError: null,
  qualityScore: null,
  qualityStatus: null,
  qualityCompleteness: null,
  qualityClarity: null,
  qualityStructure: null,
  qualityAccuracy: null,
  qualityReadability: null,
  qualitySummary: null,
  qualityAnalyzedAt: null,
  qualityError: null,
  summaryHtml: null,
  summaryStatus: undefined,
  summaryGeneratedAt: null,
  summaryModel: null,
  summaryError: null,
  source: 'standalone',
  visibility: 'private',
  createdByUserId: 'self',
  contentRevision: '5',
  lifecycleRevision: '1',
  isFrozen: false,
  canMutateContent: true,
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let currentPage: typeof basePage;
let fetchMock: Mock;
let client: QueryClient;

function renderPage() {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/pages/42']}>
        <LazyMotion features={domAnimation}>
          <Routes>
            <Route path="/pages/:id" element={<PageViewPage />} />
          </Routes>
        </LazyMotion>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  currentPage = { ...basePage };
  Element.prototype.scrollTo = vi.fn();
  localStorage.clear();
  useAuthStore.getState().setAuth('jwt-test', { id: 'self', username: 'me', role: 'user' });

  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('/api/pages/42?') || url === '/api/pages/42') return json(currentPage);
    if (url === '/api/collab/config') return json({ enabled: false });
    if (url.startsWith('/api/local-attachments/')) {
      return new Response(new Blob(['png']), { status: 200 });
    }
    if (url === '/api/settings') return json({
      inlineCompletionEnabled: false,
      clientInferenceEnabled: false,
      clientInferenceAdminEnabled: false,
      clientSpellcheckEnabled: false,
    });
    if (url === '/api/settings/drawio-url') return json({ drawioEmbedUrl: 'https://draw.example.com' });
    if (url === '/api/pages/filters') return json({ authors: [], labels: [] });
    if (url === '/api/pages/pinned') return json({ items: [], total: 0 });
    if (url === '/api/pages/42/connections') return json({ linked: [], section: [], related: [] });
    if (url.startsWith('/api/llm/usecase-default')) return json({ message: 'Not configured' }, 404);
    if (url.startsWith('/api/pages/42/presence')) return new Response(null, { status: 204 });
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('frozen article write guards', () => {
  it('offers no diagram editing affordance on a frozen article', async () => {
    currentPage = { ...basePage, isFrozen: true, frozenVersion: 3, canMutateContent: false };
    renderPage();

    await screen.findByTestId('article-frozen-status');
    // Two affordances, both withheld. `ArticleViewer` injects its overlay
    // button only when the page supplies a callback, and the diagram node
    // view offers Edit only while its editor is editable — read mode's
    // never is. `DrawioEditor` has no read-only form, so neither may open
    // one: the rendered image is the frozen view.
    await screen.findByTestId('drawio-diagram-node');
    await waitFor(() => {
      expect(document.querySelector('[data-testid="drawio-edit-btn"]')).toBeNull();
    });
    expect(screen.queryByRole('button', { name: /edit diagram/i })).toBeNull();
    expect(screen.queryByTestId('edit-page-btn')).toBeNull();
  });

  it('refuses the empty-article call to action on a frozen article', async () => {
    currentPage = {
      ...basePage,
      bodyHtml: '',
      isFrozen: true,
      frozenVersion: 3,
      canMutateContent: false,
    };
    renderPage();

    fireEvent.click(await screen.findByTestId('add-content-btn'));

    expect(toast.info).toHaveBeenCalledWith(expect.stringMatching(/frozen/i));
    expect(screen.queryByTestId('edit-title-input')).toBeNull();
  });
});
