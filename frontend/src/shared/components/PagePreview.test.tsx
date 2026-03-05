import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LazyMotion, domAnimation } from 'framer-motion';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PagePreview } from './PagePreview';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <LazyMotion features={domAnimation}>
            {children}
          </LazyMotion>
        </MemoryRouter>
      </QueryClientProvider>
    );
  };
}

const mockPage = {
  id: 'page-123',
  spaceKey: 'DEV',
  title: 'Test Page Title',
  bodyHtml: '<p>Page content</p>',
  bodyText: 'This is a test page with preview content that should be displayed in the hover card.',
  version: 1,
  parentId: null,
  labels: [],
  author: 'testuser',
  lastModifiedAt: '2026-03-01T00:00:00Z',
  lastSynced: '2026-03-01T00:00:00Z',
  embeddingDirty: false,
};

describe('PagePreview', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockPage), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders children', () => {
    render(
      <PagePreview pageId="page-123">
        <a href="/pages/page-123">Link Text</a>
      </PagePreview>,
      { wrapper: createWrapper() },
    );
    expect(screen.getByText('Link Text')).toBeInTheDocument();
  });

  it('does not show preview card initially', () => {
    render(
      <PagePreview pageId="page-123">
        <a href="/pages/page-123">Link Text</a>
      </PagePreview>,
      { wrapper: createWrapper() },
    );
    expect(screen.queryByTestId('page-preview-card')).not.toBeInTheDocument();
  });

  it('shows preview card on hover after delay', async () => {
    render(
      <PagePreview pageId="page-123">
        <a href="/pages/page-123">Link Text</a>
      </PagePreview>,
      { wrapper: createWrapper() },
    );

    const trigger = screen.getByText('Link Text').closest('span')!;
    fireEvent.mouseEnter(trigger);

    // Wait for hover delay (300ms) + fetch
    await waitFor(
      () => {
        expect(screen.getByTestId('page-preview-card')).toBeInTheDocument();
      },
      { timeout: 2000 },
    );
  });

  it('hides preview card on mouse leave', async () => {
    render(
      <PagePreview pageId="page-123">
        <a href="/pages/page-123">Link Text</a>
      </PagePreview>,
      { wrapper: createWrapper() },
    );

    const trigger = screen.getByText('Link Text').closest('span')!;
    fireEvent.mouseEnter(trigger);

    await waitFor(
      () => {
        expect(screen.getByTestId('page-preview-card')).toBeInTheDocument();
      },
      { timeout: 2000 },
    );

    fireEvent.mouseLeave(trigger);

    await waitFor(() => {
      expect(screen.queryByTestId('page-preview-card')).not.toBeInTheDocument();
    });
  });

  it('displays page title in preview', async () => {
    render(
      <PagePreview pageId="page-123">
        <a href="/pages/page-123">Link Text</a>
      </PagePreview>,
      { wrapper: createWrapper() },
    );

    const trigger = screen.getByText('Link Text').closest('span')!;
    fireEvent.mouseEnter(trigger);

    await waitFor(
      () => {
        expect(screen.getByText('Test Page Title')).toBeInTheDocument();
      },
      { timeout: 2000 },
    );
  });

  it('displays space key in preview', async () => {
    render(
      <PagePreview pageId="page-123">
        <a href="/pages/page-123">Link Text</a>
      </PagePreview>,
      { wrapper: createWrapper() },
    );

    const trigger = screen.getByText('Link Text').closest('span')!;
    fireEvent.mouseEnter(trigger);

    await waitFor(
      () => {
        expect(screen.getByText('DEV')).toBeInTheDocument();
      },
      { timeout: 2000 },
    );
  });

  it('does not fetch when not hovering', () => {
    render(
      <PagePreview pageId="page-123">
        <a href="/pages/page-123">Link Text</a>
      </PagePreview>,
      { wrapper: createWrapper() },
    );

    expect(screen.queryByTestId('page-preview-card')).not.toBeInTheDocument();
  });

  it('cancels hover timeout on quick mouse leave', async () => {
    render(
      <PagePreview pageId="page-123">
        <a href="/pages/page-123">Link Text</a>
      </PagePreview>,
      { wrapper: createWrapper() },
    );

    const trigger = screen.getByText('Link Text').closest('span')!;
    fireEvent.mouseEnter(trigger);

    // Leave immediately before the 300ms delay
    fireEvent.mouseLeave(trigger);

    // Wait a bit and ensure preview never showed
    await new Promise((r) => setTimeout(r, 500));
    expect(screen.queryByTestId('page-preview-card')).not.toBeInTheDocument();
  });
});
