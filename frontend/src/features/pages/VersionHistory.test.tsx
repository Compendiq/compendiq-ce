import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LazyMotion, domAnimation } from 'framer-motion';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { VersionHistory } from './VersionHistory';
import { useAuthStore } from '../../stores/auth-store';

vi.mock('../../shared/hooks/use-settings', () => ({
  useSettings: () => ({
    data: { confluenceUrl: 'https://confluence.example.com' },
  }),
}));

function createWrapper(externalQueryClient?: QueryClient) {
  const queryClient = externalQueryClient ?? new QueryClient({
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

  it('empty-state copy describes lazy-on-open import, not sync (#763 regression)', async () => {
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
    // The stale post-#728 copy must be gone — backfill is lazy-on-open, syncing cannot help.
    expect(screen.queryByText(/saved during sync/i)).not.toBeInTheDocument();
    // The new copy explains the lazy import and the PAT requirement.
    expect(screen.getByText(/imported\s+from Confluence when this dialog opens/i)).toBeInTheDocument();
    expect(screen.getByText(/Confluence PAT/i)).toBeInTheDocument();
  });

  it('renders the error branch (with reason + retry) instead of the empty state on a failed request (#763)', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'Access denied to this space' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValue(mockVersionsResponse());

    render(
      <VersionHistory pageId="page-1" model="qwen3.5" />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByText('History'));

    await waitFor(() => {
      expect(screen.getByText('Failed to load version history.')).toBeInTheDocument();
    });
    // The backend reason is surfaced, and the error is NOT masked as "no data".
    expect(screen.getByText(/Access denied to this space \(HTTP 403\)/)).toBeInTheDocument();
    expect(screen.queryByText(/No version history available/)).not.toBeInTheDocument();

    // Retry refetches and renders the list.
    fireEvent.click(screen.getByText('Retry'));
    await waitFor(() => {
      expect(screen.getByText('v3')).toBeInTheDocument();
    });
    expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps the loaded list and shows an inline notice when a background refetch fails (#763 review follow-up)', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(mockVersionsResponse())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'upstream hiccup' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValue(mockVersionsResponse());

    render(
      <VersionHistory pageId="page-1" model="qwen3.5" />,
      { wrapper: createWrapper(queryClient) },
    );

    fireEvent.click(screen.getByText('History'));
    await waitFor(() => expect(screen.getByText('v3')).toBeInTheDocument());

    // Simulate a background refetch that fails — same path as the
    // invalidateQueries after a restore or a window-focus refetch.
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['pages', 'page-1', 'versions'], exact: true });
    });

    // The observer notifies asynchronously after refetchQueries resolves.
    await waitFor(() => {
      expect(screen.getByText(/Could not refresh version history/)).toBeInTheDocument();
    });
    // The loaded list survives; the full-panel error does NOT replace it.
    expect(screen.getByText('v3')).toBeInTheDocument();
    expect(screen.queryByText('Failed to load version history.')).not.toBeInTheDocument();

    // The inline Retry recovers and clears the notice.
    fireEvent.click(screen.getByText('Retry'));
    await waitFor(() => {
      expect(screen.queryByText(/Could not refresh version history/)).not.toBeInTheDocument();
    });
    expect(screen.getByText('v3')).toBeInTheDocument();
  });

  it('shows the no-credentials hint alongside the list when backfillStatus is skipped_no_credentials (#763)', async () => {
    const base = JSON.parse(await mockVersionsResponse().text());
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ ...base, backfillStatus: 'skipped_no_credentials' }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );

    render(
      <VersionHistory pageId="page-1" model="qwen3.5" />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByText('History'));

    await waitFor(() => {
      expect(screen.getByText('v3')).toBeInTheDocument();
    });
    // The list still renders, with a hint pointing the user at Settings → Confluence.
    expect(screen.getByText(/no Confluence credentials/i)).toBeInTheDocument();
    expect(screen.getByText(/Settings → Confluence/)).toBeInTheDocument();
  });

  it('prefers the server-provided backfillDetail and shows a failed-import hint (#763)', async () => {
    const base = JSON.parse(await mockVersionsResponse().text());
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          ...base,
          backfillStatus: 'failed',
          backfillDetail: 'Importing historical versions from Confluence failed — the list below may be incomplete.',
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );

    render(
      <VersionHistory pageId="page-1" model="qwen3.5" />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByText('History'));

    await waitFor(() => {
      expect(screen.getByText('v3')).toBeInTheDocument();
    });
    expect(screen.getByText(/may be incomplete/i)).toBeInTheDocument();
  });

  it('shows no backfill hint when backfillStatus is ok (#763)', async () => {
    const base = JSON.parse(await mockVersionsResponse().text());
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ ...base, backfillStatus: 'ok' }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );

    render(
      <VersionHistory pageId="page-1" model="qwen3.5" />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByText('History'));

    await waitFor(() => {
      expect(screen.getByText('v3')).toBeInTheDocument();
    });
    expect(screen.queryByText(/could not be imported/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/may be incomplete/i)).not.toBeInTheDocument();
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

  it('restores a version through the ConfirmDialog: POSTs to the restore endpoint with the current version guard', async () => {
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

    // ConfirmDialog replaces native confirm(). The copy must reflect the
    // backend reality (pages-versions.ts): Confluence-style non-destructive
    // restore — current content is replaced but stays in version history.
    expect(await screen.findByText('Restore v2?')).toBeInTheDocument();
    expect(screen.getByText(/saved as a new version/i)).toBeInTheDocument();
    expect(screen.getByText(/stays in version history/i)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));

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

  it('does not POST when the restore dialog is cancelled, and keeps the history dialog open', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockVersionsResponse());

    render(
      <VersionHistory pageId="page-1" model="qwen3.5" />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByText('History'));
    await waitFor(() => expect(screen.getByText('v2')).toBeInTheDocument());

    fireEvent.click(screen.getAllByTitle('Restore this version')[0]!);
    await screen.findByTestId('confirm-dialog');

    fireEvent.click(screen.getByTestId('confirm-dialog-cancel'));

    await waitFor(() => {
      expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
    });
    // The outer Version History dialog must survive the nested cancel.
    expect(screen.getByText('Version History')).toBeInTheDocument();

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

  it('text compare shows a change added in the newer version as an addition, not a deletion (#948)', async () => {
    // GET /pages/:id/versions returns versions newest-first, so at row i,
    // versions[i + 1] is the OLDER version. Comparing the newer (v3) against
    // the previous (v2) must color content that only exists in the newer
    // version as an ADDITION — the regression rendered it as a deletion.
    const detail = (versionNumber: number, bodyText: string) =>
      new Response(
        JSON.stringify({
          confluenceId: null,
          versionNumber,
          title: `Page v${versionNumber}`,
          bodyHtml: `<p>${bodyText}</p>`,
          bodyText,
          isCurrent: versionNumber === 3,
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );

    vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      // Version detail endpoints end in /versions/<number>.
      if (/\/versions\/3$/.test(url)) return Promise.resolve(detail(3, 'The happy cat'));
      if (/\/versions\/2$/.test(url)) return Promise.resolve(detail(2, 'The cat'));
      return Promise.resolve(mockVersionsResponse());
    });

    render(
      <VersionHistory pageId="page-1" model="qwen3.5" />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByText('History'));
    await waitFor(() => expect(screen.getByText('v3')).toBeInTheDocument());

    // First compare button = compare current (v3) with previous (v2).
    fireEvent.click(screen.getAllByTitle('Compare with previous version')[0]!);

    // Wait for the unified diff (both version details resolved).
    const unified = await screen.findByTestId('unified-diff');

    // "happy" only exists in the newer version → it is an addition.
    const addedSpan = within(unified).getByText((_, el) =>
      el?.tagName === 'SPAN' && (el.textContent ?? '').trim() === 'happy',
    );
    expect(addedSpan.className).toContain('text-success');
    expect(addedSpan.className).not.toContain('line-through');

    // Purely additive change: additions > 0, deletions == 0. The inverted bug
    // reported the opposite (+0 / -N).
    expect(screen.getByText('-0')).toBeInTheDocument();
    expect(screen.queryByText('+0')).not.toBeInTheDocument();
  });

  it('exposes an accessible name on the comparison close button (#939)', async () => {
    const detail = (versionNumber: number, bodyText: string) =>
      new Response(
        JSON.stringify({
          confluenceId: null,
          versionNumber,
          title: `Page v${versionNumber}`,
          bodyHtml: `<p>${bodyText}</p>`,
          bodyText,
          isCurrent: versionNumber === 3,
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );

    vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (/\/versions\/3$/.test(url)) return Promise.resolve(detail(3, 'The happy cat'));
      if (/\/versions\/2$/.test(url)) return Promise.resolve(detail(2, 'The cat'));
      return Promise.resolve(mockVersionsResponse());
    });

    render(
      <VersionHistory pageId="page-1" model="qwen3.5" />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByText('History'));
    await waitFor(() => expect(screen.getByText('v3')).toBeInTheDocument());

    fireEvent.click(screen.getAllByTitle('Compare with previous version')[0]!);
    await screen.findByTestId('unified-diff');

    expect(screen.getByRole('button', { name: 'Close comparison' })).toBeInTheDocument();
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

  it('applies enlarged modal styling classes (#1404)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockVersionsResponse());

    render(
      <VersionHistory pageId="page-1" model="qwen3.5" />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByText('History'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.className).toContain('max-w-5xl');
    expect(dialog.className).toContain('max-h-[90vh]');
    expect(dialog.className).toContain('w-[96vw]');
    expect(dialog.className).toContain('sm:w-[92vw]');
  });

  it('renders formatted rich document preview using ArticleViewer by default (#1404)', async () => {
    const detailV2 = new Response(
      JSON.stringify({
        confluenceId: 'conf-123',
        versionNumber: 2,
        title: 'Page v2',
        bodyHtml: '<h2>System Architecture</h2><p>Overview of the <strong>services</strong>.</p>',
        bodyText: 'System Architecture\nOverview of the services.',
        author: 'alice',
        message: 'Updated architecture',
        isCurrent: false,
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );

    vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/versions/2')) return Promise.resolve(detailV2);
      return Promise.resolve(mockVersionsResponse());
    });

    render(
      <VersionHistory pageId="page-1" model="qwen3.5" />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByText('History'));
    await waitFor(() => expect(screen.getByText('v2')).toBeInTheDocument());

    // Click preview button on v2
    const previewButtons = screen.getAllByTitle('Preview version');
    fireEvent.click(previewButtons[1]!); // row for v2

    await waitFor(() => {
      expect(screen.getByText('Version 2 Preview')).toBeInTheDocument();
      expect(screen.getByText('by alice')).toBeInTheDocument();
      expect(screen.getByText('“Updated architecture”')).toBeInTheDocument();
    });

    // Formatted toggle button should be pressed by default
    const formattedBtn = screen.getByRole('button', { name: /formatted/i });
    expect(formattedBtn).toHaveAttribute('aria-pressed', 'true');
    expect(formattedBtn.className).toContain('text-action');

    // Content rendered inside ArticleViewer (heading and bold text)
    expect(await screen.findByRole('heading', { level: 2, name: /system architecture/i })).toBeInTheDocument();
    expect(screen.getByText('services')).toBeInTheDocument();
  });

  it('toggles between Formatted view and Raw Text view (#1404)', async () => {
    const detailV2 = new Response(
      JSON.stringify({
        confluenceId: 'conf-123',
        versionNumber: 2,
        title: 'Page v2',
        bodyHtml: '<h3>Database Schema</h3><p>PostgreSQL 16 with pgvector.</p>',
        bodyText: 'Database Schema\nPostgreSQL 16 with pgvector.',
        author: 'alice',
        isCurrent: false,
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );

    vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/versions/2')) return Promise.resolve(detailV2);
      return Promise.resolve(mockVersionsResponse());
    });

    render(
      <VersionHistory pageId="page-1" model="qwen3.5" />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByText('History'));
    await waitFor(() => expect(screen.getByText('v2')).toBeInTheDocument());

    fireEvent.click(screen.getAllByTitle('Preview version')[1]!);
    await screen.findByRole('heading', { level: 3, name: /database schema/i });

    // Switch to Raw Text view
    const rawTextBtn = screen.getByRole('button', { name: /raw text/i });
    fireEvent.click(rawTextBtn);

    expect(rawTextBtn).toHaveAttribute('aria-pressed', 'true');
    const formattedBtn = screen.getByRole('button', { name: /formatted/i });
    expect(formattedBtn).toHaveAttribute('aria-pressed', 'false');

    // In Raw Text view, <pre> is rendered
    expect(screen.getByText(/PostgreSQL 16 with pgvector/)).toBeInTheDocument();

    // Switch back to Formatted view
    fireEvent.click(formattedBtn);
    expect(formattedBtn).toHaveAttribute('aria-pressed', 'true');
    expect(await screen.findByRole('heading', { level: 3, name: /database schema/i })).toBeInTheDocument();
  });

  it('falls back gracefully to plain text when bodyHtml is null (#1404)', async () => {
    const detailV1 = new Response(
      JSON.stringify({
        confluenceId: null,
        versionNumber: 1,
        title: 'Page v1',
        bodyHtml: null,
        bodyText: 'Plain text historical body without HTML.',
        isCurrent: false,
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );

    vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/versions/1')) return Promise.resolve(detailV1);
      return Promise.resolve(mockVersionsResponse());
    });

    render(
      <VersionHistory pageId="page-1" model="qwen3.5" />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByText('History'));
    await waitFor(() => expect(screen.getByText('v1')).toBeInTheDocument());

    fireEvent.click(screen.getAllByTitle('Preview version')[2]!);

    await waitFor(() => {
      expect(screen.getByText('Version 1 Preview')).toBeInTheDocument();
      expect(screen.getByText(/Plain text historical body without HTML\./)).toBeInTheDocument();
    });
  });

  it('shows fallback message when both bodyHtml and bodyText are null (#1404)', async () => {
    const detailV1 = new Response(
      JSON.stringify({
        confluenceId: null,
        versionNumber: 1,
        title: 'Page v1',
        bodyHtml: null,
        bodyText: null,
        isCurrent: false,
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );

    vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/versions/1')) return Promise.resolve(detailV1);
      return Promise.resolve(mockVersionsResponse());
    });

    render(
      <VersionHistory pageId="page-1" model="qwen3.5" />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByText('History'));
    await waitFor(() => expect(screen.getByText('v1')).toBeInTheDocument());

    fireEvent.click(screen.getAllByTitle('Preview version')[2]!);

    // In raw mode or empty fallback
    const rawBtn = await screen.findByRole('button', { name: /raw text/i });
    fireEvent.click(rawBtn);
    expect(screen.getByText('No content available')).toBeInTheDocument();
  });

  it('shows loading spinner while historical version detail is loading (#1404)', async () => {
    let resolveDetail: (res: Response) => void;
    const detailPromise = new Promise<Response>((resolve) => {
      resolveDetail = resolve;
    });

    vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/versions/2')) return detailPromise;
      return Promise.resolve(mockVersionsResponse());
    });

    render(
      <VersionHistory pageId="page-1" model="qwen3.5" />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByText('History'));
    await waitFor(() => expect(screen.getByText('v2')).toBeInTheDocument());

    fireEvent.click(screen.getAllByTitle('Preview version')[1]!);

    // Spinner should appear while loading
    expect(await screen.findByText('Loading version preview...')).toBeInTheDocument();

    // Now resolve detail
    act(() => {
      resolveDetail!(
        new Response(
          JSON.stringify({
            confluenceId: null,
            versionNumber: 2,
            title: 'Page v2',
            bodyHtml: '<p>Loaded content</p>',
            bodyText: 'Loaded content',
            isCurrent: false,
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
      );
    });

    await waitFor(() => {
      expect(screen.queryByText('Loading version preview...')).not.toBeInTheDocument();
      expect(screen.getByText('Version 2 Preview')).toBeInTheDocument();
    });
  });

  it('allows restoring a version directly from the preview header (#1404)', async () => {
    const detailV2 = new Response(
      JSON.stringify({
        confluenceId: null,
        versionNumber: 2,
        title: 'Page v2',
        bodyHtml: '<p>V2 body</p>',
        bodyText: 'V2 body',
        isCurrent: false,
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );

    vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/versions/2/restore')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: 1,
              title: 'Page v2',
              version: 4,
              restoredFrom: 2,
              source: 'local',
              pushedToConfluence: false,
            }),
            { headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      if (url.includes('/versions/2')) return Promise.resolve(detailV2);
      return Promise.resolve(mockVersionsResponse());
    });

    render(
      <VersionHistory pageId="page-1" model="qwen3.5" />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByText('History'));
    await waitFor(() => expect(screen.getByText('v2')).toBeInTheDocument());

    fireEvent.click(screen.getAllByTitle('Preview version')[1]!);
    await screen.findByText('Version 2 Preview');

    // Click "Restore this version" inside the preview header
    const restoreInPreview = screen.getByText('Restore this version');
    fireEvent.click(restoreInPreview);

    // ConfirmDialog opens
    expect(await screen.findByText('Restore v2?')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));

    await waitFor(() => {
      expect(screen.queryByText('Version 2 Preview')).not.toBeInTheDocument();
    });
  });

  it('compacts timeline list when a preview is active (#1404)', async () => {
    const detailV2 = new Response(
      JSON.stringify({
        confluenceId: null,
        versionNumber: 2,
        title: 'Page v2',
        bodyHtml: '<p>V2 body</p>',
        bodyText: 'V2 body',
        isCurrent: false,
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );

    vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/versions/2')) return Promise.resolve(detailV2);
      return Promise.resolve(mockVersionsResponse());
    });

    render(
      <VersionHistory pageId="page-1" model="qwen3.5" />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByText('History'));
    await waitFor(() => expect(screen.getByText('v2')).toBeInTheDocument());

    expect(document.querySelector('.max-h-72')).toBeInTheDocument();

    // Select version 2 to preview
    fireEvent.click(screen.getAllByTitle('Preview version')[1]!);
    await screen.findByText('Version 2 Preview');

    // Timeline should now have max-h-48 class
    expect(document.querySelector('.max-h-48')).toBeInTheDocument();
    expect(document.querySelector('.max-h-72')).not.toBeInTheDocument();
  });
});
