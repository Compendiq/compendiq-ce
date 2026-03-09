import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LazyMotion, domAnimation } from 'framer-motion';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { VersionHistory } from './VersionHistory';
import { useAuthStore } from '../../stores/auth-store';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
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

function mockVersionsResponse() {
  return new Response(
    JSON.stringify({
      versions: [
        {
          versionNumber: 3,
          title: 'Page v3',
          syncedAt: '2026-03-05T10:00:00Z',
          isCurrent: true,
        },
        {
          versionNumber: 2,
          title: 'Page v2',
          syncedAt: '2026-03-04T10:00:00Z',
          isCurrent: false,
        },
        {
          versionNumber: 1,
          title: 'Page v1',
          syncedAt: '2026-03-03T10:00:00Z',
          isCurrent: false,
        },
      ],
      pageId: 'page-1',
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
}

describe('VersionHistory', () => {
  beforeEach(() => {
    useAuthStore.getState().setAuth('test-token', {
      id: '1',
      username: 'testuser',
      role: 'user',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useAuthStore.getState().clearAuth();
  });

  it('renders the History toolbar button', () => {
    render(
      <VersionHistory pageId="page-1" model="qwen3.5" />,
      { wrapper: createWrapper() },
    );

    expect(screen.getByText('History')).toBeInTheDocument();
    expect(screen.getByTitle('Version history')).toBeInTheDocument();
  });

  it('opens dialog and shows versions when clicked', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockVersionsResponse());

    render(
      <VersionHistory pageId="page-1" model="qwen3.5" />,
      { wrapper: createWrapper() },
    );

    // Click the toolbar button to open dialog
    fireEvent.click(screen.getByText('History'));

    // Dialog title should appear
    expect(screen.getByText('Version History')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText('v3')).toBeInTheDocument();
      expect(screen.getByText('v2')).toBeInTheDocument();
      expect(screen.getByText('v1')).toBeInTheDocument();
    });
  });

  it('shows Current badge for current version', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockVersionsResponse());

    render(
      <VersionHistory pageId="page-1" model="qwen3.5" />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByText('History'));

    await waitFor(() => {
      expect(screen.getByText('Current')).toBeInTheDocument();
    });
  });

  it('shows version count badge in dialog', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockVersionsResponse());

    render(
      <VersionHistory pageId="page-1" model="qwen3.5" />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByText('History'));

    await waitFor(() => {
      expect(screen.getByText('3')).toBeInTheDocument();
    });
  });

  it('shows empty state when no versions', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ versions: [], pageId: 'page-1' }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );

    render(
      <VersionHistory pageId="page-1" model="qwen3.5" />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByText('History'));

    await waitFor(() => {
      expect(screen.getByText(/No version history available/)).toBeInTheDocument();
    });
  });

  it('shows loading state in dialog', async () => {
    vi.spyOn(globalThis, 'fetch').mockReturnValue(
      new Promise(() => {}),
    );

    render(
      <VersionHistory pageId="page-1" model="qwen3.5" />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByText('History'));

    await waitFor(() => {
      expect(screen.getByText('Loading versions...')).toBeInTheDocument();
    });
  });

  it('closes dialog via close button', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ versions: [], pageId: 'page-1' }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );

    render(
      <VersionHistory pageId="page-1" model="qwen3.5" />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByText('History'));
    expect(screen.getByText('Version History')).toBeInTheDocument();

    // Click the close button
    fireEvent.click(screen.getByLabelText('Close'));

    await waitFor(() => {
      expect(screen.queryByText('Version History')).not.toBeInTheDocument();
    });
  });
});
