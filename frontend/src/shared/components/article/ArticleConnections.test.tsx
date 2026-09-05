import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ArticleConnections } from './ArticleConnections';

const observers: Array<(entries: IntersectionObserverEntry[]) => void> = [];
const originalIntersectionObserver = globalThis.IntersectionObserver;

class TestIntersectionObserver {
  constructor(callback: IntersectionObserverCallback) {
    observers.push(callback);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  readonly root = null;
  readonly rootMargin = '';
  readonly thresholds = [];
}

function renderPanel(pageId = '12') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ArticleConnections pageId={pageId} />
    </QueryClientProvider>,
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function emitIntersection() {
  for (const observer of observers) {
    observer([{ isIntersecting: true } as IntersectionObserverEntry]);
  }
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
}

const connections = {
  linked: [
    {
      pageId: '7',
      title: 'Incoming and hierarchy article',
      reasons: [
        { type: 'explicit_link', direction: 'incoming' },
        { type: 'parent_child', direction: 'child' },
      ],
    },
  ],
  section: [
    {
      pageId: '8',
      title: 'Parent article',
      reasons: [{ type: 'parent_child', direction: 'parent' }],
    },
  ],
  related: [
    {
      pageId: '9',
      title: 'Related article',
      reasons: [
        { type: 'embedding_similarity', score: 0.876 },
        { type: 'label_overlap', labels: ['architecture', 'search'], score: 0.5 },
      ],
    },
  ],
};

  beforeEach(() => {
    globalThis.IntersectionObserver = TestIntersectionObserver as unknown as typeof IntersectionObserver;
  });

describe('ArticleConnections', () => {
  afterEach(() => {
    observers.length = 0;
    focusManager.setFocused(true);
    globalThis.IntersectionObserver = originalIntersectionObserver;
    vi.restoreAllMocks();
  });

  it('renders all populated groups from GET and emits one intersection-gated impression plus navigation telemetry', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = requestUrl(input);
      if (url === '/api/pages/12/connections' && (init?.method ?? 'GET') === 'GET') return json(connections);
      if (url === '/api/pages/12/connections/events' && init?.method === 'POST') return json({ recorded: true });
      return json({ message: 'Not found' }, 404);
    });

    renderPanel();

    expect(await screen.findByRole('heading', { name: 'Linked articles' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'In this section' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Related articles' })).toBeInTheDocument();
    expect(screen.getByText('Links to this article · Child of this page')).toBeInTheDocument();
    expect(screen.getByText('Parent page')).toBeInTheDocument();
    expect(screen.getByText('Similar content · 0.88 · Shares labels: architecture, search')).toBeInTheDocument();

    const target = screen.getByRole('link', { name: 'Related article' });
    expect(target).toHaveAttribute('href', '/pages/9');
    emitIntersection();
    emitIntersection();
    fireEvent.click(target);
    fireEvent.click(screen.getByRole('link', { name: 'Explore connections' }));

    await waitFor(() => {
      const eventBodies = fetchSpy.mock.calls
        .filter(([input]) => requestUrl(input) === '/api/pages/12/connections/events')
        .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
      expect(eventBodies).toEqual(expect.arrayContaining([
        expect.objectContaining({ event: 'impression' }),
        expect.objectContaining({ event: 'connection_click', targetPageId: '9', group: 'related' }),
        expect.objectContaining({ event: 'graph_launch' }),
      ]));
      expect(eventBodies.filter((event) => event.event === 'impression')).toHaveLength(1);
    });
  });

  it('distinguishes an empty response from a failed request and retries through the real endpoint', async () => {
    let attempts = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = requestUrl(input);
      if (url === '/api/pages/12/connections' && (init?.method ?? 'GET') === 'GET') {
        attempts += 1;
        return attempts === 1 ? json({ message: 'Unavailable' }, 503) : json({ linked: [], section: [], related: [] });
      }
      return json({ recorded: true });
    });

    renderPanel();
    expect(await screen.findByText("Couldn't load connections.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No connections found for this article.')).toBeInTheDocument();
  });

  it('suppresses cached titles after permission revocation', async () => {
    let connectionsRead = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = requestUrl(input);
      if (url === '/api/pages/12/connections' && (init?.method ?? 'GET') === 'GET') {
        connectionsRead += 1;
        return connectionsRead === 1 ? json(connections) : json({ message: 'Forbidden' }, 403);
      }
      if (url === '/api/auth/refresh' && init?.method === 'POST') return json({ message: 'Forbidden' }, 403);
      return json({ recorded: true });
    });

    renderPanel();
    expect(await screen.findByRole('link', { name: 'Related article' })).toBeInTheDocument();

    focusManager.setFocused(false);
    focusManager.setFocused(true);

    await waitFor(() => {
      expect(screen.queryByRole('link', { name: 'Related article' })).not.toBeInTheDocument();
      expect(screen.getByText("Couldn't load connections.")).toBeInTheDocument();
    });
  });
});
