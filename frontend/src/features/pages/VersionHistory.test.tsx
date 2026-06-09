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
          editedAt: '2026-03-05T10:00:00Z',
          syncedAt: '2026-03-05T10:00:00Z',
          author: null,
          message: null,
          isCurrent: true,
        },
        {
          versionNumber: 2,
          title: 'Page v2',
          editedAt: '2026-03-04T10:00:00Z',
          syncedAt: '2026-03-04T10:00:00Z',
          author: 'alice',
          message: 'Updated intro',
          isCurrent: false,
        },
        {
          versionNumber: 1,
          title: 'Page v1',
          editedAt: null,
          syncedAt: '2026-03-03T10:00:00Z',
          author: null,
          message: null,
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

  it('renders a custom trigger via renderTrigger and reflects open state', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockVersionsResponse());

    render(
      <VersionHistory
        pageId="page-1"
        model="qwen3.5"
        renderTrigger={(open) => (
          <button>{open ? 'History open' : 'Open history'}</button>
        )}
      />,
      { wrapper: createWrapper() },
    );

    // Default trigger text must NOT be present when a custom trigger is supplied
    expect(screen.queryByTitle('Version history')).not.toBeInTheDocument();
    const trigger = screen.getByText('Open history');
    expect(trigger).toBeInTheDocument();

    fireEvent.click(trigger);
    await waitFor(() => {
      expect(screen.getByText('History open')).toBeInTheDocument();
    });
  });

  it('shows a Restore action on older versions but not the current one', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockVersionsResponse());

    render(
      <VersionHistory pageId="page-1" model="qwen3.5" />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByText('History'));

    await waitFor(() => {
      expect(screen.getByText('v3')).toBeInTheDocument();
    });

    // 3 versions; current (v3) has no restore → 2 restore buttons.
    const restoreButtons = screen.getAllByTitle('Restore this version');
    expect(restoreButtons).toHaveLength(2);
  });

  it('restores a version: confirms, POSTs to the restore endpoint with the current version guard', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/restore')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: 1,
              title: 'Page v2',
              version: 4,
              restoredFrom: 2,
              source: 'confluence',
              pushedToConfluence: true,
            }),
            { headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      return Promise.resolve(mockVersionsResponse());
    });

    render(
      <VersionHistory pageId="page-1" model="qwen3.5" />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByText('History'));
    await waitFor(() => expect(screen.getByText('v2')).toBeInTheDocument());

    // Restore buttons are ordered top→bottom: v2 then v1 (v3 is current).
    const restoreButtons = screen.getAllByTitle('Restore this version');
    fireEvent.click(restoreButtons[0]!);

    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('Restore v2?'));

    await waitFor(() => {
      const restoreCall = fetchSpy.mock.calls.find(
        ([input]) => (typeof input === 'string' ? input : String(input)).includes('/restore'),
      );
      expect(restoreCall).toBeDefined();
      const [url, options] = restoreCall as [string, RequestInit];
      expect(url).toContain('/pages/page-1/versions/2/restore');
      expect(options.method).toBe('POST');
      // Optimistic guard: the current live version (3) is sent.
      expect(JSON.parse(options.body as string)).toEqual({ version: 3 });
    });
  });

  it('does not POST when the restore confirm is cancelled', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockVersionsResponse());

    render(
      <VersionHistory pageId="page-1" model="qwen3.5" />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByText('History'));
    await waitFor(() => expect(screen.getByText('v2')).toBeInTheDocument());

    fireEvent.click(screen.getAllByTitle('Restore this version')[0]!);

    const restoreCall = fetchSpy.mock.calls.find(
      ([input]) => (typeof input === 'string' ? input : String(input)).includes('/restore'),
    );
    expect(restoreCall).toBeUndefined();
  });

  it('requests a semantic diff without a model prop (server resolves the use-case)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/semantic-diff')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ diff: 'Section A changed.', v1: 1, v2: 2, pageId: 'page-1' }),
            { headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      return Promise.resolve(mockVersionsResponse());
    });

    // No `model` prop — matches how ArticleRightPane renders VersionHistory.
    render(
      <VersionHistory pageId="page-1" />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByText('History'));
    await waitFor(() => expect(screen.getByText('v2')).toBeInTheDocument());

    // Sparkles = AI semantic diff (present on non-oldest versions).
    fireEvent.click(screen.getAllByTitle('AI semantic diff with previous version')[0]!);

    await waitFor(() => {
      const diffCall = fetchSpy.mock.calls.find(
        ([input]) => (typeof input === 'string' ? input : String(input)).includes('/semantic-diff'),
      );
      expect(diffCall).toBeDefined();
      const [, options] = diffCall as [string, RequestInit];
      expect(options.method).toBe('POST');
      const body = JSON.parse(options.body as string);
      // v1/v2 are sent; model is undefined (omitted from JSON) so the backend
      // resolves the chat use-case instead of forcing a hardcoded model.
      expect(body.v1).toBeGreaterThan(0);
      expect(body.v2).toBeGreaterThan(0);
      expect(body.model).toBeUndefined();
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

  it('shows author name for versions with Confluence edit metadata (#722)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockVersionsResponse());

    render(
      <VersionHistory pageId="page-1" model="qwen3.5" />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByText('History'));

    await waitFor(() => {
      // v2 has author 'alice' in the mock
      expect(screen.getByText('alice')).toBeInTheDocument();
    });
  });

  it('shows commit message for versions with Confluence edit metadata (#722)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockVersionsResponse());

    render(
      <VersionHistory pageId="page-1" model="qwen3.5" />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByText('History'));

    await waitFor(() => {
      // v2 has message 'Updated intro' in the mock
      expect(screen.getByText(/Updated intro/)).toBeInTheDocument();
    });
  });

  it('shows Synced prefix for rows without editedAt (#724)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockVersionsResponse());

    render(
      <VersionHistory pageId="page-1" model="qwen3.5" />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByText('History'));

    await waitFor(() => {
      // v1 has editedAt:null, syncedAt:'2026-03-03T10:00:00Z' → shows "Synced ..."
      expect(screen.getByText(/Synced/)).toBeInTheDocument();
    });
  });
});
