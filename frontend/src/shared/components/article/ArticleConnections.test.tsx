import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
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
      <MemoryRouter>
        <ArticleConnections pageId={pageId} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function emitIntersection(isIntersecting = true) {
  for (const observer of observers) {
    observer([{ isIntersecting } as IntersectionObserverEntry]);
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

  it('opens as a two-column disclosure and collapses from the Connections heading', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = requestUrl(input);
      if (url === '/api/pages/12/connections' && (init?.method ?? 'GET') === 'GET') return json(connections);
      return json({ recorded: true });
    });

    renderPanel();
    expect(await screen.findByRole('heading', { name: 'Linked articles' })).toBeInTheDocument();

    const groups = screen.getByTestId('article-connections-groups');
    expect(groups.className).toMatch(/sm:grid-cols-2/);

    const details = screen.getByRole('heading', { name: 'Connections' }).closest('details');
    expect(details).toHaveAttribute('open');

    fireEvent.click(screen.getByRole('link', { name: 'Explore connections' }));
    expect(details).toHaveAttribute('open');

    fireEvent.click(screen.getByRole('heading', { name: 'Connections' }));
    expect(details).not.toHaveAttribute('open');
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

  it('does not count an offscreen result when only its loading state was visible', async () => {
    const response = Promise.withResolvers<Response>();
    const events: unknown[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (requestUrl(input) === '/api/pages/12/connections') return response.promise;
      events.push(JSON.parse(String(init?.body)));
      return json({ recorded: true });
    });
    renderPanel();
    expect(screen.getByText('Loading connections…')).toBeInTheDocument();
    act(() => {
      emitIntersection(true);
      emitIntersection(false);
    });
    response.resolve(json(connections));
    await screen.findByRole('link', { name: 'Related article' });
    expect(events).toEqual([]);
    act(() => emitIntersection(true));
    await waitFor(() => expect(events).toEqual([
      expect.objectContaining({ event: 'impression' }),
    ]));
  });

  it('hands keyboard focus to the surviving heading after a successful retry', async () => {
    let reads = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      reads += 1;
      return reads === 1
        ? json({ message: 'Unavailable' }, 503)
        : json({ linked: [], section: [], related: [] });
    });
    renderPanel();
    const retry = await screen.findByRole('button', { name: 'Retry' });
    retry.focus();
    fireEvent.click(retry);
    await screen.findByText('No connections found for this article.');
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Connections' })).toHaveFocus());
  });

  it.each([403, 404])('keeps %s-denied results revoked through failed retries and a remount until an authorized read succeeds', async (status) => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let connectionsResponse = Promise.resolve(json(connections));
    const events: Array<{ event: string }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = requestUrl(input);
      if (url === '/api/pages/12/connections' && (init?.method ?? 'GET') === 'GET') {
        return connectionsResponse;
      }
      if (url === '/api/pages/12/connections/events' && init?.method === 'POST') {
        events.push(JSON.parse(String(init.body)));
      }
      return json({ recorded: true });
    });
    const mountPanel = () => render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/pages/12']}>
          <Routes>
            <Route path="/pages/12" element={<ArticleConnections pageId="12" />} />
            <Route path="/pages/10" element={<h1>Fresh destination article</h1>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const expectRevokedResultsAbsent = () => {
      expect(screen.queryByRole('list')).not.toBeInTheDocument();
      expect(screen.getAllByRole('link')).toEqual([
        screen.getByRole('link', { name: 'Explore connections' }),
      ]);
      expect(screen.queryByText(/Incoming and hierarchy article|Parent article|Related article/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Links to this article|Parent page|Shares labels:/)).not.toBeInTheDocument();
      expect(screen.queryByText('No connections found for this article.')).not.toBeInTheDocument();
      expect(screen.queryByText(/Showing the last loaded results/)).not.toBeInTheDocument();
      expect(screen.getByText("Couldn't load connections.")).toBeInTheDocument();
    };

    const firstVisit = mountPanel();
    await screen.findByRole('link', { name: 'Related article' });
    act(() => emitIntersection(true));
    await waitFor(() => expect(events.filter((event) => event.event === 'impression')).toHaveLength(1));

    connectionsResponse = Promise.resolve(json({ message: 'Unavailable' }, status));
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await screen.findByRole('button', { name: 'Retry' });
    expectRevokedResultsAbsent();

    const unavailable = Promise.withResolvers<Response>();
    connectionsResponse = unavailable.promise;
    const retry = screen.getByRole('button', { name: 'Retry' });
    retry.focus();
    fireEvent.click(retry);
    expect(screen.getByRole('button', { name: 'Retrying…' })).toHaveFocus();
    expect(retry).toHaveAttribute('aria-disabled', 'true');
    expect(retry).not.toBeDisabled();
    expectRevokedResultsAbsent();
    unavailable.resolve(json({ message: 'Unavailable' }, 503));
    await screen.findByRole('button', { name: 'Retry' });
    expectRevokedResultsAbsent();
    expect(retry).toHaveFocus();

    const offline = Promise.withResolvers<Response>();
    connectionsResponse = offline.promise;
    fireEvent.click(retry);
    expectRevokedResultsAbsent();
    offline.reject(new TypeError('Failed to fetch'));
    await screen.findByRole('button', { name: 'Retry' });
    expectRevokedResultsAbsent();
    expect(retry).toHaveFocus();

    firstVisit.unmount();
    observers.length = 0;
    const recovered = Promise.withResolvers<Response>();
    connectionsResponse = recovered.promise;
    mountPanel();
    expectRevokedResultsAbsent();
    act(() => emitIntersection(true));
    expect(events.filter((event) => event.event === 'impression')).toHaveLength(1);

    recovered.resolve(json({
      linked: [{
        pageId: '10',
        title: 'Fresh authorized connection',
        reasons: [{ type: 'explicit_link', direction: 'outgoing' }],
      }],
      section: [],
      related: [],
    }));
    const freshTarget = await screen.findByRole('link', { name: 'Fresh authorized connection' });
    expect(screen.getByText('Linked from this article')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Related article' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Shares labels:/)).not.toBeInTheDocument();
    expect(screen.queryByText("Couldn't load connections.")).not.toBeInTheDocument();
    await waitFor(() => expect(events.filter((event) => event.event === 'impression')).toHaveLength(2));
    fireEvent.click(freshTarget);
    expect(await screen.findByRole('heading', { name: 'Fresh destination article' })).toBeInTheDocument();
  });

  it('keeps authorized cached results with a stale warning after a non-permission failure', async () => {
    let connectionsRead = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (requestUrl(input) === '/api/pages/12/connections') {
        connectionsRead += 1;
        return connectionsRead === 1 ? json(connections) : json({ message: 'Unavailable' }, 503);
      }
      return json({ recorded: true });
    });
    renderPanel();
    await screen.findByRole('link', { name: 'Related article' });
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await screen.findByText("Couldn't refresh connections. Showing the last loaded results.");
    expect(screen.getByRole('link', { name: 'Related article' })).toHaveAttribute('href', '/pages/9');
    expect(screen.getByText('Similar content · 0.88 · Shares labels: architecture, search')).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load connections.")).not.toBeInTheDocument();
  });
});
